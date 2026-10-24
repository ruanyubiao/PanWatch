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
    "ma_bearish": "均线空头",
    "close_above_ma": "收盘站上均线",
    "ma_golden_cross": "均线金叉",
    "ma_dead_cross": "均线死叉",
    "change_pct": "涨跌幅区间",
    "turnover_single": "换手率区间",
    "vol_ratio_single": "量比区间",
    "amount_single": "成交额区间",
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
FILTER_TEMPLATES: tuple[FilterTemplate, ...] = (
    FilterTemplate("ma_bullish", "均线多头排列", (
        {"periods": [5, 10], "n": 1, "m": 1},
        {"periods": [5, 10, 20], "n": 1, "m": 1},
        {"periods": [10, 20, 60], "n": 1, "m": 1},
    )),
    FilterTemplate("close_above_ma", "收盘站上均线", (
        {"period": 10, "n": 1, "m": 1},
        {"period": 20, "n": 1, "m": 1},
        {"period": 60, "n": 1, "m": 1},
    )),
    FilterTemplate("ma_golden_cross", "均线金叉", (
        {"fast": 5, "slow": 20, "n": 1, "m": 1},
        {"fast": 5, "slow": 60, "n": 1, "m": 1},
        {"fast": 10, "slow": 20, "n": 2, "m": 1},
        {"fast": 5, "slow": 10, "n": 3, "m": 1},
    )),
    FilterTemplate("change_pct", "涨跌幅区间", (
        {"n": 1, "min": 0.0, "max": 9.9},
        {"n": 1, "min": 1.0, "max": 9.9},
        {"n": 1, "min": 2.0, "max": 9.9},
        {"n": 1, "min": 3.0, "max": 9.9},
        {"n": 1, "min": -9.9, "max": -2.0},
        {"n": 1, "min": -2.0, "max": 2.0},
    )),
    FilterTemplate("turnover_single", "换手率区间", (
        {"n": 1, "min": 1.0, "max": 5.0},
        {"n": 1, "min": 2.0, "max": 8.0},
        {"n": 1, "min": 3.0, "max": 15.0},
        {"n": 1, "min": 5.0, "max": 20.0},
        {"n": 1, "min": 0.0, "max": 2.0},
    )),
    FilterTemplate("vol_ratio_single", "量比区间", (
        {"n": 1, "min": 1.0, "max": 2.0, "window": 5},
        {"n": 1, "min": 1.2, "max": 3.0, "window": 5},
        {"n": 1, "min": 1.5, "max": 5.0, "window": 5},
        {"n": 1, "min": 2.0, "max": 10.0, "window": 5},
        {"n": 1, "min": 0.0, "max": 0.8, "window": 5},
    )),
    FilterTemplate("amount_single", "成交额区间", (
        {"n": 1, "min": 0.5, "max": 100.0},
        {"n": 1, "min": 1.0, "max": 100.0},
        {"n": 1, "min": 2.0, "max": 100.0},
        {"n": 1, "min": 5.0, "max": 100.0},
        {"n": 1, "min": 0.0, "max": 2.0},
    )),
    FilterTemplate("market_cap", "总市值阈值", (
        {"op": "gte", "value": 20.0, "n": 1},
        {"op": "gte", "value": 30.0, "n": 1},
        {"op": "gte", "value": 50.0, "n": 1},
        {"op": "gte", "value": 100.0, "n": 1},
        {"op": "lte", "value": 100.0, "n": 1},
        {"op": "lte", "value": 50.0, "n": 1},
    )),
    FilterTemplate("new_high", "创阶段新高", (
        {"m": 20, "n": 1},
        {"m": 60, "n": 1},
        {"m": 120, "n": 1},
    )),
    FilterTemplate("consecutive_rising", "连续上涨", (
        {"start": 1, "days": 2},
        {"start": 1, "days": 3},
    )),
    FilterTemplate("more_bullish_candles", "阳线多于阴线", (
        {"n": 1, "m": 5},
        {"n": 1, "m": 10},
        {"n": 1, "m": 20},
    )),
)

_BY_NAME: dict[str, FilterTemplate] = {template.name: template for template in FILTER_TEMPLATES}

