"""方法 2 的行情取数：35 个交易日的最高价/最低价/收盘价（后复权）。

为什么不复用 :func:`fork_analysis.forward.build_forward`
------------------------------------------------------
方法 1 只需要「收盘涨幅」和「窗口内最高价相对 d0 收盘」，取数 SQL 只查
``high``；方法 2 还要 **最低价**（最大不利波动）、要 35 天（方法 1 是 30 天）、
并且基准价是**次日开盘**而不是 d0 收盘。硬塞进 ``build_forward`` 会让两条口径
互相污染（方法 1 的 r/x/t 列已经被几十万行历史任务依赖），所以单独一份取数，
只共享 ``limit_pct`` / 交易日历这些与口径无关的工具。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Iterable, Optional, Sequence

from ..forward import SUSPEND_CAP, limit_pct
from .method2 import FULL_DAYS

#: 涨跌停判定的容差（与 forward 保持同量级）
TOLERANCE = 0.005

_BARS_TABLE = "stock_daily"


def fetch_bars(conn: Any, d0: _dt.date, symbols: Iterable[str],
               last_day: _dt.date) -> tuple[dict[str, list[tuple]], dict[str, int]]:
    """取 d0 与之后最多 35 个交易日的日线。

    返回 ``(bars, missing)``；每根是
    ``(date, open_adj, close_adj, high_adj, low_adj, open_raw)``。
    ``missing`` = {symbol: 复权因子缺失的天数}（不猜 1.0，直接标记不可验证）。
    """
    wanted = tuple(str(symbol) for symbol in symbols)
    if not wanted:
        return {}, {}
    from pymysql.cursors import SSCursor

    sql = (
        f"SELECT symbol, trade_date, open, close, high, low, adj_factor FROM {_BARS_TABLE} "
        "WHERE symbol IN %(symbols)s AND trade_date >= %(start)s AND trade_date <= %(end)s "
        "ORDER BY symbol, trade_date"
    )
    buckets: dict[str, list[tuple]] = {}
    missing: dict[str, int] = {}
    with conn.cursor(SSCursor) as cursor:
        cursor.execute(sql, {"symbols": wanted, "start": d0, "end": last_day})
        while True:
            batch = cursor.fetchmany(5000)
            if not batch:
                break
            for symbol, day, open_raw, close, high, low, factor in batch:
                key = str(symbol)
                rows = buckets.setdefault(key, [])
                if len(rows) > FULL_DAYS:
                    continue
                if isinstance(day, _dt.datetime):
                    day = day.date()
                elif not isinstance(day, _dt.date):
                    day = _dt.date.fromisoformat(str(day)[:10])
                close_value = float(close) if close is not None else 0.0
                if close_value <= 0:
                    continue  # 停牌行：不进序列
                if not factor or float(factor) <= 0:
                    missing[key] = missing.get(key, 0) + 1
                    continue
                fq = float(factor)
                open_value = float(open_raw) if open_raw is not None else 0.0
                open_value = open_value if open_value > 0 else close_value
                high_value = float(high) if high is not None else 0.0
                low_value = float(low) if low is not None else 0.0
                low_value = low_value if low_value > 0 else close_value
                rows.append((
                    day,
                    round(open_value * fq, 6),
                    round(close_value * fq, 6),
                    round(max(high_value, close_value) * fq, 6),
                    round(min(low_value, close_value) * fq, 6),
                    round(open_value, 4),
                    round(close_value, 4),
                ))
    return buckets, missing


def build_event(bars: Sequence[tuple], fwd_dates: Sequence[_dt.date], d0: _dt.date,
                code: str, windows: Sequence[int], horizon: int = FULL_DAYS,
                adj_missing: int = 0) -> Optional[dict[str, Any]]:
    """纯计算：一只股票在 d0 的窗口极值。

    返回 ``None`` 表示连基准都算不出来（d0 没有 K 线）。
    其余情况一律返回字典，用 ``valid`` / ``reason`` 表达「能不能进主分析集」——
    规格要求异常必须单独记录，不能悄悄丢掉。
    """
    if not bars or bars[0][0] != d0:
        return None
    series = [bar for bar in bars if bar[0] >= d0]
    if not series or series[0][0] != d0:
        return None
    d0_close_adj = float(series[0][2])
    if d0_close_adj <= 0:
        return None

    position = {bar[0]: bar for bar in series}
    forward_days = [day for day in fwd_dates[:horizon] if day in position]
    if not forward_days:
        return None

    # 建仓：d0 之后第一个有开盘价的交易日
    entry_day = forward_days[0]
    buy_price = float(position[entry_day][1])
    entry_days = 1
    for index, day in enumerate(fwd_dates[:horizon], start=1):
        if day in position:
            entry_day = day
            buy_price = float(position[day][1])
            entry_days = index
            break
    if buy_price <= 0:
        return None

    limit = limit_pct(code, d0)
    jump = buy_price / d0_close_adj - 1.0
    unfillable = jump >= (limit - TOLERANCE)

    max_high = 0.0
    min_low = float("inf")
    avail = 0
    stale = 0
    max_stale = 0
    degraded = False
    marks: dict[int, tuple[float, float]] = {}
    wanted = set(windows)
    for index, day in enumerate(fwd_dates[:horizon], start=1):
        bar = position.get(day)
        if bar is None:
            stale += 1
            max_stale = max(max_stale, stale)
            if stale > SUSPEND_CAP:
                degraded = True
            if index in wanted and max_high > 0:
                marks[index] = (max_high, min_low)
            continue
        stale = 0
        avail += 1
        high = float(bar[3])
        low = float(bar[4])
        if day >= entry_day:  # 建仓日之前（停牌顺延）不计入极值
            max_high = max(max_high, high)
            min_low = min(min_low, low)
        if index in wanted and max_high > 0:
            marks[index] = (max_high, min_low)

    complete = avail >= horizon and len(fwd_dates) >= horizon
    if adj_missing:
        reason = "adj_factor_missing"
    elif unfillable:
        reason = "open_limit_up"
    elif degraded:
        reason = "long_suspension"
    elif not complete:
        reason = "incomplete_forward"
    else:
        reason = ""

    valid = not reason
    return {
        "buy_price": buy_price,
        "d0_close": float(series[0][6]),
        "entry_days": entry_days,
        "avail": avail,
        "max_stale": max_stale,
        "valid": valid,
        "reason": reason,
        "unfillable": int(unfillable),
        "mh": {window: (marks[window][0] if window in marks else None) for window in windows},
        "ml": {window: (marks[window][1] if window in marks and marks[window][1] != float("inf")
                        else None) for window in windows},
    }
