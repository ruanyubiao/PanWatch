"""组合容量模拟：从「每笔信号平均赚多少」走到「这个策略能不能真的交易」。

为什么必须做
------------
现在的统计把每一条信号当成一笔独立交易，但信号是**成簇**的：同一天可能命中
几百只。真实账户只能买有限仓位数、有资金上限、持仓会重叠、部分标的开盘一字
涨停买不进。一个「胜率 55%」的条件，每天命中 300 只、只能买 10 只，实际收益
可能完全不同。

做法（保守、可解释）
--------------------
- 每个交易日按成交额从大到小取前 K 只（流动性优先，天然规避买不进的微盘）；
- 等权，持有 H 个交易日，到期换出；同一天最多投入 1/H 的资金（K 个仓位平分）；
- 单笔收益直接用 ``signals.db`` 里已存的逐日累计涨幅 ``x1..x30``
  （次日开盘买入口径），所以不需要回查行情库；
- 成本在买入当天一次性扣除（``cost=None`` 时按当日成交额逐行算）；
- 空仓日按现金处理（收益 0）。

基准是**同一套规则跑对照组**：每天随机 200 只里取前 K 只。这才是「同样的仓位
约束下，条件比随机好多少」，而不是拿指数比（指数没有仓位与流动性约束）。

输出组合净值曲线 + 年化 / 最大回撤 / 夏普 / 日均持仓 / 资金利用率。
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Optional

from . import costs

#: 默认持仓只数（K）
DEFAULT_TOP_K = 10
#: 净值曲线最多返回的点数（前端画图用，多了没意义）
MAX_POINTS = 400


def _columns(conn: sqlite3.Connection, horizon: int) -> tuple[str, bool]:
    """口径探测：**看有没有数据**，不只看列在不在（老任务被迁移补了空列）。"""
    from . import significance

    prefix, caliber = significance.caliber_columns(conn)
    return prefix, caliber == "exec"


def _rows(conn: sqlite3.Connection, horizon: int, is_control: int, prefix: str,
          limit_days: Optional[int] = None) -> dict[str, list[dict[str, Any]]]:
    fields = ", ".join(f"{prefix}{index}" for index in range(1, horizon + 1))
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(signals)")}
    extra = ""
    if "unfillable" in columns:
        extra += ", COALESCE(unfillable, 0) AS unfillable"
    else:
        extra += ", 0 AS unfillable"
    extra += ", COALESCE(verif, 1) AS verif"
    extra += ", amount" if "amount" in columns else ", NULL AS amount"
    sql = (
        f"SELECT d0, code, {fields}{extra} FROM signals "
        f"WHERE is_control = ? AND {prefix}{horizon} IS NOT NULL ORDER BY d0"
    )
    buckets: dict[str, list[dict[str, Any]]] = {}
    for row in conn.execute(sql, (int(is_control),)):
        if int(row["verif"] or 0) == 0 or int(row["unfillable"] or 0) == 1:
            continue
        series: list[Optional[float]] = []
        for index in range(1, horizon + 1):
            value = row[f"{prefix}{index}"]
            series.append(float(value) if value is not None else None)
        buckets.setdefault(str(row["d0"]), []).append({
            "code": str(row["code"]),
            "amount": float(row["amount"]) if row["amount"] is not None else -1.0,
            "series": series,
        })
    if limit_days and len(buckets) > limit_days:
        keys = sorted(buckets)[-limit_days:]
        buckets = {key: buckets[key] for key in keys}
    return buckets


def _daily_return(series: list[Optional[float]], age: int) -> Optional[float]:
    """持有到第 ``age`` 个交易日当天的单日收益（age=0 是买入当天）。"""
    if age <= 0:
        return None
    current = series[age - 1] if age - 1 < len(series) else None
    if current is None:
        return None
    previous = series[age - 2] if age >= 2 and age - 2 < len(series) else 0.0
    if previous is None:
        previous = 0.0
    if previous <= -1.0:
        return None
    return (1.0 + current) / (1.0 + previous) - 1.0


def _simulate(buckets: dict[str, list[dict[str, Any]]], horizon: int, top_k: int,
              cost: Optional[float]) -> dict[str, Any]:
    days = sorted(buckets)
    if not days:
        return {"equity": [], "metrics": {"days": 0}, "entries": 0}
    index = {day: position for position, day in enumerate(days)}
    entries: dict[int, list[dict[str, Any]]] = {}
    skipped = 0
    for day in days:
        ranked = sorted(buckets[day], key=lambda item: -item["amount"])[:top_k]
        skipped += max(0, len(buckets[day]) - len(ranked))
        prepared = []
        for item in ranked:
            unit_cost = cost if cost is not None else costs.realistic_cost(day, item["amount"])
            prepared.append({**item, "cost": unit_cost})
        entries[index[day]] = prepared

    equity = [1.0]
    daily: list[float] = []
    active_counts: list[int] = []
    curve: list[dict[str, Any]] = [{"d0": days[0], "value": 1.0}]
    for position, day in enumerate(days):
        returns: list[float] = []
        active = 0
        for offset in range(horizon):
            entry_day = position - offset
            if entry_day < 0:
                continue
            for item in entries.get(entry_day, []):
                age = position - entry_day
                if age == 0:
                    # 信号日收盘才确定命中，真正的买入发生在下一个交易日开盘：
                    # 信号日当天不产生盈亏，也不把这一格算作持仓。
                    continue
                value = _daily_return(item["series"], age)
                if value is None:
                    continue
                if age == 1:
                    # 成本在买入当天扣一次（之后不再重复扣）
                    value = (1.0 + (item["series"][0] or 0.0)) * (1.0 - item["cost"]) - 1.0
                returns.append(value)
                active += 1
        portfolio_return = sum(returns) / len(returns) if returns else 0.0
        daily.append(portfolio_return)
        active_counts.append(active)
        equity.append(equity[-1] * (1.0 + portfolio_return))
        curve.append({"d0": day, "value": round(equity[-1], 5)})

    values = equity[1:]
    peak = 0.0
    mdd = 0.0
    for value in values:
        peak = max(peak, value)
        if peak > 0:
            mdd = min(mdd, value / peak - 1.0)
    mean = sum(daily) / len(daily) if daily else 0.0
    variance = sum((item - mean) ** 2 for item in daily) / (len(daily) - 1) if len(daily) > 1 else 0.0
    sd = math.sqrt(max(variance, 0.0))
    total_return = equity[-1] - 1.0
    years = len(daily) / 252.0
    annualised = (equity[-1] ** (1.0 / years) - 1.0) if years > 0 and equity[-1] > 0 else None

    step = max(1, len(curve) // MAX_POINTS)
    sampled = curve[::step]
    if sampled[-1]["d0"] != curve[-1]["d0"]:
        sampled.append(curve[-1])
    return {
        "equity": sampled,
        "entries": sum(len(items) for items in entries.values()) + skipped,
        "traded": sum(len(items) for items in entries.values()),
        "skipped": skipped,
        "metrics": {
            "days": len(daily),
            "total_return_pct": round(total_return * 100, 2),
            "annualised_pct": round(annualised * 100, 2) if annualised is not None else None,
            "max_drawdown_pct": round(mdd * 100, 2),
            "sharpe": round(mean / sd * math.sqrt(252), 2) if sd > 0 else None,
            "daily_win_rate": round(sum(1 for item in daily if item > 0) / len(daily) * 100, 2) if daily else None,
            "avg_positions": round(sum(active_counts) / len(active_counts), 1) if active_counts else 0,
            "idle_days": sum(1 for count in active_counts if count == 0),
            # 资金利用率：满仓 = top_k 个仓位 × 持有 horizon 天
            "capital_use_pct": round(
                sum(active_counts) / len(active_counts) / max(top_k * horizon, 1) * 100, 1
            ),
            "final_value": round(equity[-1], 4),
        },
    }


def simulate(conn: sqlite3.Connection, horizon: int = 10, top_k: int = DEFAULT_TOP_K,
             cost: Optional[float] = None) -> dict[str, Any]:
    """条件组 + 对照组各跑一遍同样的仓位规则，返回净值与指标。"""
    prefix, exec_caliber = _columns(conn, horizon)
    if not exec_caliber:
        # 老任务没有可执行口径：收盘价买入，成本按用户给的固定值
        cost = 0.0 if cost is None else cost
    signal = _simulate(_rows(conn, horizon, 0, prefix), horizon, top_k, cost)
    control = _simulate(_rows(conn, horizon, 1, prefix), horizon, top_k, cost)
    signal_metrics = signal.get("metrics") or {}
    control_metrics = control.get("metrics") or {}
    excess = None
    if signal_metrics.get("annualised_pct") is not None and control_metrics.get("annualised_pct") is not None:
        excess = round(signal_metrics["annualised_pct"] - control_metrics["annualised_pct"], 2)
    return {
        "config": {
            "top_k": top_k,
            "hold_days": horizon,
            "caliber": "exec" if exec_caliber else "close",
            "cost": "逐行真实成本" if cost is None and exec_caliber else (cost or 0.0),
        },
        "signal": {"equity": signal.get("equity") or [], "metrics": signal_metrics},
        "control": {"equity": control.get("equity") or [], "metrics": control_metrics},
        "annualised_excess_pp": excess,
        "traded": signal.get("traded", 0),
        "skipped": signal.get("skipped", 0),
    }
