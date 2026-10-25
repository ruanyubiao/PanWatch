"""条件推理的「变异空间」：从基础条件出发，能往哪些方向调整。

三条设计约束
------------
1. **基础条件不动**：所有变体都是「基础条件 AND 若干补充条件」，基础条件树的
   结构永远原样保留（只允许调它自己的数值参数，比如「连续 4 天阳线」→ 3/5 天）。
   用户 2026-10-24：「先给你一个基础条件……在这个条件基础上进行条件的其他条件的补充」。
2. **每一个变体都必须能被 ``fork_screen`` 接受**：构造完先用
   ``ScreenRequest`` + ``validate_params`` + ``validate_rule`` 走一遍，不合法就丢弃。
   变异空间自己不做边界判断 —— 两套边界一定会打架，最后表现为「搜索出来的条件
   点开报错」。
3. **可复现**：随机数全部来自 ``random.Random(seed)``，同一个种子跑出同一串变体，
   这样「上次那个 62% 的条件」能重放出来。

补充条件只挑**有经济含义、能在日线上算、并且不依赖外部数据**的那些：均线排列、
站上均线、金叉、涨幅区间、换手率、量比、成交额、总市值、创新高、连续上涨、
阳线多于阴线。代码/名称这类身份条件不进空间（那不是「条件优化」，是把条件改成
只买某一只股票，搜出来必然过拟合）。
"""

from __future__ import annotations

import copy
import json
import random
from dataclasses import dataclass
from typing import Any, Iterable, Optional

#: 条件名 → 中文标签（界面上的条件描述用它拼句子）
LABELS: dict[str, str] = {
    "consecutive_bullish": "连续阳线",
    "consecutive_rising": "连续上涨",
    "consecutive_falling": "连续下跌",
    "more_bullish_candles": "阳线多于阴线",
    "more_bearish_candles": "阴线多于阳线",
    "ma_bullish": "均线多头",
    "ma_bullish_all": "均线多头(每日)",
    "ma_bullish_any": "均线多头(任一天)",
    "ma_bearish": "均线空头",
    "close_above_ma": "收盘站上均线",
    "close_above_ma_all": "收盘站上均线(每日)",
    "close_above_ma_any": "收盘站上均线(任一天)",
    "ma_golden_cross": "均线金叉",
    "ma_golden_cross_any": "均线金叉(任一天)",
    "ma_dead_cross": "均线死叉",
    "change_pct": "涨跌幅区间",
    "change_pct_all": "每日涨跌幅均在区间",
    "change_pct_span": "累计涨跌幅区间",
    "turnover_single": "换手率区间",
    "turnover_span": "平均换手率区间",
    "volume_single": "成交量区间",
    "amount_single": "成交额区间",
    "amount_span": "平均成交额区间",
    "vol_ratio_single": "量比区间",
    "vol_ratio_avg": "平均量比区间",
    "vol_ratio_consecutive": "连续放量",
    "consecutive_shrinking": "连续缩量",
    "market_cap": "总市值阈值",
    "market_cap_single": "总市值区间",
    "new_high": "创阶段新高",
    "new_low": "创阶段新低",
}


@dataclass(frozen=True)
class FilterTemplate:
    """一个可补充的条件模板。``grid`` 是允许的取值组合（每次补一个）。"""

    name: str
    label: str
    grid: tuple[dict[str, Any], ...]

    def sample(self, rng: random.Random) -> dict[str, Any]:
        return copy.deepcopy(rng.choice(self.grid))


