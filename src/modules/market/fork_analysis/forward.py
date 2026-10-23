"""前瞻行情：d0 之后的 30 个交易日的涨幅、停牌顺延、对照组抽样。

两套口径（2026-10-23 起并列）
---------------------------
1. **收盘口径（r1..rN）**：第 N 天涨幅 = 第 N 天收盘 / d0 收盘 − 1。
   回答「这个条件本身有没有预测力」，Excel 明细用的就是这一套（格式不变）。
2. **可执行口径（x1..xN）**：第 N 天涨幅 = 第 N 天收盘 / **次日开盘** − 1。
   信号在收盘后才成立，人只可能第二天开盘买。差额 = 隔夜跳空，恰好是信号最
   容易虚高的那一段。**判断「能不能用」只看这一套**（再扣 0.2% 往返成本，见
   ``EXEC_COST``，在统计层扣）。

数据缺口怎么处理（都是「不拿假数据凑数」）
----------------------------------------
- 停牌：按前一天有效收盘顺延（用户 2026-10-22 的口径），但**最多顺延
  ``SUSPEND_CAP`` 天**；超过就说明不是停牌而是退市/长期停牌，后面的涨幅留空、
  ``verif = 0``（不可验证），免得把「一路跌到退市」记成「不涨不跌 0%」。
- 复权因子缺失（NULL/0）：不默认成 1.0（那会把除权日变成假暴跌），该行
  ``verif = 0``、``adj_missing`` 计数。
- 次日开盘即涨停（主板 ≥9.5%、创业/科创 ≥19.5%）：标记 ``unfillable``，统计时
  从可执行口径剔除 —— 买不进去的涨停板不能算收益。
- 前瞻日历不够（离最新交易日太近）：该列留 NULL，不拿 0 冒充。
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

#: 停牌顺延上限（交易日）。超过视为退市/长期停牌 → 不可验证
SUSPEND_CAP = 20

#: 往返交易成本（买+卖+冲击），统计时从可执行口径里扣
EXEC_COST = 0.002

#: 涨停判定的容差：开盘涨幅 ≥ 板幅 − 0.5% 就算买不进
_LIMIT_TOLERANCE = 0.005


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


def limit_pct(code: str, day: Optional[_dt.date] = None) -> float:
    """涨跌停幅度：科创/创业 20%（创业板 2020-08-24 起），其余 10%。"""
    board = board_of(code)
    if board == "kcb":
        return 0.20
    if board == "cyb":
        return 0.20 if (day is None or day >= _dt.date(2020, 8, 24)) else 0.10
    return 0.10


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
    #: 收盘口径（Excel 明细）；日历不够时为 None（尾部）
    returns: list[Optional[float]] = field(default_factory=list)
    #: 可执行口径（次日开盘买入）；买不进/无开盘时全 None
    exec_returns: list[Optional[float]] = field(default_factory=list)
    #: 入场假设敏感性：次日典型价 (开+高+收)/3 买入；没有开盘价时全 None
    vwap_returns: list[Optional[float]] = field(default_factory=list)
    #: 与 ``HORIZONS`` 对齐的触及涨幅（盘中最高价口径）
    touches: list[Optional[float]] = field(default_factory=list)
    #: 30 个前瞻日里**真有行情**的天数（顺延出来的不算）
    avail: int = 0
    #: 次日开盘价（不复权，给人看的）；没有则为 None
    entry_open: Optional[float] = None
    #: 建仓发生在第几个交易日（1 = 次日）
    entry_days: int = 0
    #: 次日开盘即涨停 → 买不进
    unfillable: bool = False
    #: 最长连续顺延天数
    stale_days: int = 0
    #: 0 = 不可验证（长期停牌/退市/缺复权），统计时剔除
    verif: int = 1
    #: 复权因子缺失的天数
    adj_missing: int = 0


def _unpack(bar: "tuple[Any, ...]") -> tuple[_dt.date, Optional[float], float, float, float, float]:
    """一行 K 线 → ``(date, open_adj, close_adj, high_adj, open_raw, close_raw)``。

    兼容 4 元组（date, close, close_adj, high_adj）与 6 元组
    （date, open, close, close_adj, open_adj, high_adj）。
    老格式没有开盘价，用收盘价代替。
    """
    if len(bar) >= 6:
        return bar[0], bar[4], bar[3], bar[5], bar[1], bar[2]
    return bar[0], None, bar[2], bar[3], bar[1], bar[1]


def build_forward(
    bars: "list[tuple[Any, ...]]",
    forward_dates: list[_dt.date],
    limit: float = 0.10,
) -> Optional[ForwardResult]:
    """纯计算：``bars`` 升序、首根是 d0。

    ``forward_dates`` 是 d0 之后的交易日（最多 30 个，由交易日历给出）。
    """
    if not bars:
        return None
    _d0_date, _d0_open, d0_adj, _d0_high, _d0_open_raw, d0_close = _unpack(bars[0])
    if not d0_adj or d0_adj <= 0 or not d0_close or d0_close <= 0:
        return None

    closes: dict[_dt.date, float] = {}
    opens: dict[_dt.date, float] = {}
    opens_raw: dict[_dt.date, float] = {}
    highs: dict[_dt.date, float] = {}
    for bar in bars[1:]:
        day, open_adj, close_adj, high_adj, open_raw, _close_raw = _unpack(bar)
        if close_adj and close_adj > 0:
            closes[day] = close_adj
            highs[day] = high_adj if high_adj and high_adj > 0 else close_adj
        if open_adj and open_adj > 0:
            opens[day] = open_adj
            opens_raw[day] = open_raw if open_raw and open_raw > 0 else open_adj

    returns: list[Optional[float]] = []
    tops: list[float] = []
    avail = 0
    stale = 0
    stale_days = 0
    last = d0_adj
    degraded = False
    for day in forward_dates[:FORWARD_DAYS]:
        close = closes.get(day)
        if close is not None:
            last = close
            avail += 1
            stale = 0
        else:
            stale += 1
            stale_days = max(stale_days, stale)
            if stale > SUSPEND_CAP:
                # 超过顺延上限：不是停牌而是退市/长停，后面的数不再编
                degraded = True
                returns.append(None)
                tops.append(last)
                continue
        high = highs.get(day)
        if high is None or high < last:
            high = last
        returns.append(round(last / d0_adj - 1.0, 6))
        tops.append(high)

    if avail == 0:
        # 一根有效 K 线都没有（退市/长期停牌）：不给 0% 冒充「不涨不跌」
        return ForwardResult(d0_close=d0_close, d0_adj=d0_adj,
                             returns=[None] * len(returns),
                             exec_returns=[None] * len(returns),
                             vwap_returns=[None] * len(returns),
                             touches=[None] * len(HORIZONS), avail=0, verif=0)

    # ---- 可执行口径：次日（或停牌结束后的第一个）开盘买入
    entry_adj: Optional[float] = None
    entry_days = 0
    for offset, day in enumerate(forward_dates[:FORWARD_DAYS], start=1):
        value = opens.get(day)
        if value is not None:
            entry_adj = value
            entry_days = offset
            break
    exec_returns: list[Optional[float]] = [None] * len(returns)
    vwap_returns: list[Optional[float]] = [None] * len(returns)
    unfillable = False
    if entry_adj is not None:
        unfillable = (entry_adj / d0_adj - 1.0) >= (limit - _LIMIT_TOLERANCE)
        running: Optional[float] = entry_adj
        for index, day in enumerate(forward_dates[:FORWARD_DAYS]):
            close = closes.get(day)
            if close is not None:
                running = close
            if running is None:
                continue
            exec_returns[index] = round(running / entry_adj - 1.0, 6)
        # 入场假设敏感性：把「次日开盘价」换成「次日典型价 (开+高+收)/3」。
        # 开盘价是乐观假设（VWAP 更接近真实成交），两者差很多说明结论依赖成交价。
        entry_day = forward_dates[entry_days - 1]
        typical = None
        if opens.get(entry_day) is not None and closes.get(entry_day) is not None:
            high = highs.get(entry_day) or closes[entry_day]
            typical = (opens[entry_day] + high + closes[entry_day]) / 3.0
        if typical and typical > 0:
            running = typical
            for index, day in enumerate(forward_dates[:FORWARD_DAYS]):
                close = closes.get(day)
                if close is not None:
                    running = close
                if running is None:
                    continue
                vwap_returns[index] = round(running / typical - 1.0, 6)

    if len(returns) < FORWARD_DAYS:
        returns.extend([None] * (FORWARD_DAYS - len(returns)))
        exec_returns.extend([None] * (FORWARD_DAYS - len(exec_returns)))
        vwap_returns.extend([None] * (FORWARD_DAYS - len(vwap_returns)))

    touches: list[Optional[float]] = []
    for horizon in HORIZONS:
        window = tops[:horizon]
        if len(window) < horizon:
            touches.append(None)
            continue
        touches.append(round(max(window) / d0_adj - 1.0, 6))

    entry_open = opens_raw.get(forward_dates[entry_days - 1]) if entry_days else None
    return ForwardResult(
        d0_close=d0_close,
        d0_adj=d0_adj,
        returns=returns,
        exec_returns=exec_returns,
        vwap_returns=vwap_returns,
        touches=touches,
        avail=avail,
        entry_open=entry_open,
        entry_days=entry_days,
        unfillable=bool(unfillable),
        stale_days=stale_days,
        verif=0 if degraded else 1,
    )


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
) -> tuple[dict[str, list[tuple]], dict[str, int]]:
    """取 d0 与之后最多 30 个交易日的日线（含 d0 那根，作为基准）。

    返回 ``(bars, missing)``：``bars`` 每根是
    ``(date, open, close, close_adj, open_adj, high_adj)``；
    ``missing`` = {symbol: 复权因子缺失的天数}（这些天不进序列，由调用方标记
    ``verif = 0``，**不**默认 factor=1.0 冒充正常行情）。
    """
    wanted = tuple(str(symbol) for symbol in symbols)
    if not wanted:
        return {}, {}
    sql = (
        f"SELECT symbol, trade_date, open, close, high, adj_factor FROM {_BARS_TABLE} "
        "WHERE symbol IN %(symbols)s AND trade_date >= %(start)s AND trade_date <= %(end)s "
        "ORDER BY symbol, trade_date"
    )
    buckets: dict[str, list[tuple]] = {}
    missing: dict[str, int] = {}
    with _tuple_cursor(conn) as cursor:
        cursor.execute(sql, {"symbols": wanted, "start": d0, "end": last_day})
        while True:
            batch = cursor.fetchmany(5000)
            if not batch:
                break
            for symbol, day, open_raw, close, high, factor in batch:
                key = str(symbol)
                rows = buckets.setdefault(key, [])
                if len(rows) > FORWARD_DAYS:
                    continue
                if isinstance(day, _dt.datetime):
                    day = day.date()
                if not isinstance(day, _dt.date):
                    day = _dt.date.fromisoformat(str(day)[:10])
                close_value = float(close) if close is not None else 0.0
                if close_value <= 0:
                    # 停牌行：不进序列，交给 build_forward 顺延
                    continue
                if not factor or float(factor) <= 0:
                    # 复权因子缺失：不猜 1.0（除权日会变成假暴跌）
                    missing[key] = missing.get(key, 0) + 1
                    continue
                fq = float(factor)
                open_value = float(open_raw) if open_raw is not None else 0.0
                open_value = open_value if open_value > 0 else close_value
                high_value = float(high) if high is not None else 0.0
                rows.append((
                    day,
                    round(open_value, 4),
                    round(close_value, 4),
                    round(close_value * fq, 6),
                    round(open_value * fq, 6),
                    round(max(high_value, close_value) * fq, 6),
                ))
    return buckets, missing


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


def day_coverage(conn: Any, d0: _dt.date) -> Optional[int]:
    """当天有成交的股票数（数据完整性检查用：某天只同步了一半会让「命中 0 只」失真）。"""
    sql = (
        f"SELECT COUNT(*) AS n FROM {_BARS_TABLE} "
        "WHERE trade_date = %(d0)s AND traded = 1 AND close > 0"
    )
    try:
        with conn.cursor() as cursor:
            cursor.execute(sql, {"d0": d0})
            row = cursor.fetchone() or {}
    except Exception:  # noqa: BLE001
        logger.exception("统计 %s 的覆盖数失败", d0)
        return None
    return int((row.get("n") if isinstance(row, dict) else 0) or 0)


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


def data_version(conn: Any) -> dict[str, Any]:
    """数据版本戳：两次结果不同时，能分清是「条件变了」还是「数据变了」。

    只做轻量统计：最新交易日 + 股票池大小 + 近 5 个交易日的行数（全表 COUNT(*)
    在 1700 万行上要几十秒，不值得每次都算）。
    """
    out: dict[str, Any] = {}
    try:
        with conn.cursor() as cursor:
            cursor.execute(f"SELECT MAX(trade_date) AS asof FROM {_BARS_TABLE}")
            row = cursor.fetchone() or {}
            asof = row.get("asof")
            out["max_trade_date"] = str(asof)[:10] if asof is not None else None
            cursor.execute("SELECT COUNT(*) AS n FROM stock_info")
            out["symbols"] = int((cursor.fetchone() or {}).get("n") or 0)
            cursor.execute(
                f"SELECT trade_date, COUNT(*) AS n FROM {_BARS_TABLE} "
                "WHERE trade_date >= DATE_SUB((SELECT MAX(trade_date) FROM stock_daily), INTERVAL 10 DAY) "
                "GROUP BY trade_date ORDER BY trade_date DESC LIMIT 5"
            )
            out["recent_rows"] = [
                {"d": str(item.get("trade_date"))[:10], "n": int(item.get("n") or 0)}
                for item in (cursor.fetchall() or [])
            ]
    except Exception:  # noqa: BLE001 - 版本戳算不出来不该毁掉任务
        logger.exception("取数据版本戳失败")
    return out


def control_sample(
    conn: Any,
    d0: _dt.date,
    limit: int,
    markets: Iterable[str],
    include_st: bool,
    exclude: Iterable[str] = (),
    match_cap: bool = True,
) -> list[dict[str, Any]]:
    """对照组：当天同市场、**按市值分档配比**抽取 ``limit`` 只。

    三个改进（2026-10-23）：
    1. **市值匹配**：条件天然偏小盘，小盘本身波动大、30 日胜率不同。不匹配的话
       超额里混了「市值 beta」，看起来有 alpha 其实只是买小盘。
    2. **确定性抽样**：``CRC32(symbol||日期)`` 排序取前 N，不用 ``ORDER BY RAND()``。
       同一份数据永远抽同一批，报告可复现。
    3. **排除自己**：命中的股票不能同时出现在对照组里。

    抽取时按「当天命中股票的市值档分布」配比（命中股票里多少比例在 0–30 亿，
    对照组就抽多少比例），这样两组的市值结构一致。
    """
    if limit <= 0:
        return []
    clauses = [_MARKET_SQL[key] for key in markets if key in _MARKET_SQL]
    market_sql = f" AND ({' OR '.join(clauses)})" if clauses else ""
    excluded = tuple(sorted({str(code) for code in exclude if code}))
    exclude_sql = " AND d.code NOT IN %(exclude)s" if excluded else ""
    base_where = f"""
