"""前瞻行情：d0 之后的 30 个交易日的涨幅、停牌顺延、对照组抽样。

三条口径（都是用户 2026-10-22 定的）
----------------------------------
1. **涨幅基准 = d0 收盘价**：第 N 天涨幅 = 第 N 天收盘 / d0 收盘 − 1。
2. **后复权**：``close_adj = close × adj_factor``。用不复权价统计会把送股/拆股当天
   的「价格腰斩」记成暴跌，概率被系统性低估。
   但 Excel 里的「d0 价格」列仍然给**真实收盘价**（用户看图用的是这个）。
3. **停牌顺延**：第 5–10 天停牌，第 5–10 天的涨幅都等于第 4 天的涨幅（拿停牌前最后
   一个有效价撑住），不是跳过、也不是记 0。

"t" 列（触及口径）
-----------------
``t5`` = 「5 天内最高价相对 d0 收盘的最大涨幅」。收盘口径（r）回答「持有到第 N 天
赚没赚」，触及口径回答「N 天内有没有机会」。两者差得远说明是「冲高回落」。

数据不足的处理
-------------
- 卖盘停牌（库里没有那一行，或 ``close/adj_factor`` 为 0）→ 顺延，不算缺数据；
- 30 个交易日**日历本身不够**（d0 离最新交易日太近）→ 该列留 NULL，统计时按
  「该周期样本数」单独计数，不拿 0 冒充；
- 整段前瞻一根有效 K 线都没有（退市）→ 全部 NULL（``avail=0``），统计排除。
"""

from __future__ import annotations

import datetime as _dt
import logging
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from .models import FORWARD_DAYS, HORIZONS

logger = logging.getLogger(__name__)

#: 表名常量（与 ``fork_screen.repository._BARS_TABLE`` 同一个表：近期表只有 59 天）
_BARS_TABLE = "stock_daily"


def board_of(code: str) -> str:
    """代码 → 市场（与 ``fork_market._MARKET_BOARD_CASE`` 同一套纯前缀规则）。"""
    code = (code or "").strip()
    if code[:3] in ("688", "689"):
        return "kcb"
    if code[:3] in ("300", "301"):
        return "cyb"
    if code[:2] == "60":
        return "sh"
    if code[:2] == "00" or code[:3] == "302":
        return "sz"
    return "other"


#: 市场 → SQL 片段（对照组与条件组用同一套板块定义）
_MARKET_SQL = {
    "sh": "LEFT(i.code, 2) = '60'",
    "sz": "(LEFT(i.code, 2) = '00' OR LEFT(i.code, 3) = '302')",
    "cyb": "LEFT(i.code, 3) IN ('300', '301')",
    "kcb": "LEFT(i.code, 3) IN ('688', '689')",
}


@dataclass
class ForwardResult:
    """一只股票的前瞻结果。"""

    d0_close: float
    d0_adj: float
    #: 30 个值；日历不够时为 None（尾部）
    returns: list[Optional[float]] = field(default_factory=list)
    #: 与 ``HORIZONS`` 对齐的触及涨幅（最高价口径）
    touches: list[Optional[float]] = field(default_factory=list)
    #: 30 个前瞻日里**真有行情**的天数（顺延出来的不算）
    avail: int = 0


def build_forward(
    bars: list[tuple[_dt.date, float, float, float]],
    forward_dates: list[_dt.date],
) -> Optional[ForwardResult]:
    """纯计算：``bars`` = ``[(date, close, close_adj, high_adj), …]`` 升序、首根是 d0。

    ``forward_dates`` 是 d0 之后的交易日（最多 30 个，由交易日历给出）。
    停牌日（当天没有 bar）按前一有效收盘顺延。
    """
    if not bars:
        return None
    _d0_date, d0_close, d0_adj, _d0_high = bars[0]
    if not d0_adj or d0_adj <= 0:
        return None

    closes = {row[0]: row[2] for row in bars[1:] if row[2] and row[2] > 0}
    highs = {row[0]: row[3] for row in bars[1:] if row[3] and row[3] > 0}

    returns: list[Optional[float]] = []
    tops: list[float] = []
    avail = 0
    last = d0_adj
    for day in forward_dates[:FORWARD_DAYS]:
        close = closes.get(day)
        if close is not None:
            last = close
            avail += 1
        high = highs.get(day)
        if high is None or high < last:
            # 停牌顺延：当天没行情时，「最高价」也只能是撑住的收盘价
            high = last
        returns.append(round(last / d0_adj - 1.0, 6))
        tops.append(high)

    if avail == 0:
        # 一根有效 K 线都没有（退市/长期停牌）：不给 0% 冒充「不涨不跌」
        return ForwardResult(d0_close=d0_close, d0_adj=d0_adj,
                             returns=[None] * len(returns),
                             touches=[None] * len(HORIZONS), avail=0)

    if len(returns) < FORWARD_DAYS:
        returns.extend([None] * (FORWARD_DAYS - len(returns)))

    touches: list[Optional[float]] = []
    for horizon in HORIZONS:
        window = tops[:horizon]
        if len(window) < horizon:
            touches.append(None)
            continue
        touches.append(round(max(window) / d0_adj - 1.0, 6))

    return ForwardResult(d0_close=d0_close, d0_adj=d0_adj,
                         returns=returns, touches=touches, avail=avail)