#: 可补充的条件池。参数单位与 ``fork_screen.conditions`` 一致：
#: 成交额 / 市值 = 亿元，换手率 = 百分数，量比 = 倍数。
#:
#: 2026-10-25 扩容（用户第 1 条）：上一轮 1000 次在 873 次就把空间穷举完了，
#: 说明「19 个模板 + ±1 步长」的组合数不够。这里补到 28 个模板，并加入
#: 「范围内每日 / 任一天」这类跨多日的形态、累计涨跌幅、连续缩量 / 放量、
#: 市值区间 —— 它们与单日条件的经济含义不同（一个看状态，一个看过程）。
FILTER_TEMPLATES: tuple[FilterTemplate, ...] = (
    FilterTemplate("ma_bullish", "均线多头排列", (
        {"periods": [5, 10], "n": 1, "m": 1},
        {"periods": [5, 10, 20], "n": 1, "m": 1},
        {"periods": [5, 10, 20, 60], "n": 1, "m": 1},
        {"periods": [10, 20, 60], "n": 1, "m": 1},
        {"periods": [5, 10, 20], "n": 1, "m": 3},
    )),
    FilterTemplate("ma_bullish_all", "均线多头排列(区间每日)", (
        {"periods": [5, 10, 20], "n": 1, "m": 3},
        {"periods": [5, 10, 20], "n": 1, "m": 5},
        {"periods": [5, 10], "n": 1, "m": 5},
    )),
    FilterTemplate("ma_bullish_any", "均线多头排列(区间任一天)", (
        {"periods": [5, 10, 20], "n": 1, "m": 5},
        {"periods": [5, 10, 20], "n": 1, "m": 10},
        {"periods": [5, 10], "n": 1, "m": 10},
    )),
    FilterTemplate("ma_bearish", "均线空头排列", (
        {"periods": [5, 10], "n": 1, "m": 1},
        {"periods": [5, 10, 20], "n": 1, "m": 1},
        {"periods": [10, 20, 60], "n": 1, "m": 1},
    )),
    FilterTemplate("close_above_ma", "收盘站上均线", (
        {"period": 5, "n": 1, "m": 1},
        {"period": 10, "n": 1, "m": 1},
        {"period": 20, "n": 1, "m": 1},
        {"period": 30, "n": 1, "m": 1},
        {"period": 60, "n": 1, "m": 1},
        {"period": 20, "n": 1, "m": 5},
    )),
    FilterTemplate("close_above_ma_all", "收盘站上均线(区间每日)", (
        {"period": 10, "n": 1, "m": 3},
        {"period": 20, "n": 1, "m": 5},
    )),
    FilterTemplate("ma_golden_cross", "均线金叉", (
        {"fast": 5, "slow": 20, "n": 1, "m": 1},
        {"fast": 5, "slow": 60, "n": 1, "m": 1},
        {"fast": 10, "slow": 20, "n": 2, "m": 1},
        {"fast": 5, "slow": 10, "n": 3, "m": 1},
    )),
    FilterTemplate("ma_golden_cross_any", "均线金叉(区间任一天)", (
        {"fast": 5, "slow": 10, "n": 1, "m": 5},
        {"fast": 5, "slow": 20, "n": 1, "m": 10},
        {"fast": 10, "slow": 20, "n": 1, "m": 10},
    )),
    FilterTemplate("ma_dead_cross", "均线死叉", (
        {"fast": 5, "slow": 20, "n": 1, "m": 1},
        {"fast": 10, "slow": 20, "n": 2, "m": 1},
    )),
    FilterTemplate("change_pct", "涨跌幅区间", (
        {"n": 1, "min": 0.0, "max": 9.9},
        {"n": 1, "min": 1.0, "max": 9.9},
        {"n": 1, "min": 2.0, "max": 9.9},
        {"n": 1, "min": 3.0, "max": 9.9},
        {"n": 1, "min": 4.5, "max": 9.9},
        {"n": 1, "min": -9.9, "max": -2.0},
        {"n": 1, "min": -5.0, "max": -0.5},
        {"n": 1, "min": -2.0, "max": 2.0},
        {"n": 1, "min": -1.0, "max": 1.0},
    )),
    FilterTemplate("change_pct_span", "累计涨跌幅区间", (
        {"n": 1, "m": 3, "min": 0.0, "max": 15.0, "window": 5},
        {"n": 1, "m": 3, "min": -15.0, "max": 0.0, "window": 5},
        {"n": 1, "m": 5, "min": 0.0, "max": 20.0, "window": 5},
        {"n": 1, "m": 10, "min": 0.0, "max": 30.0, "window": 10},
        {"n": 1, "m": 10, "min": -30.0, "max": 0.0, "window": 10},
    )),
    FilterTemplate("change_pct_all", "每日涨跌幅均在区间", (
        {"n": 1, "m": 3, "min": -3.0, "max": 3.0, "window": 5},
        {"n": 1, "m": 5, "min": -5.0, "max": 5.0, "window": 5},
        {"n": 1, "m": 3, "min": -1.0, "max": 5.0, "window": 5},
    )),
    FilterTemplate("turnover_single", "换手率区间", (
        {"n": 1, "min": 1.0, "max": 5.0},
        {"n": 1, "min": 2.0, "max": 8.0},
        {"n": 1, "min": 3.0, "max": 15.0},
        {"n": 1, "min": 4.5, "max": 12.0},
        {"n": 1, "min": 5.0, "max": 20.0},
        {"n": 1, "min": 0.0, "max": 2.0},
        {"n": 1, "min": 0.0, "max": 1.0},
    )),
    FilterTemplate("turnover_span", "平均换手率区间", (
        {"n": 1, "m": 5, "min": 1.0, "max": 8.0, "window": 5},
        {"n": 1, "m": 5, "min": 0.0, "max": 3.0, "window": 5},
        {"n": 1, "m": 10, "min": 2.0, "max": 10.0, "window": 10},
    )),
    FilterTemplate("volume_single", "成交量区间(万手)", (
        {"n": 1, "min": 2.0, "max": 100000.0},
        {"n": 1, "min": 5.0, "max": 100000.0},
        {"n": 1, "min": 10.0, "max": 100000.0},
        {"n": 1, "min": 0.0, "max": 5.0},
    )),
    FilterTemplate("vol_ratio_single", "量比区间", (
        {"n": 1, "min": 1.0, "max": 2.0, "window": 5},
        {"n": 1, "min": 1.2, "max": 3.0, "window": 5},
        {"n": 1, "min": 1.5, "max": 5.0, "window": 5},
        {"n": 1, "min": 2.0, "max": 10.0, "window": 5},
        {"n": 1, "min": 0.0, "max": 0.8, "window": 5},
        {"n": 1, "min": 0.5, "max": 1.5, "window": 10},
    )),
    FilterTemplate("vol_ratio_avg", "平均量比区间", (
        {"n": 1, "m": 5, "min": 1.0, "max": 10.0, "window": 5},
        {"n": 1, "m": 5, "min": 0.0, "max": 1.0, "window": 5},
        {"n": 1, "m": 10, "min": 1.2, "max": 10.0, "window": 10},
    )),
    FilterTemplate("vol_ratio_consecutive", "连续放量", (
        {"start": 1, "days": 2, "min": 1.0, "max": 10.0, "window": 5},
        {"start": 1, "days": 3, "min": 1.2, "max": 10.0, "window": 5},
    )),
    FilterTemplate("consecutive_shrinking", "连续缩量", (
        {"start": 1, "days": 2, "min": 0.0, "max": 1.0, "window": 5},
        {"start": 1, "days": 3, "min": 0.0, "max": 1.0, "window": 5},
    )),
    FilterTemplate("amount_single", "成交额区间", (
        {"n": 1, "min": 0.5, "max": 100.0},
        {"n": 1, "min": 1.0, "max": 100.0},
        {"n": 1, "min": 2.0, "max": 100.0},
        {"n": 1, "min": 5.0, "max": 100.0},
        {"n": 1, "min": 10.0, "max": 500.0},
        {"n": 1, "min": 0.0, "max": 2.0},
    )),
    FilterTemplate("amount_span", "平均成交额区间", (
        {"n": 1, "m": 5, "min": 1.0, "max": 100.0, "window": 5},
        {"n": 1, "m": 5, "min": 5.0, "max": 500.0, "window": 5},
    )),
    FilterTemplate("market_cap", "总市值阈值", (
        {"op": "gte", "value": 20.0, "n": 1},
        {"op": "gte", "value": 30.0, "n": 1},
        {"op": "gte", "value": 50.0, "n": 1},
        {"op": "gte", "value": 100.0, "n": 1},
        {"op": "lte", "value": 100.0, "n": 1},
        {"op": "lte", "value": 50.0, "n": 1},
        {"op": "lte", "value": 30.0, "n": 1},
    )),
    FilterTemplate("market_cap_single", "总市值区间", (
        {"n": 1, "min": 20.0, "max": 50.0, "window": 5},
        {"n": 1, "min": 30.0, "max": 100.0, "window": 5},
        {"n": 1, "min": 50.0, "max": 200.0, "window": 5},
        {"n": 1, "min": 100.0, "max": 500.0, "window": 5},
        {"n": 1, "min": 200.0, "max": 1000000.0, "window": 5},
    )),
    # 回看天数受统计窗口约束（后端 _validate_lookback：m ≤ 统计窗口），
    # 所以这里最大只放到 30 —— 用户的条件都是 30 天窗口，60/120/250 会被判不合法。
    FilterTemplate("new_high", "创阶段新高", (
        {"m": 5, "n": 1},
        {"m": 10, "n": 1},
        {"m": 20, "n": 1},
        {"m": 30, "n": 1},
    )),
    FilterTemplate("new_low", "创阶段新低", (
        {"m": 10, "n": 1},
        {"m": 20, "n": 1},
        {"m": 30, "n": 1},
    )),
    FilterTemplate("consecutive_rising", "连续上涨", (
        {"start": 1, "days": 2},
        {"start": 1, "days": 3},
        {"start": 1, "days": 4},
    )),
    FilterTemplate("consecutive_falling", "连续下跌", (
        {"start": 1, "days": 2},
        {"start": 1, "days": 3},
    )),
    FilterTemplate("more_bullish_candles", "阳线多于阴线", (
        {"n": 1, "m": 3},
        {"n": 1, "m": 5},
        {"n": 1, "m": 10},
        {"n": 1, "m": 20},
    )),
    FilterTemplate("more_bearish_candles", "阴线多于阳线", (
        {"n": 1, "m": 3},
        {"n": 1, "m": 5},
        {"n": 1, "m": 10},
    )),
)

