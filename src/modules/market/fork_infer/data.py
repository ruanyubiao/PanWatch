"""一次把「搜索要用到的行情」读进内存（分小块读，不一次扫全表）。

为什么要预读
------------
条件推理要跑一百个变体 × 一两百个交易日。每次变体都去 MySQL 重新取数，
一个变体就是几分钟，一百个变体一整天都跑不完。所以这里把区间内的日线**读一次**，
之后所有变体都在内存里算。

为什么分块
----------
一条 ``SELECT ... FROM stock_daily WHERE trade_date BETWEEN ...`` 扫四五百万行会
把 4G 的机器压垮（2026-10-24 实测：单条大查询把机器压到 sshd 都 fork 不出来）。
改成按 symbol 分块（每块 80 只，走 ``uk_symbol_date`` 索引），单块 6 万行左右，
峰值内存和查询耗时都可控。块与块之间检查停止标记，任务能随时停下。

内存口径
--------
每行约 44 字节：日期 int32 + 后复权收盘 float64 + 开/高/昨收 float32 +
量/额/换手/市值 float32。全市场 750 个交易日约 4.2M 行 ≈ 185MB。这也是本模块
不做「无限区间」的原因：日期填错跑到 2010 年会把内存吃光。
"""

from __future__ import annotations

import bisect
import datetime as _dt
import logging
from array import array
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional, Sequence

logger = logging.getLogger(__name__)

#: 每块读多少只股票
CHUNK = 80


@dataclass
class StockData:
    """一只股票在区间内的日线（列式存储，按自己的下标对齐）。"""

    symbol: str
    code: str = ""
    name: str = ""
    board: str = ""
    is_st: bool = False
    #: 每根 K 线对应的**全局日历下标**（升序）
    dates: "array" = field(default_factory=lambda: array("i"))
    open: "array" = field(default_factory=lambda: array("f"))
    close: "array" = field(default_factory=lambda: array("f"))
    high: "array" = field(default_factory=lambda: array("f"))
    pre_close: "array" = field(default_factory=lambda: array("f"))
    #: 后复权收盘（close × adj_factor）—— 涨幅、均线都只看它
    c_adj: "array" = field(default_factory=lambda: array("d"))
    #: 后复权开盘 / 最高（次日开盘买入、窗口内最高价都要用它）
    open_adj: "array" = field(default_factory=lambda: array("f"))
    high_adj: "array" = field(default_factory=lambda: array("f"))
    volume: "array" = field(default_factory=lambda: array("f"))
    amount: "array" = field(default_factory=lambda: array("f"))
    turnover: "array" = field(default_factory=lambda: array("f"))
    mcap: "array" = field(default_factory=lambda: array("f"))

    def __len__(self) -> int:
        return len(self.dates)

    def position(self, day_index: int) -> Optional[int]:
        """全局日历下标 → 本股数组下标（该日没有 K 线时 None）。"""
        pos = bisect.bisect_left(self.dates, day_index)
        if pos < len(self.dates) and self.dates[pos] == day_index:
            return pos
        return None

    def last_at_or_before(self, day_index: int) -> Optional[int]:
        """全局日历下标 → 「≤ 该日的最后一根」的下标（停牌顺延用）。"""
        pos = bisect.bisect_right(self.dates, day_index) - 1
        return pos if pos >= 0 else None


@dataclass
class Dataset:
    """一次任务的全部行情。"""

    calendar: list[_dt.date]
    cal_index: dict[_dt.date, int]
    stocks: dict[str, StockData]
    version: dict[str, Any] = field(default_factory=dict)

    def day_index(self, day: _dt.date) -> Optional[int]:
        return self.cal_index.get(day)

    def calendar_window(self, day_index: int, length: int) -> list[_dt.date]:
        """``D[1..K]``（下标 0 = 当天，与 ``EvalContext.calendar`` 一致）。"""
        start = max(0, day_index - length + 1)
        return self.calendar[start: day_index + 1][::-1]


def _as_date(value: Any) -> Optional[_dt.date]:
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value)[:10])


def load_calendar(conn: Any, start: _dt.date, end: _dt.date) -> list[_dt.date]:
    """区间的交易日历（``stock_daily`` 里出现过的日期，升序）。"""
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT DISTINCT trade_date FROM stock_daily "
            "WHERE trade_date BETWEEN %s AND %s ORDER BY trade_date",
            (start, end),
        )
        return [day for day in (_as_date(row["trade_date"]) for row in cursor.fetchall() or [])
                if day is not None]