#: 数值参数的单步调整幅度（按参数名）。其余数值参数默认 ±1。
_STEP: dict[str, float] = {
    "min": 1.0,
    "max": 1.0,
    "value": 10.0,
    "period": 5.0,
    "fast": 5.0,
    "slow": 20.0,
}


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


def make_rule(base: dict[str, Any], filters: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """基础条件 + 补充条件 → 一个 AND 组（基础条件作为子节点原样嵌入）。

    与基础条件**同名同参**的补充条件是空操作（A AND A == A），直接丢掉：
    否则排行榜里会出现「＋ 连续上涨3天」在后面又重复一遍基础条件里的那一条，
    既让描述变长，也白占搜索预算。参数不同的同名条件（例如基础条件 5 日、
    补充 10 日）不算重复，照常保留。
    """
    seen = _condition_keys(base)
    children = [copy.deepcopy(base)]
    for item in filters:
        key = f"{item['name']}|{canonical(item.get('params') or {})}"
        if key in seen:
            continue
        seen.add(key)
        children.append({
            "type": "condition",
            "name": item["name"],
            "params": copy.deepcopy(item.get("params") or {}),
        })
    return {"type": "group", "operator": "AND", "children": children}


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


def describe_condition(name: str, params: dict[str, Any]) -> str:
    """一个条件的中文短句（界面排行榜里给它看的）。"""
    label = LABELS.get(name, name)
    if name in ("consecutive_bullish", "consecutive_rising", "consecutive_falling"):
        return f"{label}{_fmt(params.get('days', 4))}天"
    if name in ("ma_bullish", "ma_bearish"):
        return f"{label}({_fmt(params.get('periods', []))})"
    if name == "close_above_ma":
        return f"{label}MA{_fmt(params.get('period', 20))}"
    if name in ("ma_golden_cross", "ma_dead_cross"):
        return f"{label}MA{_fmt(params.get('fast', 5))}/MA{_fmt(params.get('slow', 20))}"
    if name == "change_pct":
        return f"{label}{_fmt(params.get('min'))}%~{_fmt(params.get('max'))}%"
    if name == "turnover_single":
        return f"{label}{_fmt(params.get('min'))}%~{_fmt(params.get('max'))}%"
    if name == "vol_ratio_single":
        return f"{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}倍"
    if name == "amount_single":
        return f"{label}{_fmt(params.get('min'))}~{_fmt(params.get('max'))}亿"
    if name == "market_cap":
        op = "≥" if params.get("op") in ("gt", "gte") else "≤"
        return f"总市值{op}{_fmt(params.get('value'))}亿"
    if name == "new_high":
        return f"创{_fmt(params.get('m', 60))}日新高"
    if name == "more_bullish_candles":
        return f"{_fmt(params.get('m', 5))}日内阳线多于阴线"
    parts = " ".join(f"{key}={_fmt(value)}" for key, value in params.items())
    return f"{label}({parts})" if parts else label


def describe(base_summary: str, filters: list[dict[str, Any]]) -> str:
    """整套条件的描述：基础条件 + 补充条件清单。"""
    parts = [item for item in (describe_condition(item["name"], item.get("params") or {})
                               for item in filters) if item]
    if not parts:
        return base_summary
    return f"{base_summary} ＋ " + " ＋ ".join(parts)


# --------------------------------------------------------------------------- #
# 三个变异算子
# --------------------------------------------------------------------------- #
def add_filter(filters: list[dict[str, Any]], rng: random.Random) -> Optional[list[dict[str, Any]]]:
    """补一个还没用过的条件（同名不同参数算「用过」：再补一次等于两层过滤，收益极低）。"""
    used = {item["name"] for item in filters}
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
    """把一个条件的某个数值参数往上或往下调一步。"""
    numeric = [key for key, value in params.items()
               if isinstance(value, (int, float)) and not isinstance(value, bool)]
    if not numeric:
        return None
    key = rng.choice(numeric)
    current = float(params[key])
    step = _STEP.get(key, 1.0)
    sign = 1.0 if rng.random() < 0.5 else -1.0
    updated = current + sign * step
    if key in ("start", "days", "n", "m", "period", "fast", "slow", "window"):
        updated = max(1.0, round(updated))
    else:
        updated = round(updated, 4)
    if updated == current:
        updated = current + step
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