WHERE d.trade_date = %(d0)s
  AND d.close > 0 AND d.adj_factor > 0
  AND i.status = 'listed'
  AND (%(include_st)s = 1 OR LOCATE('ST', UPPER(REPLACE(i.name, ' ', ''))) = 0){market_sql}{exclude_sql}
"""
    params = {"d0": d0, "include_st": 1 if include_st else 0, "limit": int(limit)}
    if excluded:
        params["exclude"] = excluded
    sql = f"""
SELECT code, symbol, name, close, total_market_cap AS mcap
FROM (
    SELECT i.code, i.symbol, i.name, d.close, d.total_market_cap,
           CRC32(CONCAT(i.symbol, %(d0)s)) AS rnd
    FROM {_BARS_TABLE} d
    JOIN stock_info i ON i.symbol = d.symbol
    {base_where}
    ORDER BY rnd
    LIMIT %(pool)s
) t
ORDER BY rnd
"""
    pool = int(limit) * 8 if match_cap else int(limit)
    params["pool"] = max(pool, int(limit))
    with conn.cursor() as cursor:
        cursor.execute(sql, params)
        rows = cursor.fetchall() or []
    candidates = [
        {
            "code": str(row.get("code") or ""),
            "symbol": str(row.get("symbol") or ""),
            "name": str(row.get("name") or ""),
            "close": float(row.get("close") or 0.0),
            "mcap": float(row["mcap"]) / 1e8 if row.get("mcap") is not None else None,
        }
        for row in rows
        if row.get("symbol")
    ]
    if not match_cap or not candidates:
        return candidates[: int(limit)]
    return candidates[: int(limit)]


def control_sample_matched(
    conn: Any,
    d0: _dt.date,
    limit: int,
    markets: Iterable[str],
    include_st: bool,
    hit_mcaps: Iterable[Optional[float]],
    exclude: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """按命中股票的市值档分布配比抽对照组（配比失败时退回普通抽样）。"""
    import bisect

    edges = (30.0, 100.0, 300.0, 1000.0)

    def tier(value: Optional[float]) -> int:
        if value is None:
            return 0
        return bisect.bisect_left(edges, float(value))

    hits = [tier(value) for value in hit_mcaps]
    if not hits:
        return control_sample(conn, d0, limit, markets, include_st, exclude=exclude)
    counts = [0] * (len(edges) + 1)
    for tier_index in hits:
        counts[tier_index] += 1
    share = [count / len(hits) for count in counts]

    # 候选池放大到 20 倍：市值分档配比时高档（1000 亿以上）经常不够抽，
    # 池子小了就只能用「补位」的方式凑数，匹配度会掉。
    pool = control_sample(conn, d0, int(limit) * 20, markets, include_st, exclude=exclude, match_cap=False)
    buckets: dict[int, list[dict[str, Any]]] = {}
    for item in pool:
        buckets.setdefault(tier(item.get("mcap")), []).append(item)
    picked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tier_index, ratio in enumerate(share):
        want = int(round(ratio * int(limit)))
        for item in buckets.get(tier_index, [])[:want]:
            if item["symbol"] in seen:
                continue
            picked.append(item)
            seen.add(item["symbol"])
    if len(picked) < int(limit):
        for item in pool:
            if len(picked) >= int(limit):
                break
            if item["symbol"] in seen:
                continue
            picked.append(item)
            seen.add(item["symbol"])
    return picked[: int(limit)]
