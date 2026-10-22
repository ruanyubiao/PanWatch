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


def has_industry(conn: Any) -> bool:
    """``stock_info.industry`` 是否存在（行业同步上线前，老库还没有这一列）。"""
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) AS n FROM information_schema.columns "
                "WHERE table_schema = DATABASE() AND table_name = 'stock_info' "
                "AND column_name = 'industry'"
            )
            row = cursor.fetchone() or {}
    except Exception:  # noqa: BLE001 - 查不到就当没有，行业一栏留空
        return False
    return int((row.get("n") if isinstance(row, dict) else 0) or 0) > 0


def fetch_snapshots(conn: Any, d0: _dt.date, codes: Iterable[str]) -> dict[str, dict[str, Any]]:
    """信号当天的横截面（供「按变量分类」用）。

    一次查完当天所有命中的股票：市值/PE/PB/换手/成交额/振幅都在 d0 那根 K 线上，
    行业与上市日在 ``stock_info`` 上。行业列不存在时留空（不报错），这样功能
    不需要等数据同步也能跑。
    """
    wanted = tuple(sorted({str(code) for code in codes if code}))
    if not wanted:
        return {}
    industry_sql = (
        "i.industry AS industry, i.industry_l1 AS industry_l1, "
        if has_industry(conn) else "NULL AS industry, NULL AS industry_l1, "
    )
    sql = f"""
SELECT d.code AS code, d.total_market_cap AS mcap, d.pe_ttm AS pe, d.pb AS pb,
       d.turnover_rate AS turnover, d.amount AS amount, d.amplitude AS amplitude,
       {industry_sql} i.list_date AS list_date
FROM {_BARS_TABLE} d
LEFT JOIN stock_info i ON i.symbol = d.symbol
WHERE d.trade_date = %(d0)s AND d.code IN %(codes)s
"""
    with conn.cursor() as cursor:
        cursor.execute(sql, {"d0": d0, "codes": wanted})
        rows = cursor.fetchall() or []
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        code = str(row.get("code") or "")
        if not code:
            continue
        list_date = row.get("list_date")
        listed_days = None
        if isinstance(list_date, _dt.datetime):
            list_date = list_date.date()
        if isinstance(list_date, _dt.date):
            listed_days = max(0, (d0 - list_date).days)
        mcap = row.get("mcap")
        amount = row.get("amount")
        out[code] = {
            "industry": (str(row.get("industry") or "").strip() or None),
            "industry_l1": (str(row.get("industry_l1") or "").strip() or None),
            "mcap": round(float(mcap) / 1e8, 2) if mcap is not None else None,
            "pe": float(row["pe"]) if row.get("pe") is not None else None,
            "pb": float(row["pb"]) if row.get("pb") is not None else None,
            "turnover": float(row["turnover"]) if row.get("turnover") is not None else None,
            "amount": round(float(amount) / 1e8, 3) if amount is not None else None,
            "amplitude": float(row["amplitude"]) if row.get("amplitude") is not None else None,
            "listed_days": listed_days,
        }
    return out


def market_breadth(conn: Any, d0: _dt.date) -> Optional[float]:
    """当天「阳线占比」= 收盘 > 开盘的股票比例（0–1），当作大盘环境。

    为什么不用「上涨家数占比」：真 ``pre_close`` 从 2026-09-24 起才可靠，2020–2026
    的历史会被算成 NULL，这个维度就废了。阳线占比每根 K 线自带，七年一致。
    """
    sql = (
        f"SELECT AVG(CASE WHEN close > open THEN 1.0 ELSE 0.0 END) AS breadth "
        f"FROM {_BARS_TABLE} WHERE trade_date = %(d0)s AND traded = 1 AND open > 0 AND close > 0"
    )
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, {"d0": d0})
            row = cursor.fetchone() or {}
    except Exception:  # noqa: BLE001 - 环境维度算不出来不该毁掉任务
        logger.exception("计算 %s 的大盘环境失败", d0)
        return None
    value = row.get("breadth") if isinstance(row, dict) else None
    return round(float(value), 4) if value is not None else None


def shift_back(conn: Any, latest: _dt.date, days: int) -> _dt.date:
    """从 ``latest`` 往前数 ``days`` 个交易日（含 latest 为第 0 个）。

    用来算「结束日期上限」：结束日不能晚于这个日期，否则最后几天没有足够的
    前瞻行情来验证（用户 2026-10-22 第 2 条）。库里的交易日不够时返回最早的一天。
    """
    sql = (
        f"SELECT DISTINCT trade_date FROM {_BARS_TABLE} "
        "WHERE trade_date <= %(latest)s ORDER BY trade_date DESC LIMIT 1 OFFSET %(offset)s"
    )
    with conn.cursor() as cursor:
        cursor.execute(sql, {"latest": latest, "offset": max(1, int(days))})
        row = cursor.fetchone() or {}
    value = row.get("trade_date") if isinstance(row, dict) else None
    if value is None:
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT MIN(trade_date) AS first FROM {_BARS_TABLE}")
            row = cursor.fetchone() or {}
        value = row.get("first") if isinstance(row, dict) else None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value)[:10])


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
