"""条件选股的取数层（规格 §8.3 的 ①②③）。

三条 SQL 在**同一条连接**上顺序执行，绝不逐只股票查询：

① 候选（复用 ``fork_market._WITH_UNI``，在 MySQL 里先按市场 / ST / 总市值缩小范围）
② 交易日历（``D[1..K]``，倒序）
③ 候选股的日线（只查 ① 里出现的 symbol）

为什么读 ``stock_daily`` 而不是 ``stock_daily_recent``
----------------------------------------------------
需求规格的 Q1 留了兜底：近期表缺列或保留天数不足就改读全量表。实测（云端
2026-10-19）``stock_daily_recent`` 只保留 **59 个交易日**（2026-07-21 起），
而本功能允许 ``trading_days`` 到 250、均线到 MA250 —— 需要 ≥ 251 根。两张表
的列与索引完全相同（都有 ``uk_symbol_date(symbol, trade_date)``），所以这里
用一个常量切表，默认读全量表。将来管道把近期表的保留窗口提到 ≥ 251 天，
只改 ``_BARS_TABLE`` 一行即可。
"""

from __future__ import annotations

import datetime as _dt
import logging
from dataclasses import dataclass, field
from typing import Any

from ..api import fork_market
from .conditions import StockSeries
from .evaluator import build_series
from .models import ScreenRequest

logger = logging.getLogger(__name__)

#: 读日线的表。见模块 docstring：近期表只有 59 个交易日，不够 MA250 / W=250。
_BARS_TABLE = "stock_daily"

_YI = 100_000_000.0

# ① 候选：列与 ``market-table`` 的 ``_PAGE_SELECT`` 完全一致（``map_row`` 直接可用），
# WHERE 用的是 CTE 里新增的两列 market_board / is_st。
_CANDIDATE_SQL = (
    fork_market._WITH_UNI
    + fork_market._PAGE_SELECT
    + """
WHERE market_board IN %(markets)s
  AND (%(include_st)s = 1 OR is_st = 0)
  AND COALESCE(total_market_cap, info_market_cap) > %(cap_min)s
  AND COALESCE(total_market_cap, info_market_cap) < %(cap_max)s
ORDER BY code"""
)

# ② 交易日历：D[1] 必须等于 asof（否则行情表没更新到最新交易日）。
#    **带下界**：只回看 ``k*2 + 30`` 个自然日（交易日 ≈ 自然日的 5/7，再留出长假）。
#    不带下界时优化器可能扫整条 ``idx_date_mcap``（实测冷缓存 5.9 s，带下界 3 ms）；
#    真遇到长假导致行数不足 k，再用无下界的版本兜底（见 ``load_calendar``）。
_CALENDAR_SQL = """
SELECT DISTINCT trade_date
FROM {table}
WHERE trade_date <= %(asof)s AND trade_date >= %(floor)s
ORDER BY trade_date DESC
LIMIT %(k)s
"""

_CALENDAR_SQL_UNBOUNDED = """
SELECT DISTINCT trade_date
FROM {table}
WHERE trade_date <= %(asof)s
ORDER BY trade_date DESC
LIMIT %(k)s
"""

# ③ 日线：只取 6 列，符号用 tuple 参数由 pymysql 展开
_BARS_SQL = """
SELECT symbol, trade_date, open, close, pre_close, adj_factor
FROM {table}
WHERE symbol IN %(symbols)s AND trade_date BETWEEN %(start)s AND %(asof)s
ORDER BY symbol, trade_date
"""


def candidate_sql() -> str:
    return _CANDIDATE_SQL


def calendar_sql() -> str:
    return _CALENDAR_SQL.format(table=_BARS_TABLE)


def calendar_sql_unbounded() -> str:
    return _CALENDAR_SQL_UNBOUNDED.format(table=_BARS_TABLE)


def calendar_params(asof: _dt.date, k: int) -> dict[str, Any]:
    """② 的参数：下界 = asof − (k×2 + 30) 个自然日。"""
    return {
        "asof": asof,
        "k": int(k),
        "floor": asof - _dt.timedelta(days=int(k) * 2 + 30),
    }


def bars_sql() -> str:
    return _BARS_SQL.format(table=_BARS_TABLE)