#: 基础条件候选池（用户第 1 条「允许替换基础条件」）。
#:
#: 只放「本身就是一个完整选股思路」的单条件，不放量价过滤 —— 那是补充条件
#: 的活。替换时把基础条件树里的**某一个**条件节点换成这里的条目，树的其余
#: 部分（用户自己加的条件、AND/OR 结构）原样保留。
BASE_POOL: tuple[dict[str, Any], ...] = (
    {"name": "more_bullish_candles", "params": {"n": 1, "m": 0}},
    {"name": "more_bullish_candles", "params": {"n": 1, "m": 5}},
    {"name": "more_bullish_candles", "params": {"n": 1, "m": 10}},
    {"name": "consecutive_bullish", "params": {"start": 1, "days": 2}},
    {"name": "consecutive_bullish", "params": {"start": 1, "days": 3}},
    {"name": "consecutive_bullish", "params": {"start": 1, "days": 4}},
    {"name": "consecutive_rising", "params": {"start": 1, "days": 2}},
    {"name": "consecutive_rising", "params": {"start": 1, "days": 3}},
    {"name": "consecutive_falling", "params": {"start": 1, "days": 2}},
    {"name": "ma_bullish", "params": {"periods": [5, 10, 20], "n": 1, "m": 1}},
    {"name": "ma_golden_cross", "params": {"fast": 5, "slow": 20, "n": 1, "m": 1}},
    {"name": "close_above_ma", "params": {"period": 20, "n": 1, "m": 1}},
    {"name": "new_high", "params": {"m": 10, "n": 1}},
    {"name": "new_high", "params": {"m": 20, "n": 1}},
    {"name": "vol_ratio_single", "params": {"n": 1, "min": 1.5, "max": 5.0, "window": 5}},
    {"name": "change_pct", "params": {"n": 1, "min": 2.0, "max": 9.9}},
)

