"""交易成本模型：扁平 0.2% 会美化最不该美化的区间。

为什么不能只用一个数
--------------------
这个条件的历史正超额集中在「成交额 < 0.5 亿」的微盘股上 —— 恰恰是 0.2% 往返
成本最不现实的那一段。真实成本至少包括：

- 佣金：双边各万 2.5（0.025%）；
- 印花税：卖出单边。2023-08-28 起由 0.1% 减半到 0.05%，所以**按日期分段**；
- 滑点／冲击成本：按当日成交额分档。20 亿以上 0.05%，0.5 亿以下 0.4%——
  微盘的买卖价差与冲击成本就是这个量级，不是保守假设。

于是同一个条件在不同成本假设下会给出不同结论。报告里一律并排给出四档：
0.2%（旧口径，便于和历史数字对比）、逐行真实成本、0.4%、0.8%。如果结论只在
0.2% 那一档成立，那本身就是最重要的结论。
"""

from __future__ import annotations

import datetime as _dt
from typing import Any, Optional

#: 单边佣金（万 2.5）
COMMISSION = 0.00025

#: 卖出印花税：2023-08-28 之前 0.1%，之后 0.05%
STAMP_BEFORE = 0.0010
STAMP_AFTER = 0.0005
STAMP_CUT = _dt.date(2023, 8, 28)

#: 滑点（单边）分档：(当日成交额下界亿元, 单边滑点)
SLIPPAGE_TIERS: tuple[tuple[float, float], ...] = (
    (20.0, 0.0005),
    (5.0, 0.0008),
    (2.0, 0.0012),
    (0.5, 0.0020),
    (0.0, 0.0040),
)

#: 成交额缺失时用的单边滑点（落在 2–5 亿那一档，即中位水平）
SLIPPAGE_UNKNOWN = 0.0012

#: 四档敏感性假设：名字 → 往返成本（None = 逐行真实成本）
LEVELS: tuple[tuple[str, Optional[float]], ...] = (
    ("base", 0.002),
    ("realistic", None),
    ("double", 0.004),
    ("heavy", 0.008),
)

#: 逐行真实成本的 SQL 表达式（列名与 signals 表一致）
def cost_sql(d0_col: str = "d0", amount_col: str = "amount") -> str:
    """逐行真实往返成本，可直接拼进 SQL（乘在涨幅上）。"""
    amount = f"COALESCE({amount_col}, -1)"
    slip = (
        "CASE "
        + " ".join(f"WHEN {amount} >= {edge} THEN {value} " for edge, value in SLIPPAGE_TIERS[:-1])
        + f"WHEN {amount} >= 0 THEN {SLIPPAGE_TIERS[-1][1]} "
        + f"ELSE {SLIPPAGE_UNKNOWN} END"
    )
    stamp = f"CASE WHEN {d0_col} < '{STAMP_CUT.isoformat()}' THEN {STAMP_BEFORE} ELSE {STAMP_AFTER} END"
    return f"({2 * COMMISSION} + {stamp} + 2 * ({slip}))"


def slippage_one_way(amount_yi: Optional[float]) -> float:
    if amount_yi is None or amount_yi < 0:
        return SLIPPAGE_UNKNOWN
    for edge, value in SLIPPAGE_TIERS[:-1]:
        if amount_yi >= edge:
            return value
    return SLIPPAGE_TIERS[-1][1]


def stamp(d0: Any) -> float:
    if isinstance(d0, str):
        try:
            d0 = _dt.date.fromisoformat(d0[:10])
        except ValueError:
            return STAMP_AFTER
    if isinstance(d0, _dt.datetime):
        d0 = d0.date()
    if isinstance(d0, _dt.date) and d0 < STAMP_CUT:
        return STAMP_BEFORE
    return STAMP_AFTER


def realistic_cost(d0: Any = None, amount_yi: Optional[float] = None) -> float:
    """逐行真实往返成本（小数，0.0055 = 0.55%）。"""
    return round(2 * COMMISSION + stamp(d0) + 2 * slippage_one_way(amount_yi), 6)


def level_cost(name: str) -> Optional[float]:
    for key, value in LEVELS:
        if key == name:
            return value
    raise KeyError(f"未知成本档位：{name}")


def describe() -> list[dict[str, Any]]:
    """给报告用：每档成本的说明。"""
    return [
        {"key": "base", "cost": 0.002, "label": "0.2%（旧口径）"},
        {"key": "realistic", "cost": None, "label": "逐行真实（按成交额+印花税分段）"},
        {"key": "double", "cost": 0.004, "label": "0.4%"},
        {"key": "heavy", "cost": 0.008, "label": "0.8%（微盘压力测试）"},
    ]
