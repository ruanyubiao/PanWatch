"""方法 3 的行情取数：收盘价口径的 5/10/20/25/30 日点位与窗口极值。

为什么需要第三份取数
--------------------
方法 1 存的是「第 N 天收盘涨幅」「N 天内最高价相对信号日收盘」；方法 2 存的是
「N 天内最高/最低价」。方法 3 要回答的是「**盈利概率**」，所以必须知道：

* 第 N 天**收盘价**（点对点卖出的成交价，停牌时按停牌前收盘顺延）；
* 1..N 天内**最高收盘价**（只要盘中摸高不算，避免方法 2 那个 97% 的饱和问题）；
* 1..N 天内**最低收盘价**（最大不利，用于解释「为什么胜率不低却亏」）。

这三样在任何既有表里都没有，硬加进 forward/method2 会污染已有几十万行任务的口径，
所以单开一份。

口径
----
1. 买入价 = 信号日之后第一个有行情的交易日的**开盘价**（后复权），停牌则顺延并记
   ``entry_days``。
2. 窗口 N 的点位 ``c{N}`` = 第 N 个交易日（含）之前最后一个有行情日的收盘价；
   停牌日不新增价格（等价于按停牌前价格计算）。
3. ``mc{N}`` / ``mn{N}`` = 第 entry_days..N 天收盘价的最大 / 最小值。
4. 复权因子缺失 → 该行不可验证（不猜 1.0），一字涨停 → 买不进，单独计数。
5. 停牌顺延超过 ``SUSPEND_CAP`` 天 → 长期停牌/退市，记不可验证，不当作 0% 收益。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Optional, Sequence

from ..forward import SUSPEND_CAP, limit_pct
from .method3 import FULL_DAYS, WINDOWS

#: 涨跌停判定容差（与 forward / method2 同量级）
TOLERANCE = 0.005


def build_event(bars: Sequence[tuple], fwd_dates: Sequence[_dt.date], d0: _dt.date,
                code: str, windows: Sequence[int] = WINDOWS, horizon: int = FULL_DAYS,
                adj_missing: int = 0) -> Optional[dict[str, Any]]:
    """纯计算：一只股票在 d0 的收盘口径窗口点位。

    ``bars`` 来自 :func:`fork_analysis.methods.method2_data.fetch_bars`（已含后复权，
    每根是 ``(date, open_adj, close_adj, high_adj, low_adj, open_raw, close_raw)``）。

    返回 ``None``：连 d0 的 K 线都没有，这条样本不成立。
    其余一律返回字典，用 ``valid`` / ``reason`` 表达能不能进主分析集。
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
    if not any(day in position for day in fwd_dates[:horizon]):
        return None

    # 建仓：d0 之后第一个有行情的交易日（停牌顺延）
    entry_day = None
    entry_days = 0
    buy_price = 0.0
    for index, day in enumerate(fwd_dates[:horizon], start=1):
        bar = position.get(day)
        if bar is None:
            continue
        candidate = float(bar[1])
        if candidate <= 0:
            continue
        entry_day, entry_days, buy_price = day, index, candidate
        break
    if entry_day is None or buy_price <= 0:
        return None

    limit = limit_pct(code, d0)
    unfillable = (buy_price / d0_close_adj - 1.0) >= (limit - TOLERANCE)

    last_close = 0.0
    max_close = 0.0
    min_close = float("inf")
    avail = 0
    stale = 0
    max_stale = 0
    degraded = False
    marks: dict[int, tuple[float, float, float]] = {}
    wanted = set(windows)

    for index, day in enumerate(fwd_dates[:horizon], start=1):
        bar = position.get(day)
        if bar is None:
            stale += 1
            max_stale = max(max_stale, stale)
            if stale > SUSPEND_CAP:
                degraded = True
            if index in wanted and last_close > 0:
                marks[index] = (last_close, max_close, min_close)
            continue
        stale = 0
        avail += 1
        close_value = float(bar[2])
        if day >= entry_day:  # 建仓日之前（停牌顺延的那几天）不计入极值
            last_close = close_value
            max_close = max(max_close, close_value)
            min_close = min(min_close, close_value)
        if index in wanted and last_close > 0:
            marks[index] = (last_close, max_close, min_close)

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

    return {
        "buy_price": buy_price,
        "d0_close": float(series[0][6]),
        "entry_days": entry_days,
        "avail": avail,
        "max_stale": max_stale,
        "valid": not reason,
        "reason": reason,
        "unfillable": int(unfillable),
        "c": {window: (marks[window][0] if window in marks else None) for window in windows},
        "mc": {window: (marks[window][1] if window in marks else None) for window in windows},
        "mn": {window: (marks[window][2] if window in marks and marks[window][2] != float("inf")
                        else None) for window in windows},
    }
