"""总市值条件 / 股票代码 / 股票名称 / 「每个条件一个函数」的回归测试（2026-10-22）。

覆盖四件用户明确要求过的事：

1. 总市值从基础筛选搬进条件列表：``market_cap``（> / ≥ / < / ≤，边界含不含要分清）、
   ``market_cap_single`` / ``market_cap_all`` / ``market_cap_any``；
2. 市值用 ``stock_daily.total_market_cap``（**不是** stock_info 的当前值），
   所以能按历史某一天算，停牌日也有值（停牌不改股本）；
3. 股票代码与股票名称拆成两个条件，都是**完整匹配**；名称比对忽略 ST / *ST 前缀；
4. 注册表里每条条件的求值都是一个**具名的模块级函数**（不是工厂闭包）——
   这是用户「每一个条件做成单独函数」那条要求的机器可检形式。
"""

from __future__ import annotations

import datetime as dt

from src.modules.market.fork_screen.conditions import (
    CONDITIONS,
    Bar,
    EvalContext,
    StockSeries,
)

END = dt.date(2026, 10, 16)


def day(offset: int) -> dt.date:
    return END - dt.timedelta(days=offset)


def series_of(
    closes: list[float],
    caps: list[float] | None = None,
    traded: list[int] | None = None,
) -> StockSeries:
    """构造一只股票：市值按亿元传入，内部换算成元（库里口径）。"""
    total = len(closes)
    bars: list[Bar] = []
    caps_arr = []
    traded_arr = []
    for index, close in enumerate(closes):
        bars.append(
            Bar(
                trade_date=day(total - 1 - index),
                open=close,
                close=close,
                pre_close=closes[index - 1] if index else close,
                c_adj=close,
            )
        )
        caps_arr.append(0.0 if caps is None else caps[index] * 1e8)
        traded_arr.append(1 if traded is None else traded[index])
    series = StockSeries.build("sh600000", bars)
    from src.modules.market.fork_screen.conditions import BarExtras

    extras = BarExtras.empty_for(frozenset({"total_market_cap"}))
    extras.traded.extend(traded_arr)
    extras.mcap.extend(caps_arr)  # type: ignore[union-attr]
    series.extras = extras
    return series


def ctx_of(series: StockSeries, trading_days: int = 30) -> EvalContext:
    calendar = [bar.trade_date for bar in reversed(series.bars)]
    return EvalContext(
        calendar=calendar, trading_days=trading_days, code="600000", name="浦发银行"
    )


def evaluate(name: str, series: StockSeries, **params):
    spec = CONDITIONS[name]
    parsed = spec.params_model.model_validate(params)
    ctx = ctx_of(series)
    return spec.evaluate(series, parsed, ctx), ctx


# ---------------------------------------------------------------- 总市值阈值


def test_市值阈值四个比较符的边界():
    series = series_of([10.0, 10.0], caps=[100.0, 150.0])
    assert evaluate("market_cap", series, op="gt", value=150.0)[0] is False
    assert evaluate("market_cap", series, op="gte", value=150.0)[0] is True
    assert evaluate("market_cap", series, op="lt", value=150.0)[0] is False
    assert evaluate("market_cap", series, op="lte", value=150.0)[0] is True
    assert evaluate("market_cap", series, op="gte", value=150.01)[0] is False


def test_市值阈值取窗口末日而不是窗口内最大值():
    series = series_of([10.0, 10.0, 10.0], caps=[300.0, 120.0, 90.0])
    # 末日 90 亿：< 100 成立；虽然历史上到过 300 亿
    assert evaluate("market_cap", series, op="lt", value=100.0)[0] is True
    assert evaluate("market_cap", series, op="gte", value=100.0)[0] is False


def test_市值第N日_倒数第二天():
    series = series_of([10.0, 10.0, 10.0], caps=[90.0, 120.0, 300.0])
    hit, ctx = evaluate("market_cap_single", series, n=2, min=100, max=200)
    assert hit is True and ctx.insufficient is False


