"""条件树的编译 / 校验 / 求值（规格 §8.3、§10）。

为什么先「编译」再求值
----------------------
校验阶段已经把 ``params`` 原始 dict 解析成各自的 pydantic 模型了，把解析结果
留在编译后的树里（``CompiledCondition``），求值循环里就不必再做校验、也不会
出现「校验通过但求值时 KeyError」这种两套口径。前端回显的 ``id`` 只用于错误
定位，后端不依赖它。

错误一律带**路径**：``rule.children[2].children[1]（id=c4）：N 需为 ...``。
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence

from pydantic import ValidationError

from .conditions import (
    Bar,
    BarExtras,
    ConditionSpec,
    CONDITIONS,
    EvalContext,
    StockSeries,
)
from .models import ConditionNode, GroupNode, RuleNode, ScreenRequest

#: 规格 §10 的三个规模上限
MAX_DEPTH = 5
MAX_CONDITIONS = 30
MAX_CHILDREN = 20
#: 规格 §10：总市值上限 1,000,000 亿
MAX_MARKET_CAP_YI = 1_000_000.0
#: 统计窗口上限（§10）
MAX_TRADING_DAYS = 250
MIN_TRADING_DAYS = 1


class ScreenIssue:
    """一条校验错误。``path`` 用于定位（``rule.children[0]``），``node_id`` 是前端 id。"""

    __slots__ = ("path", "node_id", "message")

    def __init__(self, path: str, message: str, node_id: str | None = None) -> None:
        self.path = path
        self.message = message
        self.node_id = node_id

    def describe(self) -> str:
        if self.node_id:
            return f"{self.path}（id={self.node_id}）：{self.message}"
        return f"{self.path}：{self.message}"

    def as_dict(self) -> dict[str, Any]:
        return {"path": self.path, "node_id": self.node_id, "message": self.message}

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"ScreenIssue({self.describe()!r})"


class ScreenRuleInvalid(ValueError):
    """规则/参数不合法 —— 端点转成 400 ``screen_invalid_rule``。"""

    def __init__(self, issues: Sequence[ScreenIssue]) -> None:
        self.issues = list(issues)
        super().__init__("；".join(issue.describe() for issue in self.issues))


# ---------------------------------------------------------------- 编译后节点


@dataclass(frozen=True)
class CompiledCondition:
    name: str
    spec: ConditionSpec
    params: Any  # 该条件 params_model 的实例
    node_id: str | None = None
    path: str = ""


@dataclass(frozen=True)
class CompiledGroup:
    operator: str
    children: tuple[Any, ...] = ()
    node_id: str | None = None
    path: str = ""


# ---------------------------------------------------------------- 校验


def _is_int(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def validate_request(req: ScreenRequest) -> list[ScreenIssue]:
    """全部语义校验（参数 + 规则）。返回空列表表示合法。"""
    return validate_params(req) + validate_rule(req)


def validate_params(req: ScreenRequest) -> list[ScreenIssue]:
    """基础筛选（统计窗口 / 市场 / 总市值）—— 端点转成 400 ``screen_invalid_params``。"""
    issues: list[ScreenIssue] = []

    # ---- trading_days
    days = req.trading_days
    if not _is_int(days) or not MIN_TRADING_DAYS <= int(days) <= MAX_TRADING_DAYS:
        issues.append(
            ScreenIssue("trading_days", f"统计窗口需为 {MIN_TRADING_DAYS}–{MAX_TRADING_DAYS} 的整数")
        )

    # ---- markets
    if not req.markets:
        issues.append(ScreenIssue("markets", "至少选择一个市场"))
    elif len(set(req.markets)) != len(req.markets):
        issues.append(ScreenIssue("markets", "市场不能重复选择"))

    # ---- market_cap
    cap = req.market_cap
    if cap.min_yi < 0:
        issues.append(ScreenIssue("market_cap.min_yi", "总市值下限需为 ≥ 0 的数字"))
    if cap.max_yi > MAX_MARKET_CAP_YI:
        issues.append(ScreenIssue("market_cap.max_yi", "总市值上限不能超过 1,000,000 亿"))
    if round(cap.min_yi, 2) != cap.min_yi or round(cap.max_yi, 2) != cap.max_yi:
        issues.append(ScreenIssue("market_cap", "总市值最多保留 2 位小数"))
    elif not cap.min_yi < cap.max_yi:
        issues.append(ScreenIssue("market_cap", "下限必须小于上限"))
    return issues


def validate_rule(req: ScreenRequest) -> list[ScreenIssue]:
    """条件树 —— 端点转成 400 ``screen_invalid_rule``。"""
    days = req.trading_days
    trading_days = int(days) if _is_int(days) else MIN_TRADING_DAYS
    return _validate_group(
        req.rule, "rule", depth=1, trading_days=trading_days, stats={"count": 0}
    )


def _validate_group(
    node: GroupNode,
    path: str,
    depth: int,
    trading_days: int,
    stats: dict[str, int],
) -> list[ScreenIssue]:
    issues: list[ScreenIssue] = []
    if depth > MAX_DEPTH:
        # 深度超限时报在越界的那个组上，前端能定位到「第 6 层」那个节点
        return [ScreenIssue(path, f"条件组最多嵌套 {MAX_DEPTH} 层", node.id)]
    if len(node.children) > MAX_CHILDREN:
        issues.append(
            ScreenIssue(path, f"单个条件组的子节点不能超过 {MAX_CHILDREN} 个", node.id)
        )
    if depth > 1 and not node.children:
        issues.append(ScreenIssue(path, "条件组不能为空：请添加条件，或删除该组", node.id))

    for index, child in enumerate(node.children):
        child_path = f"{path}.children[{index}]"
        if isinstance(child, GroupNode):
            issues.extend(
                _validate_group(child, child_path, depth + 1, trading_days, stats)
            )
        else:
            issues.extend(_validate_condition(child, child_path, trading_days, stats))
    return issues


def _validate_condition(
    node: ConditionNode,
    path: str,
    trading_days: int,
    stats: dict[str, int],
) -> list[ScreenIssue]:
    stats["count"] += 1
    if stats["count"] > MAX_CONDITIONS:
        return [
            ScreenIssue(
                path,
                f"条件数量过多（最多 {MAX_CONDITIONS} 个）",
                node.id,
            )
        ]
    spec = CONDITIONS.get(node.name)
    if spec is None:
        return [ScreenIssue(path, f"不支持的条件：{node.name}", node.id)]
    try:
        params = spec.params_model.model_validate(node.params or {})
    except ValidationError as exc:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first.get("loc", ())) or "params"
        return [ScreenIssue(f"{path}.params.{location}", f"参数不合法：{first.get('msg', '')}", node.id)]
    messages = spec.validate(params, trading_days)
    return [ScreenIssue(path, message, node.id) for message in messages]


def compile_rule(req: ScreenRequest) -> CompiledGroup:
    """校验并编译。不合法时抛 ``ScreenRuleInvalid``（带全部错误）。"""
    issues = validate_request(req)
    if issues:
        raise ScreenRuleInvalid(issues)
    return _compile_group(req.rule, "rule")


def _compile_group(node: GroupNode, path: str) -> CompiledGroup:
    children: list[Any] = []
    for index, child in enumerate(node.children):
        child_path = f"{path}.children[{index}]"
        if isinstance(child, GroupNode):
            children.append(_compile_group(child, child_path))
        else:
            spec = CONDITIONS[child.name]
            children.append(
                CompiledCondition(
                    name=child.name,
                    spec=spec,
                    params=spec.params_model.model_validate(child.params or {}),
                    node_id=child.id,
                    path=child_path,
                )
            )
    return CompiledGroup(operator=node.operator, children=tuple(children), node_id=node.id, path=path)


# ---------------------------------------------------------------- 取数根数 K


def required_bars_of_group(node: CompiledGroup, trading_days: int) -> int:
    """K = max(W, 树中全部条件的 requiredBars)。

    不论条件在 AND 还是 OR 分支都计入 —— 反正要在内存里对同一只股票求整棵树，
    少取一根会让另一个分支静默判 false。
    """
    best = 0
    for child in node.children:
        if isinstance(child, CompiledGroup):
            best = max(best, required_bars_of_group(child, trading_days))
        else:
            best = max(best, int(child.spec.required_bars(child.params, trading_days)))
    return max(best, trading_days) if best else 0


def is_empty_rule(node: CompiledGroup) -> bool:
    return not node.children


def count_conditions(node: CompiledGroup) -> int:
    total = 0
    for child in node.children:
        if isinstance(child, CompiledGroup):
            total += count_conditions(child)
        else:
            total += 1
    return total


def tree_depth(node: CompiledGroup) -> int:
    deepest = 0
    for child in node.children:
        if isinstance(child, CompiledGroup):
            deepest = max(deepest, tree_depth(child))
    return 1 + deepest


# ---------------------------------------------------------------- 求值


def evaluate_node(node: CompiledGroup, series: StockSeries, ctx: EvalContext) -> bool:
    """短路求值。空组按 ``all([]) == True`` / ``any([]) == False`` 处理：

    - 空 **AND** 组为 True（没说任何要求 → 不设限），与「空根组 = 仅基础筛选」一致；
    - 空 **OR** 组为 False（没有任何一条成立）。
    非根空组在校验阶段已经被拒，所以这里只有根组会是空的。
    """
    if node.operator == "AND":
        for child in node.children:
            if not evaluate_node_or_condition(child, series, ctx):
                return False
        return True
    for child in node.children:
        if evaluate_node_or_condition(child, series, ctx):
            return True
    return False


class ScreenEvalError(RuntimeError):
    """求值时出现**非预期**异常（不是「数据不足」）。端点转成 500 ``screen_eval_failed``。

    规格 §8.3-5：不能静默当作 false —— 那会把程序错误伪装成「没筛出来」。
    """

    def __init__(self, condition: str, cause: BaseException) -> None:
        self.condition = condition
        self.cause = cause
        super().__init__(f"条件计算失败（{condition}）：{cause}")


def evaluate_node_or_condition(node: Any, series: StockSeries, ctx: EvalContext) -> bool:
    if isinstance(node, CompiledGroup):
        return evaluate_node(node, series, ctx)
    try:
        return bool(node.spec.evaluate(series, node.params, ctx))
    except Exception as exc:  # noqa: BLE001 - 交给端点报 500，带条件名
        raise ScreenEvalError(node.name, exc) from exc


def build_series(
    symbol: str,
    rows: Iterable[Sequence[Any]],
    with_extras: bool = False,
) -> StockSeries | None:
    """库行 → ``StockSeries``。

    ``rows`` 每行是 ``(trade_date, open, close, pre_close, adj_factor)``；带量价列时
    是 ``(trade_date, open, close, pre_close, adj_factor, high, low, volume, amount,
    turnover_rate)``（见 ``repository.bars_sql``，按 ``needs_extras`` 选列）。
    无效记录（``open``/``close`` 为空或 ≤ 0）等同于缺失，直接丢弃。
    """
    bars: list[Bar] = []
    extras = BarExtras.empty() if with_extras else None
    for row in rows:
        trade_date, open_, close, pre_close, adj_factor = row[:5]
        if open_ is None or close is None:
            continue
        open_f = float(open_)
        close_f = float(close)
        if open_f <= 0 or close_f <= 0:
            continue
        factor = float(adj_factor) if adj_factor is not None else 0.0
        if factor <= 0:
            factor = 1.0
        bars.append(
            Bar(
                trade_date=_as_date(trade_date),
                open=open_f,
                close=close_f,
                pre_close=float(pre_close) if pre_close is not None else None,
                c_adj=close_f * factor,
            )
        )
        if extras is not None:
            high, low, volume, amount, turnover = (row[5], row[6], row[7], row[8], row[9])
            extras.append(volume, amount, turnover, high, low)
    if not bars:
        return None
    return StockSeries.build(symbol, bars, extras)


def _as_date(value: Any) -> _dt.date:
    if isinstance(value, _dt.datetime):
        return value.date()
    if isinstance(value, _dt.date):
        return value
    return _dt.date.fromisoformat(str(value)[:10])


# ---------------------------------------------------------------- 统计字段


@dataclass
class ScreenOutcome:
    """端点组装响应需要的中间结果（``items`` 由端点用 ``map_row`` 生成）。"""

    hit_rows: list[dict[str, Any]] = field(default_factory=list)
    candidates: int = 0
    evaluated: int = 0
    insufficient: int = 0


def evaluate_candidates(
    rule: CompiledGroup,
    candidates: list[dict[str, Any]],
    series_map: dict[str, StockSeries],
    calendar: list[_dt.date],
    trading_days: int,
    asof: _dt.date | None,
) -> ScreenOutcome:
    """对每只候选股求值整棵树，返回命中行与统计。"""
    outcome = ScreenOutcome(candidates=len(candidates))
    if is_empty_rule(rule):
        outcome.hit_rows = list(candidates)
        return outcome

    for row in candidates:
        symbol = row.get("symbol")
        series = series_map.get(str(symbol))
        last = series.bars[-1].trade_date if series and series.bars else None
        if series is None or last != asof:
            # ③ 里没有任何记录，或最后一根不是 asof：所有条件都判 false
            outcome.insufficient += 1
            continue
        ctx = EvalContext(
            calendar=calendar,
            trading_days=trading_days,
            # 「股票代码或名称完整匹配」读这两项（其他条件不读）
            code=str(row.get("code") or ""),
            name=str(row.get("name") or ""),
        )
        outcome.evaluated += 1
        hit = evaluate_node(rule, series, ctx)
        if hit:
            outcome.hit_rows.append(row)
        elif ctx.insufficient:
            # 只统计「因缺数据判否、**并且**最终没命中」的股票。
            # OR 组里某条支路缺数据、另一条支路命中时，这只票已经在结果里 —— 计进去
            # 会让「缺数据排除 N 只」读成「少算了 N 只」（实测全市场 OR(站上MA250, 站上MA5)
            # 有 52 只这种重叠）。
            outcome.insufficient += 1
    return outcome
