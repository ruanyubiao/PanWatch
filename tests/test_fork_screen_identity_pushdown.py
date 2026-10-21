"""身份条件（股票代码 / 名称）：AND 下按「或」合并 + 下推成候选 SQL。

两条要求：
1. 多个代码/名称在同一个 AND 组里没有「且」的意义（一只股票只有一个代码），
   所以编译期合成一个 OR 组；求值、取数、下推都只看这一种树形。
2. 身份条件能从树里「提前拉出来」拼成 SQL（``code IN`` / ``name LIKE``），
   只查一只股票时候选 5 千 → 1 —— W=250 的 20s 因此降到 1s 级。
"""

from __future__ import annotations

import datetime as dt

from src.modules.market.fork_screen.conditions import Bar, EvalContext, StockSeries
from src.modules.market.fork_screen.evaluator import (
    CompiledCondition,
    CompiledGroup,
    compile_rule,
    evaluate_node,
    identity_filter_groups,
)
from src.modules.market.fork_screen.models import ScreenRequest
from src.modules.market.fork_screen.repository import (
    candidate_params,
    candidate_sql,
    identity_prefilter_sql,
)

END = dt.date(2026, 10, 21)


def request_of(children: list[dict], operator: str = "AND") -> ScreenRequest:
    return ScreenRequest.model_validate(
        {
            "trading_days": 30,
            "markets": ["sh"],
            "include_st": False,
            "rule": {"type": "group", "id": "g", "operator": operator, "children": children},
        }
    )


def cond(node_id: str, name: str, **params) -> dict:
    return {"type": "condition", "id": node_id, "name": name, "params": params}


def series_of(count: int = 3) -> StockSeries:
    bars = [
        Bar(
            trade_date=END - dt.timedelta(days=count - 1 - index),
            open=10.0,
            close=10.0,
            pre_close=10.0,
            c_adj=10.0,
        )
        for index in range(count)
    ]
    return StockSeries.build("sh600933", bars)


def evaluate_rule(req: ScreenRequest, code: str, name: str) -> bool:
    series = series_of()
    ctx = EvalContext(
        calendar=[bar.trade_date for bar in reversed(series.bars)],
        trading_days=30,
        code=code,
        name=name,
    )
    return evaluate_node(compile_rule(req), series, ctx)


# ---------------------------------------------------------------- 「或」语义


def test_AND组里的两个名称条件合成或():
    req = request_of(
        [
            cond("c1", "stock_name", text="爱柯迪"),
            cond("c2", "stock_name", text="锦江航运"),
        ]
    )
    # 编译后应当出现一个 OR 组，且原来的两个叶子都搬进去了
    rule = compile_rule(req)
    assert len(rule.children) == 1
    group = rule.children[0]
    assert isinstance(group, CompiledGroup) and group.operator == "OR"
    assert all(isinstance(child, CompiledCondition) for child in group.children)
    assert {child.name for child in group.children} == {"stock_name"}

    assert evaluate_rule(req, "600933", "爱柯迪") is True
    assert evaluate_rule(req, "601083", "锦江航运") is True
    assert evaluate_rule(req, "600000", "浦发银行") is False


def test_代码与名称各一条也按或合并():
    """「代码=600933 且 名称=锦江航运」如果真是 AND 就永远为空，合并后是并集。"""
    req = request_of(
        [
            cond("c1", "stock_code", text="600933"),
            cond("c2", "stock_name", text="锦江航运"),
        ]
    )
    assert evaluate_rule(req, "600933", "爱柯迪") is True
    assert evaluate_rule(req, "601083", "锦江航运") is True
    assert evaluate_rule(req, "600000", "浦发银行") is False


def test_单个身份条件不被包装():
    req = request_of([cond("c1", "stock_name", text="爱柯迪"), cond("c2", "new_high", m=20)])
    rule = compile_rule(req)
    assert [child.name for child in rule.children] == ["stock_name", "new_high"]
    assert not any(isinstance(child, CompiledGroup) for child in rule.children)


def test_或组里的身份条件仍然各自独立():
    """顶层 OR 不动（本来就是「或」），混进非身份条件也不合并。"""
    req = request_of(
        [cond("c1", "stock_name", text="爱柯迪"), cond("c2", "new_high", m=20)], operator="OR"
    )
    rule = compile_rule(req)
    assert rule.operator == "OR"
    assert len(rule.children) == 2


# ---------------------------------------------------------------- 下推


def test_AND分支的身份条件下推且OR组整体下推():
    req = request_of(
        [
            cond("c1", "stock_name", text="爱柯迪"),
            cond("c2", "stock_code", text="601083"),
            cond("c3", "new_high", m=20),
        ]
    )
    groups = identity_filter_groups(compile_rule(req))
    assert len(groups) == 1
    assert groups[0].codes == ("601083",)
    assert groups[0].names == ("爱柯迪",)
    # 同一个条件里逗号分隔的多个词也是一个「或」组
    multi = request_of([cond("c1", "stock_code", text="600933,601083")])
    assert identity_filter_groups(compile_rule(multi))[0].codes == ("600933", "601083")


def test_顶层OR里的身份条件不下推():
    """OR 的另一条支路可能成立，下推会漏股票。"""
    req = request_of(
        [cond("c1", "stock_name", text="爱柯迪"), cond("c2", "new_high", m=20)], operator="OR"
    )
    assert identity_filter_groups(compile_rule(req)) == ()


def test_混合OR组不下推纯身份():
    req = request_of(
        [
            {
                "type": "group",
                "id": "g2",
                "operator": "OR",
                "children": [cond("c1", "stock_name", text="爱柯迪"), cond("c2", "new_high", m=20)],
            }
        ]
    )
    assert identity_filter_groups(compile_rule(req)) == ()


def test_词数超预算就不下推(monkeypatch):
    from src.modules.market.fork_screen import evaluator

    monkeypatch.setattr(evaluator, "MAX_IDENTITY_PUSH_TOKENS", 1)
    req = request_of([cond("c1", "stock_code", text="600933,601083")])
    assert identity_filter_groups(compile_rule(req)) == ()


def test_下推的SQL片段与参数():
    from src.modules.market.fork_screen.evaluator import IdentityFilter

    assert identity_prefilter_sql(()) == ""
    sql = identity_prefilter_sql(
        (IdentityFilter(codes=("600933",), names=("爱柯迪", "锦江航运")),)
    )
    assert "AND (code IN %(id_c_0)s OR name LIKE %(id_n_0_0)s OR name LIKE %(id_n_0_1)s)" in sql
    # symbol 是 sh600933 这种带前缀的形式，拿 6 位代码比它一行都匹配不到
    assert "symbol IN" not in sql

    payload = request_of([])
    params = candidate_params(
        payload,
        (),
        (IdentityFilter(codes=("600933",), names=("爱柯迪",)),),
    )
    assert params["id_c_0"] == ("600933",)
    assert params["id_n_0_0"] == "%爱柯迪%"
    assert "code IN %(id_c_0)s" in candidate_sql(
        identities=(IdentityFilter(codes=("600933",), names=()),)
    )


def test_名称里的LIKE元字符被转义():
    from src.modules.market.fork_screen.evaluator import IdentityFilter

    params = candidate_params(
        request_of([]), (), (IdentityFilter(names=("50%_测试",),),)
    )
    assert params["id_n_0_0"] == "%50\\%\\_测试%"
