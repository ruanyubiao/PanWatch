"""条件评分（0–100）：把一个条件的统计结果压成「一眼能看懂的分」。

为什么要有这一层
----------------
用户 2026-10-24 的原话：*「你输出的一大堆数据，我是看不懂，所以加了评分系统…我看最终的评分，
这样可以直接一眼看出好不好」*。所以分数不是装饰，它必须满足三个条件：

1. **有锚点**：50 = 和随机买入完全一样；60 = 及格线（能拿去用、不亏）；
   85+ = 优秀。分数高低能直接对应「敢不敢用」，而不是一堆需要解释的 pp。
2. **保守**：只用**置信下界**算分，不用点估计。样本少、波动大的条件得不到高分
   —— 否则「命中 3 次全胜」会顶到 90 分，而它其实什么都不是。
3. **可复算**：每个分数都能由「下界 + 一致性 + 惩罚」三项还原，不存在黑箱。

评分公式（写死在这里，报告里逐项列出）
--------------------------------------
::

    分 = 50 + 优势分(0–40) + 稳健分(0–10) − 负超额扣分(0–20)
    然后按「样本/容量/成本/收益」四条硬门槛封顶

* 优势分 = 40 × clip(下界 / 8pp, 0, 1) ^ 0.85
  下界 2pp → 约 +12 分（62 分，及格）；下界 5pp → 约 +27 分（77 分，良好）；
  下界 8pp 及以上 → 满分 40。下界 ≤ 0 → 0 分。
* 稳健分：三个一致性各占一档（周期间 4 分、年度间 3 分、分层面 3 分），
  按「正超额的比例」给分 —— 只在某一个周期亮、某一年亮、某一类股票亮，
  都拿不到满分。
* 负超额扣分：最优周期仍然是负的时候按幅度扣（3pp → −12 分），
  这样「全程跑输」的条件会落到 40 分以下（明确不可用）。
* 硬门槛（封顶 55，即「不能及格」）：样本 < 300 笔；有效独立样本 < 30；
  平均每天不到 0.5 个信号（挑不出来）；成本升到 0.4% 后超额转负；
  期望收益为负。

两段式评分
----------
推理段（训练集）和测试段各算一次，公式相同。测试分另外加一条**衰减惩罚**：
测试段的下界比推理段低 5pp 以上时扣分（最多 8 分），因为那说明条件被训练段
「喂」出来的，换个时段就失效。两个分都过 60 才算真正可用。
"""

from __future__ import annotations

import math
from typing import Any, Callable, Optional, Sequence

#: 及格线：60 分。低于它一律不建议直接用于实盘。
PASS_SCORE = 60.0

#: 满分 100 的构成
BASE = 50.0
EDGE_MAX = 40.0
ROBUST_MAX = 10.0
NEG_MAX = 20.0

#: 优势分曲线的参考点：下界 8pp = 满分
EDGE_FULL_PP = 8.0
EDGE_CURVE_POWER = 0.85

#: 硬门槛（不满足 → 最高 55 分）
MIN_EVENTS = 300
MIN_EFFECTIVE = 30
MIN_SIGNALS_PER_DAY = 0.5
STRESS_COST = 0.004

#: 个股档（用户 2026-11-03 第 4 条）：一个条件可能只对某几只股票有效。
#: 个股样本天然少（一只股票几年也就几十次信号），所以门槛另算：
#: 8 次信号才能评分，15 次以下最高 75 分，25 次以下最高 88 分 ——
#: 5 战 5 胜不该拿到 100 分，但 20 次里赢 17 次确实可能是真信号。
STOCK_MIN_EVENTS = 8
STOCK_MIN_EFFECTIVE = 2
STOCK_CAP_8 = 75.0
STOCK_CAP_25 = 88.0

#: 评级
GRADES: tuple[tuple[float, str, str], ...] = (
    (85.0, "A", "优秀：超额大且稳，可以进实盘观察"),
    (70.0, "B", "良好：有超额、方向一致，小仓位可用"),
    (60.0, "C", "及格：勉强能用于特定场景，需盯盘"),
    (45.0, "D", "存疑：没有可确认的优势，不建议使用"),
    (0.0, "E", "不可用：显著跑输随机买入，应重做条件"),
)


def grade_of(score: Optional[float]) -> tuple[str, str]:
    """分数 → (等级, 一句话)。"""
    if score is None:
        return "-", "样本不足，无法评分"
    for floor, letter, text in GRADES:
        if score >= floor:
            return letter, text
    return "E", GRADES[-1][2]


