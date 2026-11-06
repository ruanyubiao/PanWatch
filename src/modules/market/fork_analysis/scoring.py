"""条件评分（0–100）：把一条选股条件压成「一眼能看懂的分」。

评分规则（用户 2026-11-06 定，一句话能背下来）
------------------------------------------------

::

    分 = 50 + 5 × 超额下限(pp)      然后截到 0–100

* **50 分 = 和同日随机买入完全一样**，这是真正的零点。
* **每多 5 分 = 多 1 个百分点**；60 分 = 比随机好 2pp（及格），
  70 分 = 好 4pp，85 分 = 好 7pp，100 分 = 好 10pp 及以上封顶。
* 用**下限**而不是点估计：下限 = 超额 − 1.96 × Newey–West 标准误（滞后 = 持有期）。
  连续两天命中同一只股票时窗口重叠 29 天，在 NW 里只算一个独立片段 ——
  用户要的「把重叠问题考虑进去，结果直接给分数」就是这一行。

为什么不用「所有股票各打一分再平均」
------------------------------------
分数回答的是「照这个条件买一笔」的期望优势，所以是**每笔信号合并**的均值，
不是先给每只股票打分再平均（后者在命中数少的日子会被个别股票主导）。

为什么用最高收盘盈利而不是最高价
--------------------------------
盘中最高价要求卖在最高点，没人做得到；而且基准组 5 日内摸到买入价上方的概率
本来就 97%，这个指标测的是波动率不是选股能力。收盘口径允许为负 ——
整段都在亏时，最大值天生就是「亏最少的那一天」。

两段评分
--------
搜索段（训练集）和验算段（样本外）各算一次，公式相同。搜索段的分数天生偏高
（搜索就是在这上面挑的），所以要看的永远是**验算段**那个数。
"""

from __future__ import annotations

import math
from typing import Any, Optional, Sequence

#: 及格线：60 分 = 比随机好 2 个百分点。低于它不建议直接用于实盘。
PASS_SCORE = 60.0

#: 分数锚点：50 = 与随机买入相同
BASE = 50.0
#: 每 1pp 超额值多少分
PER_PP = 5.0

#: 硬门槛（不满足 → 最高 55 分，即「判不了，不能及格」）
MIN_EVENTS = 300
MIN_EFFECTIVE = 30
MIN_SIGNALS_PER_DAY = 0.5
STRESS_COST = 0.004

#: 个股档：一只股票几年也就几十次信号，门槛另算
STOCK_MIN_EVENTS = 8
STOCK_MIN_EFFECTIVE = 2
STOCK_CAP_8 = 75.0
STOCK_CAP_25 = 88.0