def test_市值每天与任意一天():
    series = series_of([10.0, 10.0, 10.0], caps=[90.0, 150.0, 300.0])
    assert evaluate("market_cap_all", series, n=1, m=3, min=100, max=200)[0] is False
    assert evaluate("market_cap_any", series, n=1, m=3, min=100, max=200)[0] is True


def test_停牌日的市值仍然有效():
    """停牌不改股本 —— 停牌日 total_market_cap 有值，不能按「缺数据」排除。"""
    series = series_of([10.0, 10.0], caps=[120.0, 121.0], traded=[1, 0])
    hit, ctx = evaluate("market_cap_all", series, n=1, m=2, min=100, max=200)
    assert hit is True and ctx.insufficient is False


def test_市值缺失按数据不足处理():
    series = series_of([10.0, 10.0], caps=[0.0, 0.0])
    hit, ctx = evaluate("market_cap", series, op="gte", value=100.0)
    assert hit is False and ctx.insufficient is True


def test_市值条件声明要取total_market_cap列():
    assert CONDITIONS["market_cap"].extras_columns == ("total_market_cap",)
    assert CONDITIONS["market_cap_single"].extras_columns == ("total_market_cap",)


# ---------------------------------------------------------------- 股票代码 / 名称


def test_股票代码完整匹配():
    series = series_of([10.0])
    assert evaluate("stock_code", series, text="600000")[0] is True
    # 不做模糊：前缀 / 子串都不算
    assert evaluate("stock_code", series, text="6000")[0] is False
    assert evaluate("stock_code", series, text="60000")[0] is False
    assert evaluate("stock_code", series, text="600000, 000001")[0] is True


def test_股票名称完整匹配且忽略ST前缀():
    series = series_of([10.0])
    ctx = ctx_of(series)
    spec = CONDITIONS["stock_name"]

    # 不带前缀 / 带前缀都能命中
    assert spec.evaluate(series, spec.params_model(text="浦发银行"), ctx) is True
    assert spec.evaluate(series, spec.params_model(text="ST浦发银行"), ctx) is True
    assert spec.evaluate(series, spec.params_model(text="*ST 浦发银行"), ctx) is True
    # 模糊不行
    assert spec.evaluate(series, spec.params_model(text="浦发"), ctx) is False


def test_股票名称对ST股票_写不写前缀都命中():
    series = series_of([10.0])
    ctx = ctx_of(series)
    ctx.name = "*ST康美"
    spec = CONDITIONS["stock_name"]
    assert spec.evaluate(series, spec.params_model(text="康美"), ctx) is True
    assert spec.evaluate(series, spec.params_model(text="*ST康美"), ctx) is True
    assert spec.evaluate(series, spec.params_model(text="ST康美"), ctx) is True


def test_股票代码与名称是两个独立条件():
    assert "stock_code" in CONDITIONS and "stock_name" in CONDITIONS
    assert CONDITIONS["stock_code"].params_model is not CONDITIONS["stock_name"].params_model
    # 老条件名保留（服务器上已存的条件文件里还有它）
    assert "stock_match" in CONDITIONS


# ---------------------------------------------------------------- 「每个条件一个函数」


def test_每个条件都有自己的模块级函数():
    """注册表里 40+ 条条件，求值函数必须是具名的模块级函数、且一条一个。

    用户要求：「每一个条件是需要做成一个单独的函数的」。这条测试就是它的
    可执行版本 —— 出现工厂闭包（``<locals>``）或两条条件共用一个函数，都会红。
    """
    seen: dict[str, str] = {}
    for name, spec in CONDITIONS.items():
        fn = spec.evaluate
        qualname = getattr(fn, "__qualname__", "")
        assert "<locals>" not in qualname, f"{name} 用的是闭包，不是独立函数：{qualname}"
        assert fn.__module__.endswith("fork_screen.conditions"), f"{name} 不在 conditions 模块里"
        assert fn.__name__ not in seen, (
            f"{name} 与 {seen[fn.__name__]} 共用同一个求值函数 {fn.__name__}，"
            "不满足「一个条件一个函数」"
        )
        seen[fn.__name__] = name