def _clip(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def lower_bound(row: dict[str, Any], z: float = 1.96) -> Optional[float]:
    """一个周期的超额置信下界（pp）。没有 t 值时按 1/3 折减，宁可保守。

    显式给了 ``lower_pp`` 就直接用它：个股评分用 Wilson 下界（n 常常不到 20，
    正态近似会把「8 次里赢 7 次」算成一个过窄的区间）。
    """
    explicit = row.get("lower_pp")
    if explicit is not None:
        return float(explicit)
    excess = row.get("excess_pp")
    if excess is None:
        return None
    t = row.get("t")
    if t is None or not math.isfinite(float(t)) or abs(float(t)) < 1e-9:
        return float(excess) * 0.33
    se = abs(float(excess)) / abs(float(t))
    return float(excess) - z * se


def best_horizon(windows: Sequence[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """按超额点估计挑最优周期（与旧报告一致，便于对照）。"""
    usable = [row for row in windows if row.get("excess_pp") is not None]
    if not usable:
        return None
    return max(usable, key=lambda row: float(row["excess_pp"]))


def best_horizon_by_lower(windows: Sequence[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """按置信下界挑最优周期（评分用这个：点估计高但样本小的周期不该赢）。"""
    scored = [(lower_bound(row), row) for row in windows]
    scored = [(value, row) for value, row in scored if value is not None]
    if not scored:
        return None
    return max(scored, key=lambda item: item[0])[1]


def score_segment(
    *,
    windows: Sequence[dict[str, Any]],
    events: int,
    days: int,
    year_excess: Sequence[Optional[float]] = (),
    layer_excess: Sequence[Optional[float]] = (),
    stress_excess: Optional[float] = None,
    reference: Optional[dict[str, Any]] = None,
    profile: str = "condition",
) -> dict[str, Any]:
    """给一个时间段打分。

    参数
    ----
    windows
        每个周期一行：``window / n / excess_pp / t / expectancy / payoff``。
    events
        有效事件数（扣掉不可验证的）。
    days
        这段里「有信号」的交易日数（算每天信号数用）。
    year_excess / layer_excess
        分年、分层面的超额（pp），只用来算一致性，不参与优势分。
    stress_excess
        成本抬到 0.4% 后、最优周期的超额（pp）。缺省表示没算。
    reference
        另一段（推理段）的评分结果；给测试段打分时传进来算衰减惩罚。
    profile
        ``condition``（默认，整条条件）或 ``stock``（单只股票）。
        个股的样本规模小两个数量级，用条件的门槛会把所有个股都压到 55 分以下，
        所以两道门槛另算（见 ``STOCK_MIN_EVENTS`` / ``STOCK_CAP_*``）。
    """
    if not windows:
        return {
            "score": None, "grade": "-", "grade_text": "没有可评分的周期",
            "components": {}, "caps": ["没有周期数据"], "best_window": None,
            "lower_pp": None, "excess_pp": None, "events": events, "days": days,
        }

    best = best_horizon_by_lower(windows) or best_horizon(windows)
    if best is None:
        # 没有对照组（或所有周期都没有超额数字）时不打分：
        # 单独一个「胜率 47%」没有参照系，给多少分都是编的。
        return {
            "score": None, "grade": "-", "grade_text": "没有对照组，无法评分",
            "components": {}, "caps": ["缺少同日基准"], "best_window": None,
            "lower_pp": None, "excess_pp": None, "events": events, "days": days,
        }
    lower = lower_bound(best)
    excess = best.get("excess_pp")

    components: dict[str, Any] = {}
    caps: list[str] = []

    # ---- 优势分
    edge_points = 0.0
    if lower is not None and lower > 0:
        edge_points = EDGE_MAX * (min(1.0, lower / EDGE_FULL_PP) ** EDGE_CURVE_POWER)
    components["edge"] = round(edge_points, 1)

    # ---- 稳健分（三项一致性）
    def share(values: Sequence[Optional[float]]) -> Optional[float]:
        picked = [float(v) for v in values if v is not None]
        if not picked:
            return None
        return sum(1 for v in picked if v > 0) / len(picked)

    horizon_share = share([row.get("excess_pp") for row in windows])
    year_share = share(year_excess)
    layer_share = share(layer_excess)
    robust = 4.0 * (horizon_share or 0.0) + 3.0 * (year_share or 0.0) + 3.0 * (layer_share or 0.0)
    components["robust"] = round(robust, 1)
    components["horizon_share"] = round(horizon_share or 0.0, 3)
    components["year_share"] = round(year_share, 3) if year_share is not None else None
    components["layer_share"] = round(layer_share, 3) if layer_share is not None else None

    # ---- 负超额扣分
    negative = 0.0
    if excess is not None and excess < 0:
        negative = min(NEG_MAX, abs(float(excess)) * 4.0)
    components["negative"] = -round(negative, 1)

    score = BASE + edge_points + robust - negative

    # ---- 衰减惩罚（只对测试段）
    decay = 0.0
    if reference is not None and reference.get("lower_pp") is not None and lower is not None:
        drop = float(reference["lower_pp"]) - float(lower)
        if drop > 5.0:
            decay = min(8.0, (drop - 5.0) * 1.0)
    components["decay"] = -round(decay, 1)
    score -= decay

    # ---- 硬门槛
    cap = 100.0
    if profile == "stock":
        # 个股档：门槛按个股样本规模另算，且不要求「每天至少 0.5 个信号」
        # （一只股票一年命中的十几天根本凑不出这个数）。
        if events < STOCK_MIN_EVENTS:
            cap = min(cap, STOCK_CAP_8)
            caps.append(f"个股有效样本 {events} 笔 < {STOCK_MIN_EVENTS}，不足以评分")
        elif events < 15:
            cap = min(cap, STOCK_CAP_8)
            caps.append(f"个股有效样本 {events} 笔 < 15，最高 {STOCK_CAP_8:.0f} 分")
        elif events < 25:
            cap = min(cap, STOCK_CAP_25)
            caps.append(f"个股有效样本 {events} 笔 < 25，最高 {STOCK_CAP_25:.0f} 分")
        n_eff = best.get("n_eff")
        if n_eff is not None and n_eff < STOCK_MIN_EFFECTIVE:
            cap = min(cap, STOCK_CAP_8)
            caps.append(f"个股独立样本 {n_eff} < {STOCK_MIN_EFFECTIVE}")
    else:
        if events < MIN_EVENTS:
            cap = min(cap, PASS_SCORE - 5)
            caps.append(f"有效样本 {events} 笔 < {MIN_EVENTS}")
        n_eff = best.get("n_eff")
        if n_eff is not None and n_eff < MIN_EFFECTIVE:
            cap = min(cap, PASS_SCORE - 5)
            caps.append(f"独立样本 {n_eff} < {MIN_EFFECTIVE}（重叠窗口太多）")
        if days and events / max(1, days) < MIN_SIGNALS_PER_DAY:
            cap = min(cap, PASS_SCORE - 5)
            caps.append("平均每天不足 0.5 个信号，实际挑不出来")
    if stress_excess is not None and stress_excess < 0:
        cap = min(cap, PASS_SCORE - 5)
        caps.append("成本升到 0.4% 后超额转负")
    expectancy = best.get("expectancy")
    if expectancy is not None and expectancy < 0:
        cap = min(cap, PASS_SCORE - 5)
        caps.append("最优周期的期望收益为负（赢的次数多但亏得更重）")

    score = round(_clip(score, 0.0, cap), 1)
    letter, text = grade_of(score)
    return {
        "score": score,
        "grade": letter,
        "grade_text": text,
        "components": components,
        "caps": caps,
        "best_window": best.get("window"),
        "lower_pp": None if lower is None else round(lower, 2),
        "excess_pp": None if excess is None else round(float(excess), 2),
        "events": events,
        "days": days,
    }


def combined(analysis: dict[str, Any], validation: Optional[dict[str, Any]]) -> dict[str, Any]:
    """把两段评分合成一个「最终判断」。

    规则（简单到能背下来）：
    * 两段都 ≥ 60 → ``pass``：可以用。
    * 一段 ≥ 60、另一段 < 45 → ``fragile``：多半是过拟合或时段特殊。
    * 最高的一段 < 45 → ``fail``。
    * 其余 → ``watch``（观察区，别急着上）。
    """
    first = analysis.get("score")
    second = (validation or {}).get("score")
    if first is None and second is None:
        return {"verdict": "unknown", "score": None,
                "text": "两段都没有可评分的样本"}
    if first is not None and second is not None:
        low = min(first, second)
        if low >= PASS_SCORE:
            return {"verdict": "pass", "score": round((first + second) / 2, 1),
                    "text": f"两段都过及格线（{first} / {second}），可以用"}
        if max(first, second) >= PASS_SCORE and low < 45:
            return {"verdict": "fragile", "score": round(low, 1),
                    "text": f"只有一段过线（{first} / {second}），另一段失效，像过拟合"}
        if max(first, second) < 45:
            return {"verdict": "fail", "score": round(max(first, second), 1),
                    "text": f"两段都不及格（{first} / {second}），不可用"}
        return {"verdict": "watch", "score": round(min(first, second), 1),
                "text": f"有亮点但没到及格线（{first} / {second}），继续观察"}
    single = first if first is not None else second
    return {
        "verdict": "pass" if single is not None and single >= PASS_SCORE else "watch",
        "score": single,
        "text": "只跑了一段，结论只看这一段的分数" if second is None else "只有测试段",
    }
