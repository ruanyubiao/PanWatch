"""诚实显著性：把「几十万条信号」当独立样本是错的，这里改成按日聚合。

问题
----
同一只股票连涨两天都命中，它的两个 30 日窗口重叠 29 天；同期上百只股票又共享
同一段大盘行情。把 291,316 行当独立样本做两比例 z 检验，分母被压小十倍以上，
于是出现 z = −11.8 这种「极其显著」。真实的独立样本量是**行情片段**的量级。

做法
----
1. **按日聚合**：每天算一个「条件组胜率 − 对照组胜率」，得到长度 D 的日度超额序列。
   这才是「一个观测」，量级从几十万降到一千多。
2. **重叠修正**：相邻日的 N 日窗口仍然重叠 N−1 天，日度序列强自相关。用两种
   互补办法给出区间：
   - Newey–West HAC 标准误，滞后阶数 = N−1（Bartlett 核）；
   - 移动块自助（moving block bootstrap），块长 = N，2000 次重采样取 2.5/97.5 分位。
3. **有效样本量** n_eff ≈ D / N：告诉用户「一千六百个交易日其实只有一百多个
   独立片段」。

结论分级（`verdict`）只认这里的区间：区间整体在 0 以上才算「有超额」，整体在
0 以下才算「显著更差」。原来的合并 z 值仍作为 `naive_z` 保留，用来说明偏差有多大。
"""

from __future__ import annotations

import math
import random
import sqlite3
from typing import Any, Iterable, Optional, Sequence

#: 自助重采样次数与随机种子（种子固定 = 同一份数据永远给同一个区间）
BOOTSTRAP_ROUNDS = 2000
BOOTSTRAP_SEED = 20261023


