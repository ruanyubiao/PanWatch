"""条件树求值：AND / OR / 嵌套 / 短路 / 深度（需求规格 §12.2 E1–E10）。

用桩条件 T（恒真）、F（恒假）、X（一被调用就抛异常）来验证短路 —— 真实条件
做不到「调用了就炸」，而短路写错（比如用列表推导先算完再 all()）在生产上表现
为「明明该提前退出却扫了全树」，只有这种桩能钉住。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from src.modules.market.fork_screen.conditions import EvalContext, NoParams
from src.modules.market.fork_screen.evaluator import (
    CompiledCondition,
    CompiledGroup,
    ScreenEvalError,
    evaluate_node,
)


@dataclass
class StubSpec:
    name: str
    result: object = True
    calls: list = field(default_factory=list)

    def evaluate(self, series, params, ctx):  # noqa: ANN001 - 桩
        self.calls.append(self.name)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def cond(name: str, spec: StubSpec) -> CompiledCondition:
    return CompiledCondition(name=name, spec=spec, params=NoParams())  # type: ignore[arg-type]


def group(operator: str, *children) -> CompiledGroup:
    return CompiledGroup(operator=operator, children=tuple(children))


def run(node: CompiledGroup) -> bool:
    return evaluate_node(node, series=None, ctx=EvalContext(calendar=[], trading_days=30))  # type: ignore[arg-type]


T = StubSpec("T", True)
F = StubSpec("F", False)
X = StubSpec("X", ValueError("boom"))


def test_E1_AND全真():
    assert run(group("AND", cond("T", T), cond("T", T))) is True


def test_E2_AND有假():
    assert run(group("AND", cond("T", T), cond("F", F))) is False


def test_E3_AND遇假短路():
    x = StubSpec("X", ValueError("boom"))
    assert run(group("AND", cond("F", F), cond("X", x))) is False
    assert x.calls == []


def test_E4_OR全假():
    assert run(group("OR", cond("F", F), cond("F", F))) is False


def test_E5_OR遇真短路():
    x = StubSpec("X", ValueError("boom"))
    assert run(group("OR", cond("T", T), cond("X", x))) is True
    assert x.calls == []


def test_E6_嵌套_AND含OR():
    tree = group("AND", cond("T", T), group("OR", cond("F", F), cond("T", T)))
    assert run(tree) is True


def test_E7_OR含两个AND():
    tree = group(
        "OR",
        group("AND", cond("T", T), cond("F", F)),
        group("AND", cond("T", T), cond("T", T)),
    )
    assert run(tree) is True


def test_E8_AND含空OR():
    tree = group("AND", group("OR", cond("F", F), cond("F", F)), cond("T", T))
    assert run(tree) is False


def test_E9_五层嵌套():
    node = group("AND", cond("T", T))
    for _ in range(4):
        node = group("AND", node)
    assert run(node) is True


def test_E10_条件抛异常时转成_ScreenEvalError():
    """不能静默当作 False —— 端点在测试里据此回 500。"""
    with pytest.raises(ScreenEvalError) as info:
        run(group("AND", cond("X", StubSpec("X", RuntimeError("坏数据")))))
    assert info.value.condition == "X"


def test_空根组_AND视为不设限_OR视为不成立():
    assert run(group("AND")) is True
    assert run(group("OR")) is False