#: 评级（阈值按「分数 = 50 + 5pp」换算：60 = +2pp，70 = +4pp，85 = +7pp）
GRADES: tuple[tuple[float, str, str], ...] = (
    (85.0, "A", "优秀：超额大且稳，可以进实盘观察"),
    (70.0, "B", "良好：有超额、方向一致，小仓位可用"),
    (60.0, "C", "及格：比随机买入好 2pp 以上，可以拿去用"),
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
    """一个周期的超额下限（pp）。

    优先用调用方算好的 ``lower_pp``（Newey–West，或个股的 Wilson 下界）；
    只有点估计和 t 值时按 ``excess − z × |excess/t|`` 反推，宁可保守。
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
    """按超额点估计挑最优周期（明细展示用）。"""
    usable = [row for row in windows if row.get("excess_pp") is not None]
    if not usable:
        return None
    return max(usable, key=lambda row: float(row["excess_pp"]))


def best_horizon_by_lower(windows: Sequence[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """按下限挑最优周期（评分用这个：点估计高但样本小的周期不该赢）。"""
    scored = [(lower_bound(row), row) for row in windows]
    scored = [(value, row) for value, row in scored if value is not None]
    if not scored:
        return None
    return max(scored, key=lambda item: item[0])[1]


def score_from_lower(lower_pp: Optional[float]) -> Optional[float]:
    """用户那一条公式本身：50 + 5 × 下限，截到 0–100。"""
    if lower_pp is None:
        return None
    return round(_clip(BASE + PER_PP * float(lower_pp), 0.0, 100.0), 1)


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
        每个周期一行：``window / n / excess_pp / lower_pp(可选) / n_eff / expectancy``。
        新口径下 ``excess_pp`` 是「窗口内最高收盘盈利」的超额，不是胜率超额。
    events
        有效事件数（已剔除不可验证的）。
    days
        这段里有信号的交易日数（算「每天几个信号」用）。
    year_excess / layer_excess
        分年、分层面的超额，只进报告，不参与分数（分数只有一条公式）。
    stress_excess
        成本抬到 0.4% 后最优周期的超额，用来做硬门槛。
    reference
        另一段的评分结果；保留参数以兼容调用方，不再产生衰减惩罚
        （两段分数并排显示，高低一眼就能看出，不用再折算）。
    profile
        ``condition``（整条条件）或 ``stock``（单只股票，门槛另算）。
    """
    if not windows:
        return {
            "score": None, "grade": "-", "grade_text": "没有可评分的周期",
            "components": {}, "caps": ["没有周期数据"], "best_window": None,
            "lower_pp": None, "excess_pp": None, "n_eff": None,
            "events": events, "days": days,
        }

    best = best_horizon_by_lower(windows) or best_horizon(windows)
    if best is None:
        # 没有对照组（或所有周期都没有超额数字）时不打分：
        # 单独一个「胜率 47%」没有参照系，给多少分都是编的。
        return {
            "score": None, "grade": "-", "grade_text": "没有对照组，无法评分",
            "components": {}, "caps": ["缺少同日基准"], "best_window": None,
            "lower_pp": None, "excess_pp": None, "n_eff": None,
            "events": events, "days": days,
        }
    lower = lower_bound(best)
    excess = best.get("excess_pp")
    n_eff = best.get("n_eff")

    caps: list[str] = []
    score = score_from_lower(lower)
    if score is None:
        score = BASE

    # ---- 硬门槛：不满足就封顶 55（「判不了」，而不是「略差一点」）
    cap = 100.0
    if profile == "stock":
        if events < STOCK_MIN_EVENTS:
            cap = min(cap, STOCK_CAP_8)
            caps.append(f"个股有效样本 {events} 笔 < {STOCK_MIN_EVENTS}，不足以评分")
        elif events < 15:
            cap = min(cap, STOCK_CAP_8)
            caps.append(f"个股有效样本 {events} 笔 < 15，最高 {STOCK_CAP_8:.0f} 分")
        elif events < 25:
            cap = min(cap, STOCK_CAP_25)
            caps.append(f"个股有效样本 {events} 笔 < 25，最高 {STOCK_CAP_25:.0f} 分")
        if n_eff is not None and n_eff < STOCK_MIN_EFFECTIVE:
            cap = min(cap, STOCK_CAP_8)
            caps.append(f"个股独立片段 {n_eff} < {STOCK_MIN_EFFECTIVE}")
    else:
        if events < MIN_EVENTS:
            cap = min(cap, PASS_SCORE - 5)
            caps.append(f"有效样本 {events} 笔 < {MIN_EVENTS}")
        if n_eff is not None and n_eff < MIN_EFFECTIVE:
            cap = min(cap, PASS_SCORE - 5)
            caps.append(f"独立片段 {n_eff} < {MIN_EFFECTIVE}（重叠窗口太多）")
        if days and events / max(1, days) < MIN_SIGNALS_PER_DAY:
            cap = min(cap, PASS_SCORE - 5)
            caps.append("平均每天不足 0.5 个信号，实际挑不出来")
    if stress_excess is not None and stress_excess < 0:
        cap = min(cap, PASS_SCORE - 5)
        caps.append("成本升到 0.4% 后超额转负")
    expectancy = best.get("expectancy")
    if expectancy is not None and expectancy < 0:
        cap = min(cap, PASS_SCORE - 5)
        caps.append("平均最高盈利为负（买进去平均是亏的）")

    score = round(_clip(score, 0.0, cap), 1)
    letter, text = grade_of(score)
    return {
        "score": score,
        "grade": letter,
        "grade_text": text,
        "components": {
            "base": BASE,
            "edge": round(PER_PP * float(lower), 1) if lower is not None else 0.0,
            "cap": cap if cap < 100.0 else None,
        },
        "caps": caps,
        "best_window": best.get("window"),
        "lower_pp": None if lower is None else round(lower, 2),
        "excess_pp": None if excess is None else round(float(excess), 2),
        "n_eff": n_eff,
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
        "text": ("只有一个分析段：结论只看这一段的分数，没有样本外校验"
                 if second is None else "只有测试段"),
    }