def candidate_params(req: ScreenRequest) -> dict[str, Any]:
    """① 的参数。市值单位是**元**（库里口径），界面输入是亿元。"""
    return {
        "markets": tuple(req.markets),
        "include_st": 1 if req.include_st else 0,
        "cap_min": float(req.market_cap.min_yi) * _YI,
        "cap_max": float(req.market_cap.max_yi) * _YI,
    }


@dataclass
class ScreenData:
    """一次选股取回的全部原始数据。"""

    asof: _dt.date | None = None
    candidates: list[dict[str, Any]] = field(default_factory=list)
    calendar: list[_dt.date] = field(default_factory=list)
    series: dict[str, StockSeries] = field(default_factory=dict)
    fetched_bars: int = 0
    #: ② 的第一行 ≠ asof 时填「近期表最新日」，端点据此返回 503 screen_data_stale
    stale_date: _dt.date | None = None


def _tuple_cursor(conn: Any) -> Any:
    """③ 用的**流式** tuple cursor。

    两个理由，缺一个都会出问题：
    - 连接默认是 DictCursor，拿 dict 解包会得到键名（``'open'`` → float 转换失败）；
    - pymysql 的普通 ``Cursor`` 虽然叫 unbuffered，``execute`` 时仍会把**全部行**
      读进内存（实测 K=251 的 125 万行 → 峰值 919 MB）；``SSCursor`` 才是真正的
      服务端游标，逐批取。
    """
    from pymysql.cursors import SSCursor

    return conn.cursor(SSCursor)


def _as_date(value: Any) -> _dt.date | None:
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value)[:10])


def fetch_screen_data(req: ScreenRequest, k: int) -> ScreenData:
    """执行 ①②③ 并构建 ``StockSeries``。连接/查询失败抛 ``ForkDbUnavailable``。"""
    data = ScreenData()
    conn = fork_market._connect()
    try:
        # ① 候选
        with conn.cursor() as cursor:
            cursor.execute(candidate_sql(), candidate_params(req))
            data.candidates = list(cursor.fetchall() or [])
        if data.candidates:
            # 候选行都贴在「最新交易日」那一行行情上，所以任一行都能给出 asof
            data.asof = _as_date(data.candidates[0].get("trade_date"))
        if k <= 0 or not data.candidates or data.asof is None:
            return data

        # ② 日历（先带下界；长假导致行数不足 k 时再用无下界的版本补一次）
        with conn.cursor() as cursor:
            cursor.execute(calendar_sql(), calendar_params(data.asof, k))
            days = [
                day
                for day in (_as_date(row["trade_date"]) for row in cursor.fetchall() or [])
                if day is not None
            ]
            if len(days) < int(k):
                cursor.execute(calendar_sql_unbounded(), {"asof": data.asof, "k": int(k)})
                days = [
                    day
                    for day in (_as_date(row["trade_date"]) for row in cursor.fetchall() or [])
                    if day is not None
                ]
            data.calendar = days
        if not data.calendar:
            data.stale_date = data.asof
            return data
        if data.calendar[0] != data.asof:
            data.stale_date = data.calendar[0]
            return data

        symbols = tuple(str(row.get("symbol")) for row in data.candidates)
        start = data.calendar[-1]

        # ③ 日线（**普通 tuple cursor**，不是 DictCursor：百万行下 dict 的内存翻倍）
        #    + 流式处理，不 fetchall。
        buckets: dict[str, list] = {}
        with _tuple_cursor(conn) as cursor:
            cursor.execute(
                bars_sql(),
                {"symbols": symbols, "start": start, "asof": data.asof},
            )
            while True:
                batch = cursor.fetchmany(5000)
                if not batch:
                    break
                data.fetched_bars += len(batch)
                for symbol, trade_date, open_, close, pre_close, adj_factor in batch:
                    buckets.setdefault(str(symbol), []).append(
                        (trade_date, open_, close, pre_close, adj_factor)
                    )
        for symbol, rows in buckets.items():
            series = build_series(symbol, rows)
            if series is not None:
                data.series[symbol] = series
    except fork_market.ForkDbUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 转成 503 + 明确原因
        raise fork_market.ForkDbUnavailable(f"查询行情库失败：{exc}") from exc
    finally:
        conn.close()
    return data
