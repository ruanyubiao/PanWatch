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
from typing import Any, Iterable

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
#
# 市值过滤是**可选**的（``{cap}``）：2026-10-21 起「总市值」搬进了条件列表，新请求
# 不再带基础市值区间，这时候选 = 所选市场（默认全市场），市值在条件树里按天算。
# 老脚本 / 老条件文件仍然带区间，照旧在 SQL 里先过滤（省一次全市场求值）。
_CAP_FILTER = """
  AND COALESCE(total_market_cap, info_market_cap) > %(cap_min)s
  AND COALESCE(total_market_cap, info_market_cap) < %(cap_max)s"""

#: 「总市值」条件 → SQL 比较符（AND 分支里的市值条件可以下推成候选过滤）
_CAP_OPERATORS = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<="}


def cap_prefilter_sql(predicates: "Iterable[tuple[str, float]]") -> str:
    """把 AND 分支里的市值条件拼成 WHERE 片段（见 ``evaluator.required_market_cap_filters``）。

    空集 → 空串。占位符叫 ``cap_pre_0`` / ``cap_pre_1`` …（同一条条件可能出现两次，
    比如「≥ 50 亿」且「< 200 亿」，所以要按序号区分）。
    """
    lines = [
        f"  AND COALESCE(total_market_cap, info_market_cap) {_CAP_OPERATORS[op]} %(cap_pre_{index})s"
        for index, (op, _value) in enumerate(predicates)
    ]
    return "".join("\n" + line for line in lines)

