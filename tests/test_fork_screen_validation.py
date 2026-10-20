"""条件选股的语义校验（需求规格 §12.3 V1–V9，规则表 §10）。

校验分两段：``validate_params``（基础筛选 → 400 screen_invalid_params）与
``validate_rule``（条件树 → 400 screen_invalid_rule）。两段都要给出**路径**，
前端才能把错误定位到具体节点。
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.modules.market.fork_screen.evaluator import (
    ScreenRuleInvalid,
    compile_rule,
    required_bars_of_group,
    validate_params,
    validate_request,
    validate_rule,
)
from src.modules.market.fork_screen.models import ScreenRequest


def condition(name: str, **params) -> dict:
    return {"type": "condition", "id": f"c-{name}", "name": name, "params": params}


def group(*children, operator: str = "AND", node_id: str = "g") -> dict:
    return {"type": "group", "id": node_id, "operator": operator, "children": list(children)}


def request(**over) -> ScreenRequest:
    base = {
        "trading_days": 30,
        "markets": ["sh", "sz", "cyb", "kcb"],
        "include_st": False,
        "market_cap": {"min_yi": 1, "max_yi": 100000},
        "rule": group(),
    }
    base.update(over)
    return ScreenRequest.model_validate(base)


def messages(issues) -> str:
    return "；".join(issue.describe() for issue in issues)


# ---------------------------------------------------------------- V1 统计窗口


@pytest.mark.parametrize("days", [0, 251, 1.5])
def test_V1_统计窗口不合法(days):
    issues = validate_params(request(trading_days=days))
    assert issues, f"trading_days={days} 应当报错"
    assert "统计窗口需为 1–250 的整数" in messages(issues)


# ---------------------------------------------------------------- V2 市场


def test_V2_市场不能为空():
    issues = validate_params(request(markets=[]))
    assert "至少选择一个市场" in messages(issues)


def test_V2_市场白名单之外是结构错误():
    with pytest.raises(ValidationError):
        request(markets=["bj"])


def test_V2_市场不能重复():
    issues = validate_params(request(markets=["sh", "sh"]))
    assert "市场不能重复选择" in messages(issues)


# ---------------------------------------------------------------- V3 市值


def test_V3_下限不小于上限():
    issues = validate_params(request(market_cap={"min_yi": 100, "max_yi": 100}))
    assert "下限必须小于上限" in messages(issues)


def test_V3_上限超过一百万():
    issues = validate_params(request(market_cap={"min_yi": 1, "max_yi": 1_000_001}))
    assert "1,000,000" in messages(issues)


# ---------------------------------------------------------------- V4/V5 树结构


def _nest(levels: int) -> dict:
    """``levels`` 个 group 层（根算第 1 层），最里层放一个条件。"""
    node = condition("close_above_ma", period=5)
    for _ in range(levels):
        node = group(node)
    return node


def test_V4_五层合法():
    req = request(rule=_nest(5))
    assert validate_rule(req) == []


def test_V4_六层被拒且提示层数():
    req = request(rule=_nest(6))
    issues = validate_rule(req)
    assert issues
    assert "5 层" in messages(issues)


def test_V5_非根空组被拒并带路径():
    req = request(rule=group(condition("close_above_ma", period=5), group(node_id="g-empty")))
    issues = validate_rule(req)
    assert len(issues) == 1
    assert issues[0].path == "rule.children[1]"
    assert issues[0].node_id == "g-empty"
    assert "条件组不能为空" in messages(issues)


# ---------------------------------------------------------------- V6/V7 条件与参数


def test_V6_未知条件():
    req = request(rule=group(condition("foo")))
    issues = validate_rule(req)
    assert "不支持的条件：foo" in messages(issues)


def test_V7_N超过统计窗口():
    req = request(rule=group(condition("change_pct", n=31, min=-5, max=5)))
    issues = validate_rule(req)
    assert "N 需为 1 至统计窗口之间的整数" in messages(issues)
    assert "rule.children[0]" in messages(issues)


def test_V7_均线只有1个周期():
    req = request(rule=group(condition("ma_bullish", periods=[5])))
    issues = validate_rule(req)
    assert "均线周期至少选 2 个" in messages(issues)


def test_V7_均线周期不在白名单():
    req = request(rule=group(condition("ma_bullish", periods=[5, 7])))
    assert "均线周期不合法" in messages(validate_rule(req))


def test_V7_连续天数超过30上限():
    req = request(trading_days=60, rule=group(condition("consecutive_bullish", days=31)))
    assert "连续天数需为 1 至 30 的整数" in messages(validate_rule(req))


def test_V7_连续阳线的起点超窗口():
    """起点是「倒数第几个交易日」，同样不能超出统计窗口。"""
    req = request(trading_days=10, rule=group(condition("consecutive_bullish", start=11, days=2)))
    assert "倒数第几个交易日需为 1 至 10 的整数" in messages(validate_rule(req))


def test_V7_连续阳线起点加天数超上限():
    req = request(trading_days=60, rule=group(condition("consecutive_bullish", start=20, days=20)))
    assert "起点与天数之和不能超过 30" in messages(validate_rule(req))


def test_V7_连续阳线起点天数都在窗口内则通过():
    req = request(trading_days=30, rule=group(condition("consecutive_bullish", start=10, days=5)))
    assert messages(validate_rule(req)) == ""


def test_V7_涨跌幅区间反了():
    req = request(rule=group(condition("change_pct", n=1, min=10, max=-10)))
    assert "涨跌幅下限必须小于上限" in messages(validate_rule(req))


def test_V7_参数多余字段被拒且提示路径():
    """``params`` 里的多余键由各条件的 ``extra="forbid"`` 拦住，转成带路径的 400。"""
    req = request(rule=group(condition("close_above_ma", period=5, x=1)))
    issues = validate_rule(req)
    assert issues
    assert "参数不合法" in messages(issues)
    assert issues[0].path.startswith("rule.children[0].params")


# ---------------------------------------------------------------- V8 多余字段


def test_V8_顶层多余字段是结构错误():
    with pytest.raises(ValidationError):
        ScreenRequest.model_validate(
            {
                "trading_days": 30,
                "markets": ["sh"],
                "include_st": False,
                "market_cap": {"min_yi": 1, "max_yi": 100},
                "rule": {"type": "group", "operator": "AND", "children": []},
                "x": 1,
            }
        )


# ---------------------------------------------------------------- V9 空根组


def test_V9_空根组合法且_K为0():
    req = request()
    assert validate_request(req) == []
    compiled = compile_rule(req)
    assert required_bars_of_group(compiled, 30) == 0


def test_K取窗口与条件所需根数的较大者():
    # 默认示例树：MA60 需要 60 根；W=30 → K=60
    req = request(
        rule=group(
            condition("ma_bullish", periods=[5, 10, 20, 60]),
            group(condition("change_pct", n=1, min=-30, max=30), operator="OR"),
        )
    )
    assert required_bars_of_group(compile_rule(req), 30) == 60

    # W=250 时窗口本身更大
    req250 = request(trading_days=250, rule=group(condition("more_bullish_candles")))
    assert required_bars_of_group(compile_rule(req250), 250) == 250

    # change_pct 的 n+1：W=30、n=30 → 31
    req_n = request(rule=group(condition("change_pct", n=30, min=-30, max=30)))
    assert required_bars_of_group(compile_rule(req_n), 30) == 31


def test_编译时参数被解析成模型():
    req = request(rule=group(condition("ma_bullish", periods=[10, 5])))
    compiled = compile_rule(req)
    inner = compiled.children[0]
    assert inner.params.periods == [10, 5]  # 原样保留，求值时再排序
    assert inner.spec.name == "ma_bullish"


def test_compile_rule_聚合全部错误():
    req = request(
        trading_days=0,
        rule=group(condition("foo"), condition("ma_bullish", periods=[5])),
    )
    issues = validate_request(req)
    assert len(issues) >= 3
    with pytest.raises(ScreenRuleInvalid) as info:
        compile_rule(req)
    assert len(info.value.issues) == len(issues)