_BY_NAME: dict[str, FilterTemplate] = {template.name: template for template in FILTER_TEMPLATES}

#: 数值参数的单步调整幅度（按参数名）。
#:
#: 2026-10-25 用户第 1 条「参数步长按 0.5」：百分数 / 市值这类连续量用 0.5 步长
#: （上一轮 ±1 让搜索只能在整数格点上跳，8.9 ↔ 7.9 这种没有中间态）；
#: 天 / 周期这类**必须**是整数的参数仍按 1 步，否则会被判参数不合法。
_STEP: dict[str, float] = {
    "min": 0.5,
    "max": 0.5,
    "value": 5.0,  # 只有「总市值阈值」用它：以亿为单位，0.5 亿的差别在选股结果上等价
    "period": 5.0,
    "fast": 5.0,
    "slow": 5.0,
}

#: 必须是整数的参数名（步长 1、下限 1）。
_INT_KEYS = frozenset({"start", "days", "n", "m", "period", "fast", "slow", "window"})

#: 保留 1 位小数的参数（百分数 / 市值 / 倍数）。
_ROUND1_KEYS = frozenset({"min", "max", "value"})


def _condition_keys(rule: Any) -> set[str]:
    """规则里已有的「条件名 + 参数」组合（去重用）。

    既要吃 pydantic 节点（``ScreenRequest.rule``），也要吃普通 dict
    （``meta["base_rule"]`` 是 model_dump 出来的），所以都用取值函数读。
    """
    keys: set[str] = set()

    def type_of(node: Any) -> str:
        return node.get("type", "") if isinstance(node, dict) else getattr(node, "type", "")

    def children_of(node: Any) -> list[Any]:
        if isinstance(node, dict):
            return list(node.get("children") or [])
        return list(getattr(node, "children", []) or [])

    def name_of(node: Any) -> str:
        return node.get("name", "") if isinstance(node, dict) else getattr(node, "name", "")

    def params_of(node: Any) -> dict[str, Any]:
        raw = node.get("params") if isinstance(node, dict) else getattr(node, "params", {})
        return dict(raw or {})

    def walk(node: Any) -> None:
        if type_of(node) == "condition":
            keys.add(f"{name_of(node)}|{canonical(params_of(node))}")
        else:
            for child in children_of(node):
                walk(child)

    walk(rule)
    return keys