_CANDIDATE_SQL = (
    fork_market._WITH_UNI
    + fork_market._PAGE_SELECT
    + """
WHERE market_board IN %(markets)s
  AND (%(include_st)s = 1 OR is_st = 0){cap}{extra}
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

# ③ 日线：默认只取 6 列（``map_row``/均线真正用到的）。量价条件按**用到的列**再补：
#    换手率只要 turnover_rate、成交量只要 volume、量比只要 volume、成交额只要 amount，
#    外加一列 traded 当停牌标记。实测全市场 30 天：6 列 1.7s，11 列 3.1s，
#    所以「多取一列都是钱」，不能图省事固定取全。
_BASE_COLUMNS = ("symbol", "trade_date", "open", "close", "pre_close", "adj_factor")
#: 额外列在 SELECT 里的固定顺序（``build_series`` 按下标取值，两边必须一致）
_EXTRAS_ORDER = ("traded", "volume", "amount", "turnover_rate", "total_market_cap")


def extras_select(extras: "Iterable[str]") -> tuple[str, ...]:
    """把条件需要的列名补上 ``traded``，按固定顺序返回。空集 = 不加列。"""
    wanted = set(extras)
    if not wanted:
        return ()
    return tuple(name for name in _EXTRAS_ORDER if name == "traded" or name in wanted)


_BARS_SQL = """
SELECT {columns}
FROM {table}
WHERE symbol IN %(symbols)s AND trade_date BETWEEN %(start)s AND %(asof)s
ORDER BY symbol, trade_date
"""

#: ``_WITH_UNI`` 里「最新交易日」那一段。指定 asof 时把它换成固定日期 ——
#: 用字符串替换而不是复制整段 CTE（``_WITH_UNI`` 属上游共享件，少惹事）。
#: 替换失败会静默算出「最新日」而不是指定日，所以单测钉住「锚点只出现一次」。
_LATEST_ANCHOR = "latest AS (SELECT MAX(trade_date) AS asof FROM stock_daily)"


def candidate_sql(
    asof: _dt.date | None = None,
    with_cap: bool = False,
    predicates: "Iterable[tuple[str, float]]" = (),
) -> str:
    """① 候选 SQL。``asof`` 给了就把「最新交易日」固定成那一天。

    ``with_cap``：是否把基础市值区间拼进 WHERE（老请求才带区间）。
    ``predicates``：AND 分支里必然成立的总市值条件（``(op, 亿元)``），下推成 SQL。
    """
    preds = tuple(predicates)
    sql = _CANDIDATE_SQL.format(
        cap=_CAP_FILTER if with_cap else "",
        extra=cap_prefilter_sql(preds),
    )
    if asof is None:
        return sql
    anchored = f"latest AS (SELECT DATE '{asof.isoformat()}' AS asof)"
    return sql.replace(_LATEST_ANCHOR, anchored)


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


def bars_sql(extras: "Iterable[str]" = ()) -> str:
    columns = list(_BASE_COLUMNS) + list(extras_select(extras))
    return _BARS_SQL.format(columns=", ".join(columns), table=_BARS_TABLE)


def candidate_params(
    req: ScreenRequest, predicates: "Iterable[tuple[str, float]]" = ()
) -> dict[str, Any]:
    """① 的参数。市值单位是**元**（库里口径），界面输入是亿元。

    没有基础市值区间（新请求）时不带 ``cap_min`` / ``cap_max`` —— SQL 里也没有
    对应的占位符（见 ``candidate_sql``）。``cap_pre_N`` 来自市值条件下推。
    """
    params: dict[str, Any] = {
        "markets": tuple(req.markets),
        "include_st": 1 if req.include_st else 0,
    }
    cap = req.market_cap
    if cap is not None:
        params["cap_min"] = float(cap.min_yi) * _YI
        params["cap_max"] = float(cap.max_yi) * _YI
    for index, (_op, value) in enumerate(predicates):
        params[f"cap_pre_{index}"] = float(value) * _YI
    return params


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


def resolve_asof(day: _dt.date) -> _dt.date | None:
    """把用户给的日期落到 ≤ 该日的**最大交易日**（非交易日自动回退）。

    走 ``idx_trade_date`` 的倒序扫描，实测毫秒级。库里一条数据都没有时返回 None
    （调用方转成明确错误，不要拿「今天」冒充）。
    """
    conn = fork_market._connect()
    try:
        with conn.cursor() as cursor:
            cursor.execute(
                "SELECT MAX(trade_date) AS asof FROM stock_daily WHERE trade_date <= %(day)s",
                {"day": day},
            )
            row = cursor.fetchone() or {}
            return _as_date(row.get("asof"))
    except fork_market.ForkDbUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise fork_market.ForkDbUnavailable(f"查询行情库失败：{exc}") from exc
    finally:
        conn.close()


def fetch_screen_data(
    req: ScreenRequest,
    k: int,
    asof: _dt.date | None = None,
    extras: Iterable[str] = (),
    predicates: Iterable[tuple[str, float]] = (),
) -> ScreenData:
    """执行 ①②③ 并构建 ``StockSeries``。连接/查询失败抛 ``ForkDbUnavailable``。

    ``asof`` 给了就按那一天选股（窗口从它往前数），不给就是库里最新交易日。
    ``extras`` 是条件需要额外取的列（见 ``conditions.extras_columns_of``）：
    空就从 6 列取，非空按并集加上 ``traded`` 与那几列。
    ``predicates`` 是 AND 分支里必然成立的总市值条件，下推成候选 SQL 的过滤 ——
    「市值 ≥ 100 亿」这类条件因此不用把全市场 250 根日线都读进内存。
    """
    preds = tuple(predicates)
    columns = extras_select(extras)
    data = ScreenData(asof=asof)
    conn = fork_market._connect()
    try:
        # ① 候选
        with conn.cursor() as cursor:
            cursor.execute(
                candidate_sql(asof, with_cap=req.market_cap is not None, predicates=preds),
                candidate_params(req, preds),
            )
            data.candidates = list(cursor.fetchall() or [])
        if data.asof is None and data.candidates:
            # 候选行都贴在锚点那一行行情上，所以任一行都能给出 asof
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
                bars_sql(extras),
                {"symbols": symbols, "start": start, "asof": data.asof},
            )
            while True:
                batch = cursor.fetchmany(5000)
                if not batch:
                    break
                data.fetched_bars += len(batch)
                for row in batch:
                    buckets.setdefault(str(row[0]), []).append(tuple(row[1:]))
        for symbol, rows in buckets.items():
            series = build_series(symbol, rows, columns)
            if series is not None:
                data.series[symbol] = series
    except fork_market.ForkDbUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 转成 503 + 明确原因
        raise fork_market.ForkDbUnavailable(f"查询行情库失败：{exc}") from exc
    finally:
        conn.close()
    return data