def load_universe(conn: Any, markets: Sequence[str], include_st: bool) -> list[dict[str, Any]]:
    """候选池：与条件选股的候选 SQL 同一套口径（上市中 + 市场 + ST）。"""
    marks = ", ".join(["%s"] * len(markets))
    sql = f"""
        SELECT symbol, code, name
        FROM stock_info
        WHERE status = 'listed'
          AND (CASE
                 WHEN code LIKE '688%%' OR code LIKE '689%%' THEN 'kcb'
                 WHEN code LIKE '300%%' OR code LIKE '301%%' OR code LIKE '302%%' THEN 'cyb'
                 WHEN code LIKE '60%%' THEN 'sh'
                 WHEN code LIKE '00%%' THEN 'sz'
                 ELSE 'other' END) IN ({marks})
        ORDER BY symbol
    """
    with conn.cursor() as cursor:
        cursor.execute(sql, tuple(markets))
        rows = list(cursor.fetchall() or [])
    universe: list[dict[str, Any]] = []
    for row in rows:
        code = str(row.get("code") or "")
        name = str(row.get("name") or "")
        board = ("kcb" if code[:3] in ("688", "689") else
                 "cyb" if code[:3] in ("300", "301", "302") else
                 "sh" if code[:2] == "60" else
                 "sz" if code[:2] == "00" else "other")
        # ST 判定沿用管道口径：名字里带 ST 就算 ST（与 fork_market._IS_ST_CASE 等价）
        is_st = "ST" in name.upper()
        if is_st and not include_st:
            continue
        universe.append({"symbol": str(row["symbol"]), "code": code, "name": name,
                         "board": board, "is_st": is_st})
    return universe


def load_dataset(
    conn: Any,
    universe: Sequence[dict[str, Any]],
    calendar: list[_dt.date],
    *,
    progress: Optional[Callable[[int, int], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> Dataset:
    """读 ``calendar`` 区间内这些股票的日线。``progress(done, total)`` / ``should_stop()`` 可选。

    ``universe`` 是 :func:`load_universe` 的行；代码 / 名称 / 板块要挂在 ``StockData``
    上 —— 求值器算「涨停买不进」要看板块（20% 还是 10%），身份类条件要看代码名称。
    """
    info = {str(row["symbol"]): row for row in universe}
    want = [str(row["symbol"]) for row in universe]
    cal_index = {day: position for position, day in enumerate(calendar)}
    first, last = (calendar[0], calendar[-1]) if calendar else (None, None)
    stocks: dict[str, StockData] = {}
    total = max(1, len(want))
    rows = 0

    for offset in range(0, len(want), CHUNK):
        if should_stop is not None and should_stop():
            raise InterruptedError("加载行情被停止")
        chunk = want[offset: offset + CHUNK]
        marks = ", ".join(["%s"] * len(chunk))
        sql = f"""
            SELECT symbol, trade_date, open, close, pre_close, high, adj_factor,
                   volume, amount, turnover_rate, total_market_cap
            FROM stock_daily
            WHERE symbol IN ({marks}) AND trade_date BETWEEN %s AND %s
            ORDER BY symbol, trade_date
        """
        with conn.cursor() as cursor:
            cursor.execute(sql, tuple(chunk) + (first, last))
            batch = list(cursor.fetchall() or [])
        rows += len(batch)
        for row in batch:
            day = _as_date(row.get("trade_date"))
            open_raw = row.get("open")
            close_raw = row.get("close")
            if day is None or open_raw is None or close_raw is None:
                continue
            try:
                open_f = float(open_raw)
                close_f = float(close_raw)
            except (TypeError, ValueError):
                continue
            # 停牌日（开/收为 0 或空）不进序列：与 build_series 的丢弃规则一致
            if open_f <= 0 or close_f <= 0:
                continue
            day_index = cal_index.get(day)
            if day_index is None:
                continue
            symbol = str(row["symbol"])
            stock = stocks.get(symbol)
            if stock is None:
                meta = info.get(symbol) or {}
                stock = StockData(
                    symbol=symbol,
                    code=str(meta.get("code") or ""),
                    name=str(meta.get("name") or ""),
                    board=str(meta.get("board") or ""),
                    is_st=bool(meta.get("is_st")),
                )
                stocks[symbol] = stock
            factor = row.get("adj_factor")
            try:
                factor_f = float(factor) if factor is not None else 0.0
            except (TypeError, ValueError):
                factor_f = 0.0
            if factor_f <= 0:
                # 缺复权因子沿用「按 1.0 处理」的既有口径（与 build_series 一致）；
                # 该行由数据体检标出来，不在取数层偷偷丢掉。
                factor_f = 1.0
            high_raw = row.get("high")
            pre_raw = row.get("pre_close")
            stock.dates.append(day_index)
            stock.open.append(open_f)
            stock.close.append(close_f)
            stock.high.append(float(high_raw) if high_raw is not None else close_f)
            stock.pre_close.append(float(pre_raw) if pre_raw is not None else 0.0)
            stock.c_adj.append(close_f * factor_f)
            stock.open_adj.append(open_f * factor_f)
            stock.high_adj.append((float(high_raw) if high_raw is not None else close_f) * factor_f)
            stock.volume.append(float(row.get("volume") or 0.0))
            # 成交额 / 总市值保持**原始单位（元）**：条件层自己会除以 1e8 换成亿元，
            # 这里提前换算会变成双重换算（实测过一次，所有成交额条件都失效）。
            stock.amount.append(float(row.get("amount") or 0.0))
            stock.turnover.append(float(row.get("turnover_rate") or 0.0))
            stock.mcap.append(float(row.get("total_market_cap") or 0.0))
        if progress is not None:
            progress(min(total, offset + CHUNK), total)

    return Dataset(calendar=calendar, cal_index=cal_index, stocks=stocks,
                   version={"rows": rows, "stocks": len(stocks), "days": len(calendar),
                            "start": calendar[0].isoformat() if calendar else None,
                            "end": calendar[-1].isoformat() if calendar else None})