def base_names(rule: Any) -> set[str]:
    """基础条件树里出现的条件名（不用参数区分）。"""
    names: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "condition":
                names.add(str(node.get("name") or ""))
            for child in node.get("children") or []:
                walk(child)
        else:
            if getattr(node, "type", "") == "condition":
                names.add(str(getattr(node, "name", "")))
            for child in getattr(node, "children", []) or []:
                walk(child)

    walk(rule)
    return names


def make_rule(base: dict[str, Any], filters: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """基础条件 + 补充条件 → 一个 AND 组（基础条件作为子节点原样嵌入）。

    与基础条件**同名**的补充条件一律丢掉（用户 2026-10-25 第 4 条：结果里出现过
    「0日内阳线多于阴线 ＋ …… ＋ 6日内阳线多于阴线」，同一个判据写了两遍）。
    同名不同参也是空操作：A(窗口 5) AND A(窗口 6) 等价于 A(窗口 6)，只会让描述变长、
    白占搜索预算。
    """
    children = [copy.deepcopy(base)]
    for item in effective_filters(base, filters):
        children.append({
            "type": "condition",
            "name": item["name"],
            "params": copy.deepcopy(item.get("params") or {}),
        })
    return {"type": "group", "operator": "AND", "children": children}


def effective_filters(base: Any, filters: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """真正会被 AND 进去的补充条件（去掉与基础条件同名 / 同参的）。

    ``make_rule`` 和 ``describe_tree`` 都走这一份 —— 否则描述里会出现已经被丢掉的
    条件，出现「描述写了两条阳线多于阴线、实际只算一条」这种前后不一致。
    """
    seen_names = base_names(base)
    seen = _condition_keys(base)
    kept: list[dict[str, Any]] = []
    for item in filters:
        name = str(item.get("name") or "")
        key = f"{name}|{canonical(item.get('params') or {})}"
        if name in seen_names or key in seen:
            continue
        seen_names.add(name)
        seen.add(key)
        kept.append(item)
    return kept


def canonical(rule: dict[str, Any]) -> str:
    """变体的唯一键（用来去重）。"""
    return json.dumps(rule, ensure_ascii=False, sort_keys=True)


def _fmt(value: Any) -> str:
    if isinstance(value, float):
        text = f"{value:g}"
        return text
    if isinstance(value, list):
        return "/".join(str(item) for item in value)
    return str(value)


def _span_label(params: dict[str, Any], trading_days: Optional[int] = None) -> str:
    """区间（倒数第 F ～ N 日，F 更早、N 更近）。**F=0 是「窗口最后一天」的哨兵**，
    不是「0 日」—— 上一轮结果里那条「0日内阳线多于阴线」就是把这个哨兵当成天数
    打印出来的。知道统计窗口时就写成「倒数第30～1日」，不知道时才退回「整个窗口」。
    """
    n = int(params.get("n") or 1)
    m = int(params.get("m") or 0)
    if m <= 0:
        window = int(trading_days or 0)
        if window > 0:
            m = window
        else:
            return f"整个统计窗口（倒数第{n}日～窗口末）"
    if m == n:
        return f"倒数第{n}日"
    return f"倒数第{m}～{n}日"


def describe_condition(name: str, params: dict[str, Any],
                       trading_days: Optional[int] = None) -> str:
    """一个条件的中文短句（界面排行榜里给它看的）。

    日期范围一律写成「倒数第 F～N 日」（F 更早、N 更近），与条件选股界面同一套写法。
    """
    label = LABELS.get(name, name)
    if name in ("consecutive_bullish", "consecutive_rising", "consecutive_falling"):
        return f"{label}{_fmt(params.get('days', 4))}天"
    if name in ("ma_bullish", "ma_bearish", "ma_bullish_all", "ma_bullish_any"):
        suffix = ""
        if name.endswith("_all") or name.endswith("_any"):
            suffix = f" · {_span_label(params, trading_days)}"
        return f"{label}({_fmt(params.get('periods', []))}){suffix}"
    if name in ("close_above_ma", "close_above_ma_all", "close_above_ma_any"):
        suffix = ""
        if name.endswith("_all") or name.endswith("_any"):
            suffix = f" · {_span_label(params, trading_days)}"
        return f"{label}MA{_fmt(params.get('period', 20))}{suffix}"
    if name in ("ma_golden_cross", "ma_dead_cross", "ma_golden_cross_any"):
        suffix = f" · {_span_label(params, trading_days)}" if name.endswith("_any") else ""
        return f"{label}MA{_fmt(params.get('fast', 5))}/MA{_fmt(params.get('slow', 20))}{suffix}"
    if name in ("change_pct", "turnover_single"):
        return f"{label}{_fmt(params.get('min'))}%~{_fmt(params.get('max'))}%"
    if name in ("change_pct_all", "change_pct_span"):
        return f"{_span_label(params, trading_days)}{label}{_fmt(params.get('min'))}%~{_fmt(params.get('max'))}%"
    if name in ("turnover_span",):
        return f"{_span_label(params, trading_days)}{label}{_fmt(params.get('min'))}%~{_fmt(params.get('max'))}%"
    if name in ("vol_ratio_single", "vol_ratio_avg"):
        prefix = _span_label(params, trading_days) if name.endswith("_avg") else ""
        return f"{prefix}{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}倍"
    if name == "vol_ratio_consecutive":
        return f"连续{_fmt(params.get('days', 2))}日{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}倍"
    if name == "consecutive_shrinking":
        return f"连续{_fmt(params.get('days', 2))}日缩量"
    if name == "amount_single":
        return f"{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}亿"
    if name == "amount_span":
        return f"{_span_label(params, trading_days)}{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}亿"
    if name == "volume_single":
        return f"{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}万手"
    if name == "market_cap":
        op = "≥" if params.get("op") in ("gt", "gte") else "≤"
        return f"总市值{op}{_fmt(params.get('value'))}亿"
    if name == "market_cap_single":
        return f"总市值{_fmt(params.get('min'))}~{_fmt(params.get('max'))}亿"
    if name == "new_high":
        return f"创{_fmt(params.get('m', 60))}日新高"
    if name == "new_low":
        return f"创{_fmt(params.get('m', 20))}日新低"
    if name in ("more_bullish_candles", "more_bearish_candles"):
        return f"{_span_label(params, trading_days)}{label}"
    parts = " ".join(f"{key}={_fmt(value)}" for key, value in params.items())
    return f"{label}({parts})" if parts else label


def describe(base_summary: str, filters: list[dict[str, Any]]) -> str:
    """整套条件的描述：基础条件 + 补充条件清单。"""
    parts = [item for item in (describe_condition(item["name"], item.get("params") or {})
                               for item in filters) if item]
    if not parts:
        return base_summary
    return f"{base_summary} ＋ " + " ＋ ".join(parts)


def summarize_tree(node: Any, trading_days: Optional[int] = None) -> str:
    """基础条件树的中文描述（AND / OR 组都摊平，用「且」连接）。

    允许替换基础条件之后，基础条件不再是一个固定字符串 —— 每个变体的基础条件
    都可能不同，描述必须跟着变体走，否则排行榜上十个不同条件的描述会一模一样。
    """
    parts: list[str] = []

    def walk(current: Any) -> None:
        if isinstance(current, dict):
            if current.get("type") == "condition":
                parts.append(describe_condition(str(current.get("name") or ""),
                                                dict(current.get("params") or {}), trading_days))
                return
            for child in current.get("children") or []:
                walk(child)
        else:
            if getattr(current, "type", "") == "condition":
                parts.append(describe_condition(str(getattr(current, "name", "")),
                                                dict(getattr(current, "params", {}) or {}), trading_days))
                return
            for child in getattr(current, "children", []) or []:
                walk(child)

    walk(node)
    return " 且 ".join(parts) if parts else "（无条件）"


def describe_tree(tree: Any, filters: list[dict[str, Any]],
                  trading_days: Optional[int] = None) -> str:
    """变体的完整描述：这一变体自己的基础条件 ＋ 生效的补充条件。"""
    return describe(summarize_tree(tree, trading_days), effective_filters(tree, filters))


# --------------------------------------------------------------------------- #
# 三个变异算子
# --------------------------------------------------------------------------- #
def add_filter(filters: list[dict[str, Any]], rng: random.Random,
               excluded: Optional[Iterable[str]] = None) -> Optional[list[dict[str, Any]]]:
    """补一个还没用过的条件。

    ``excluded`` 是「基础条件树里已经有的条件名」——同名的不再补，否则结果描述里
    会出现两条一样的判据（用户 2026-10-25 第 4 条）。
    """
    used = {item["name"] for item in filters}
    used |= set(excluded or ())
    choices = [template for template in FILTER_TEMPLATES if template.name not in used]
    if not choices:
        return None
    template = rng.choice(choices)
    params = template.sample(rng)
    return list(filters) + [{"name": template.name, "params": params}]


def remove_filter(filters: list[dict[str, Any]], rng: random.Random) -> Optional[list[dict[str, Any]]]:
    """去掉一个补充条件（基础条件永远不会被去掉）。"""
    if not filters:
        return None
    rest = list(filters)
    rest.pop(rng.randrange(len(rest)))
    return rest


def jitter_params(name: str, params: dict[str, Any], rng: random.Random) -> Optional[dict[str, Any]]:
    """把一个条件的某个数值参数往上或往下调一步。

    连续参数（百分数区间）按 0.5 走并保留 1 位小数；整数参数（天数、周期）按 1 走
    并夹到 ≥1。市值阈值按 5 亿走 —— 0.5 亿的差别在选股结果上几乎等价，用 0.5
    只会把搜索预算浪费在「看起来不同、其实同一批股票」的变体上。
    """
    numeric = [key for key, value in params.items()
               if isinstance(value, (int, float)) and not isinstance(value, bool)]
    if not numeric:
        return None
    key = rng.choice(numeric)
    current = float(params[key])
    step = _STEP.get(key, 1.0)
    sign = 1.0 if rng.random() < 0.5 else -1.0

    def normalize(value: float) -> float:
        if key in _INT_KEYS:
            return max(1.0, round(value))
        if key in _ROUND1_KEYS:
            return round(value, 1)
        return round(value, 4)

    updated = normalize(current + sign * step)
    if updated == current:
        updated = normalize(current + step)
    changed = copy.deepcopy(params)
    changed[key] = int(updated) if isinstance(params[key], int) and float(updated).is_integer() else updated
    return changed


def jitter_filters(filters: list[dict[str, Any]], rng: random.Random) -> Optional[list[dict[str, Any]]]:
    """调某个补充条件的参数。"""
    if not filters:
        return None
    index = rng.randrange(len(filters))
    updated = jitter_params(filters[index]["name"], filters[index].get("params") or {}, rng)
    if updated is None:
        return None
    result = copy.deepcopy(filters)
    result[index]["params"] = updated
    return result


def jitter_tree(node: dict[str, Any], rng: random.Random) -> tuple[dict[str, Any], Optional[str]]:
    """调基础条件树里某个条件的数值参数。返回 ``(新树, 被调的参数名)``。

    只改数值参数，不改条件名、不改 AND/OR 结构 —— 那是「重新设计条件」，不是
    「在这个条件基础上优化」。
    """
    targets: list[tuple[dict[str, Any], str]] = []

    def walk(current: dict[str, Any]) -> None:
        if current.get("type") == "condition":
            for key, value in (current.get("params") or {}).items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    targets.append((current, key))
        else:
            for child in current.get("children") or []:
                walk(child)

    walk(node)
    if not targets:
        return copy.deepcopy(node), None
    condition, key = rng.choice(targets)
    params = condition.get("params") or {}
    updated = jitter_params(condition.get("name", ""), params, rng)
    if updated is None:
        return copy.deepcopy(node), None
    tree = copy.deepcopy(node)

    def apply(current: dict[str, Any]) -> bool:
        if current.get("type") == "condition":
            if current is not None and current.get("name") == condition.get("name") \
                    and (current.get("params") or {}) == params:
                current["params"] = updated
                return True
            return False
        for child in current.get("children") or []:
            if apply(child):
                return True
        return False

    apply(tree)
    return tree, key


def replace_condition(tree: dict[str, Any], rng: random.Random,
                      pool: Optional[Iterable[dict[str, Any]]] = None) -> tuple[dict[str, Any], Optional[str]]:
    """换掉基础条件树里的一个条件节点（用户 2026-10-25 第 1 条「允许替换基础条件」）。

    上一轮 873 次就把「19 个模板 + ±1 步长」的空间穷举完了，原因是基础条件被钉死，
    能做的只是往上堆过滤。放开这一步之后，「4 连阳」可以变成「均线多头」「创 20 日
    新高」「阳线多于阴线（5 日）」等其它起点，搜索才可能跳出同一片区域。

    只换**一个**条件节点、保留树结构：基础条件如果是「A AND B」，换掉 A 之后仍然是
    「A' AND B」，用户的其它条件不会凭空消失。返回 ``(新树, 新条件名)``。
    """
    entries = tuple(pool if pool is not None else BASE_POOL)
    paths: list[list[int]] = []

    def collect(node: dict[str, Any], path: list[int]) -> None:
        if node.get("type") == "condition":
            paths.append(path)
            return
        for index, child in enumerate(node.get("children") or []):
            collect(child, path + [index])

    collect(tree, [])
    if not paths:
        return copy.deepcopy(tree), None
    path = rng.choice(paths)

    def at(root: dict[str, Any], where: list[int]) -> dict[str, Any]:
        node = root
        for index in where:
            node = node["children"][index]
        return node

    current = at(tree, path)
    current_name = str(current.get("name") or "")
    current_params = dict(current.get("params") or {})
    choices = [entry for entry in entries
               if not (entry["name"] == current_name
                       and canonical(dict(entry.get("params") or {})) == canonical(current_params))]
    if not choices:
        return copy.deepcopy(tree), None
    picked = rng.choice(choices)
    updated = copy.deepcopy(tree)
    target = at(updated, path)
    target["name"] = picked["name"]
    target["params"] = copy.deepcopy(dict(picked.get("params") or {}))
    return updated, str(picked["name"])