def _mean(values: Sequence[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _sd(values: Sequence[float]) -> float:
    """样本标准差（n−1）。少于两个值时返回 0。"""
    if len(values) < 2:
        return 0.0
    centre = sum(values) / len(values)
    variance = sum((value - centre) ** 2 for value in values) / (len(values) - 1)
    return math.sqrt(max(0.0, variance))


def _autocovariance(values: Sequence[float], lag: int) -> float:
    """滞后 ``lag`` 的自协方差（分母 n，与 Bartlett 核配套）。"""
    n = len(values)
    if n <= lag:
        return 0.0
    centre = sum(values) / n
    total = 0.0
    for index in range(n - lag):
        total += (values[index] - centre) * (values[index + lag] - centre)
    return total / n


def newey_west_se(values: Sequence[float], lag: int) -> float:
    """Newey–West（Bartlett 核）标准误：重叠窗口下日度均值的真实标准误。"""
    n = len(values)
    if n < 2:
        return 0.0
    lag = max(0, min(int(lag), n - 1))
    variance = _autocovariance(values, 0)
    for order in range(1, lag + 1):
        weight = 1.0 - order / (lag + 1.0)
        variance += 2.0 * weight * _autocovariance(values, order)
    variance = max(variance, 0.0)
    return math.sqrt(variance / n)


def block_bootstrap_ci(values: Sequence[float], block: int, rounds: int = BOOTSTRAP_ROUNDS,
                       seed: int = BOOTSTRAP_SEED) -> tuple[float, float]:
    """移动块自助的均值区间（百分数口径由调用方决定，这里只返回同单位数值）。

    块长 = 周期长度：把「连续 N 天」当一个不可分割的整体重采样，块内重叠被保留，
    块之间近似独立 —— 这正是重叠窗口的正确处理方式。
    """
    n = len(values)
    if n == 0:
        return (0.0, 0.0)
    block = max(1, min(int(block), n))
    blocks = [values[start:start + block] for start in range(0, n - block + 1)]
    if not blocks:
        return (0.0, 0.0)
    per_sample = max(1, math.ceil(n / block))
    rng = random.Random(seed)
    means: list[float] = []
    for _ in range(rounds):
        total = 0.0
        count = 0
        for _ in range(per_sample):
            chunk = blocks[rng.randrange(len(blocks))]
            total += sum(chunk)
            count += len(chunk)
        means.append(total / count if count else 0.0)
    means.sort()
    low = means[max(0, int(round(0.025 * (rounds - 1))))]
    high = means[min(rounds - 1, int(round(0.975 * (rounds - 1))))]
    return (low, high)


def summarize_series(values: Sequence[float], block: int) -> dict[str, Any]:
    """日度序列 → 均值 / 区间 / t 值 / 有效样本量。数值单位沿用输入（这里都是小数）。"""
    n = len(values)
    if n == 0:
        return {"days": 0, "mean": None, "ci_low": None, "ci_high": None,
                "t": None, "nw_t": None, "n_eff": 0, "sd": None}
    centre = sum(values) / n
    sd = _sd(values)
    nw = newey_west_se(values, block - 1)
    blocks = n // max(1, block)
    if blocks >= 10:
        low, high = block_bootstrap_ci(values, block)
        method = "bootstrap"
    else:
        # 独立块太少（比如只跑了半年、块长 30 天）时自助法会给出过窄的区间：
        # 块内一混，重采样均值就都挤在中间。这时改用正态近似 + HAC 标准误。
        se = nw if nw > 0 else (sd / math.sqrt(n) if sd > 0 else 0.0)
        low, high = centre - 1.96 * se, centre + 1.96 * se
        method = "normal"
    return {
        "days": n,
        "mean": centre,
        "sd": sd,
        "ci_low": low,
        "ci_high": high,
        "ci_method": method,
        "t": (centre / (sd / math.sqrt(n))) if sd > 0 else None,
        "nw_se": nw,
        "nw_t": (centre / nw) if nw > 0 else None,
        "n_eff": int(n // max(1, block)),
    }


# ---------------------------------------------------------------- 取数
def caliber_columns(conn: sqlite3.Connection) -> tuple[str, str]:
    """返回 (涨幅列前缀, 口径名)。有可执行口径（``x``）就用它，老任务退回收盘口径（``r``）。

    可执行口径 = 次日开盘买入，见 ``forward.build_forward``。老任务的 signals.db
    没有 ``x`` 列，读不到就退回 ``r``，报告里 ``caliber`` 字段会说明用的是哪种。
    """
    try:
        columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(signals)")}
    except sqlite3.OperationalError:
        return ("r", "close")
    if "x1" in columns:
        filled = conn.execute("SELECT COUNT(x1) AS n FROM signals WHERE is_control = 0").fetchone()["n"]
        if int(filled or 0) > 0:
            return ("x", "exec")
    return ("r", "close")


def _valid_sql(prefix: str) -> str:
    """排除不可验证行；可执行口径再排除「次日一字涨停买不进」。"""
    base = "COALESCE(verif, 1) = 1"
    if prefix == "x":
        return base + " AND COALESCE(unfillable, 0) = 0"
    return base


def _day_table(conn: sqlite3.Connection, horizon: int, prefix: str, is_control: int,
               cost: float = 0.0, start: Optional[str] = None,
               end: Optional[str] = None) -> dict[str, tuple[int, int, float]]:
    """{日期: (样本数, 上涨数, 平均涨幅)}。``cost`` 扣在涨幅上（净收益口径）。"""
    base = f"{prefix}{horizon}"
    col = f"({base} - {cost})" if cost else base
    clauses = ["is_control = ?", f"{base} IS NOT NULL", _valid_sql(prefix)]
    params: list[Any] = [int(is_control)]
    if start:
        clauses.append("d0 >= ?")
        params.append(start)
    if end:
        clauses.append("d0 < ?")
        params.append(end)
    sql = (
        f"SELECT d0, COUNT({col}) AS n, SUM(CASE WHEN {col} > 0 THEN 1 ELSE 0 END) AS w, "
        f"AVG({col}) AS a FROM signals WHERE {' AND '.join(clauses)} GROUP BY d0"
    )
    out: dict[str, tuple[int, int, float]] = {}
    for row in conn.execute(sql, tuple(params)):
        out[str(row["d0"])] = (int(row["n"] or 0), int(row["w"] or 0), float(row["a"] or 0.0))
    return out


def horizon_test(conn: sqlite3.Connection, horizon: int, prefix: str = "r",
                 cost: float = 0.0, start: Optional[str] = None,
                 end: Optional[str] = None) -> dict[str, Any]:
    """一个周期的诚实检验：日度超额序列 → 均值 / 区间 / 显著性。"""
    signal = _day_table(conn, horizon, prefix, 0, cost, start, end)
    control = _day_table(conn, horizon, prefix, 1, cost, start, end)
    days = sorted(set(signal) & set(control))
    win_excess: list[float] = []
    return_excess: list[float] = []
    for day in days:
        s_n, s_w, s_a = signal[day]
        c_n, c_w, c_a = control[day]
        if s_n <= 0 or c_n <= 0:
            continue
        win_excess.append(s_w / s_n - c_w / c_n)
        return_excess.append(s_a - c_a)

    win = summarize_series(win_excess, block=horizon)
    ret = summarize_series(return_excess, block=horizon)

    # 合并口径（旧算法的数字）：样本量被高估，只作为对照保留
    total_n = sum(n for n, _w, _a in signal.values())
    total_w = sum(w for _n, w, _a in signal.values())
    ctl_n = sum(n for n, _w, _a in control.values())
    ctl_w = sum(w for _n, w, _a in control.values())
    pooled = (total_w / total_n - ctl_w / ctl_n) if total_n and ctl_n else None

    significant_up = win["ci_low"] is not None and win["ci_low"] > 0
    significant_down = win["ci_high"] is not None and win["ci_high"] < 0
    return {
        "horizon": horizon,
        "caliber": "exec" if prefix == "x" else "close",
        "period": f"{start or ''}~{end or ''}",
        # 日度的平均超额（百分数）
        "mean_excess_pp": round(win["mean"] * 100, 3) if win["mean"] is not None else None,
        "ci_low_pp": round(win["ci_low"] * 100, 3) if win["ci_low"] is not None else None,
        "ci_high_pp": round(win["ci_high"] * 100, 3) if win["ci_high"] is not None else None,
        "t": round(win["t"], 2) if win["t"] is not None else None,
        "nw_t": round(win["nw_t"], 2) if win["nw_t"] is not None else None,
        "days": win["days"],
        "n_eff": win["n_eff"],
        # 合并口径（旧数字）：用来说明「不修正会夸大多少」
        "pooled_excess_pp": round(pooled * 100, 3) if pooled is not None else None,
        "significant_up": bool(significant_up),
        "significant_down": bool(significant_down),
        # 收益维度的超额（胜率高但赚小亏大时，这里会露出来）
        "mean_return_excess_pp": round(ret["mean"] * 100, 3) if ret["mean"] is not None else None,
        "return_ci_low_pp": round(ret["ci_low"] * 100, 3) if ret["ci_low"] is not None else None,
        "return_ci_high_pp": round(ret["ci_high"] * 100, 3) if ret["ci_high"] is not None else None,
        "return_significant_up": bool(ret["ci_low"] is not None and ret["ci_low"] > 0),
        "return_significant_down": bool(ret["ci_high"] is not None and ret["ci_high"] < 0),
    }


def tests(conn: sqlite3.Connection, horizons: Iterable[int], cost: float = 0.0,
          start: Optional[str] = None, end: Optional[str] = None) -> tuple[list[dict[str, Any]], str]:
    """全部周期的诚实检验 + 实际使用的口径名。"""
    prefix, caliber = caliber_columns(conn)
    return [horizon_test(conn, int(horizon), prefix, cost, start, end)
            for horizon in horizons], caliber


def conclusion(tests_: Sequence[dict[str, Any]], primary: int = 10,
               threshold_pp: float = 2.0) -> dict[str, Any]:
    """用诚实区间下结论。

    比旧逻辑严两处：
    - 旧：取**超额最大**的周期判定，等于选择性乐观；现在要求「至少两个周期同向
      显著」，且主周期（默认 10 日）的超额达到阈值。
    - 旧：显著性用合并 z；现在用日度区间（``ci_low_pp`` / ``ci_high_pp``）。
    """
    usable_rows = [row for row in tests_ if row["days"] >= 20]
    if not usable_rows:
        return {"verdict": "insufficient", "primary_horizon": primary,
                "up_count": 0, "down_count": 0, "primary_excess_pp": None,
                "reason": "insufficient"}
    up = [row for row in usable_rows if row["significant_up"]]
    down = [row for row in usable_rows if row["significant_down"]]
    focus = next((row for row in usable_rows if int(row["horizon"]) == int(primary)), None)
    if focus is None:
        focus = min(usable_rows, key=lambda row: abs(int(row["horizon"]) - int(primary)))
    primary_excess = focus["mean_excess_pp"]
    if len(up) >= 2 and primary_excess is not None and primary_excess >= threshold_pp:
        verdict = "usable"
    elif len(down) >= 2:
        verdict = "worse"
    elif len(up) >= 1 or len(down) >= 1:
        verdict = "mixed"
    else:
        verdict = "no_edge"
    return {
        "verdict": verdict,
        "primary_horizon": int(focus["horizon"]),
        "primary_excess_pp": primary_excess,
        "primary_ci_low_pp": focus["ci_low_pp"],
        "primary_ci_high_pp": focus["ci_high_pp"],
        "up_count": len(up),
        "down_count": len(down),
        "up_horizons": [row["horizon"] for row in up],
        "down_horizons": [row["horizon"] for row in down],
        "days": focus.get("days"),
        "n_eff": focus.get("n_eff"),
        "reason": verdict,
    }