def trading_calendar(conn: Any, start: _dt.date, end: Optional[_dt.date] = None) -> list[_dt.date]:
    """交易日历（升序）。只查一次，整个任务共用 —— 每天 5500 行 DISTINCT 太贵。"""
    sql = (
        f"SELECT DISTINCT trade_date FROM {_BARS_TABLE} "
        "WHERE trade_date >= %(start)s AND trade_date <= %(end)s ORDER BY trade_date"
    )
    with conn.cursor() as cursor:
        cursor.execute(sql, {"start": start, "end": end or _dt.date(2999, 1, 1)})
        rows = cursor.fetchall() or []
    days = []
    for row in rows:
        value = row.get("trade_date") if isinstance(row, dict) else row[0]
        if isinstance(value, _dt.datetime):
            value = value.date()
        elif not isinstance(value, _dt.date):
            value = _dt.date.fromisoformat(str(value)[:10])
        days.append(value)
    return days


def latest_trade_date(conn: Any) -> Optional[_dt.date]:
    with conn.cursor() as cursor:
        cursor.execute(f"SELECT MAX(trade_date) AS asof FROM {_BARS_TABLE}")
        row = cursor.fetchone() or {}
    value = row.get("asof") if isinstance(row, dict) else None
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value)[:10])


def _tuple_cursor(conn: Any) -> Any:
    """流式 tuple cursor：5000 只 × 31 行，用 DictCursor 会白占一倍内存。"""
    from pymysql.cursors import SSCursor

    return conn.cursor(SSCursor)


def fetch_bars(
    conn: Any,
    d0: _dt.date,
    symbols: Iterable[str],
    last_day: _dt.date,
) -> dict[str, list[tuple[_dt.date, float, float, float]]]:
    """取 d0 与之后最多 30 个交易日的日线（含 d0 那根，作为基准）。"""
    wanted = tuple(str(symbol) for symbol in symbols)
    if not wanted:
        return {}
    sql = (
        f"SELECT symbol, trade_date, close, high, adj_factor FROM {_BARS_TABLE} "
        "WHERE symbol IN %(symbols)s AND trade_date >= %(start)s AND trade_date <= %(end)s "
        "ORDER BY symbol, trade_date"
    )
    buckets: dict[str, list[tuple[_dt.date, float, float, float]]] = {}
    with _tuple_cursor(conn) as cursor:
        cursor.execute(sql, {"symbols": wanted, "start": d0, "end": last_day})
        while True:
            batch = cursor.fetchmany(5000)
            if not batch:
                break
            for symbol, day, close, high, factor in batch:
                rows = buckets.setdefault(str(symbol), [])
                if len(rows) > FORWARD_DAYS:
                    continue
                if isinstance(day, _dt.datetime):
                    day = day.date()
                if not isinstance(day, _dt.date):
                    day = _dt.date.fromisoformat(str(day)[:10])
                fq = float(factor) if factor and float(factor) > 0 else 1.0
                close_value = float(close) if close is not None else 0.0
                high_value = float(high) if high is not None else 0.0
                if close_value <= 0:
                    # 停牌行：不进序列，交给 build_forward 顺延
                    continue
                rows.append((
                    day,
                    round(close_value, 4),
                    round(close_value * fq, 6),
                    round(max(high_value, close_value) * fq, 6),
                ))
    return buckets


def control_sample(
    conn: Any,
    d0: _dt.date,
    limit: int,
    markets: Iterable[str],
    include_st: bool,
) -> list[dict[str, Any]]:
    """对照组：当天同市场里随机 ``limit`` 只（用同样的算法算涨幅）。

    「随便买一只、随便哪一天」的基准率是判断条件有没有用的**唯一**依据：
    全市场任意 30 天的上涨概率本来就在 50% 附近，条件算出 55% 其实等于没用。
    """
    if limit <= 0:
        return []
    clauses = [_MARKET_SQL[key] for key in markets if key in _MARKET_SQL]
    market_sql = f" AND ({' OR '.join(clauses)})" if clauses else ""
    sql = f"""
SELECT i.code, i.symbol, i.name, d.close
FROM {_BARS_TABLE} d
JOIN stock_info i ON i.symbol = d.symbol
WHERE d.trade_date = %(d0)s
  AND d.close > 0 AND d.adj_factor > 0
  AND i.status = 'listed'
  AND (%(include_st)s = 1 OR LOCATE('ST', UPPER(REPLACE(i.name, ' ', ''))) = 0){market_sql}
ORDER BY RAND()
LIMIT %(limit)s
"""
    with conn.cursor() as cursor:
        cursor.execute(sql, {
            "d0": d0,
            "include_st": 1 if include_st else 0,
            "limit": int(limit),
        })
        rows = cursor.fetchall() or []
    return [
        {
            "code": str(row.get("code") or ""),
            "symbol": str(row.get("symbol") or ""),
            "name": str(row.get("name") or ""),
            "close": float(row.get("close") or 0.0),
        }
        for row in rows
        if row.get("symbol")
    ]
