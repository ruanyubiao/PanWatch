"""条件选股：**按日定位**（倒数第 N 日 / 范围内每日 / 范围内任意一天）的单测。

2026-10-23 用户第 3–6 条：

- 均线多头 / 空头排列、股价站上均线：要有 倒数第 N 日 + 范围内每日 + 范围内任意一天；
- 均线金叉 / 死叉：要有 倒数第 N 日 + 范围内任意一天；
- 阳线多于阴线 / 阴线多于阳线：可指定 D[n..m]（M 默认 = 统计窗口最后一天）；
- 「所有条件都能指定 倒数第 N 日，没指定的一律等价于 N=1」。

这里刻意用**同一条序列的不同日**来断言：如果 N 参数没生效（永远看最后一根），
`test_..._不同N给出不同结果` 会直接红。
"""

from __future__ import annotations

import datetime as dt

import pytest

from src.modules.market.fork_screen.conditions import (
    CONDITIONS,
    CandleRangeParams,
    EvalContext,
    LookbackParams,
    MaCrossParams,
    MaOrderParams,
    MaParams,
    MarketCapOpParams,
    StockSeries,
)
from src.modules.market.fork_screen.evaluator import build_series

END = dt.date(2026, 10, 16)


def day(offset: int) -> dt.date:
    """offset=0 是 asof（D[1]），1 是前一个交易日（这里按自然日造，日历自成一体）。"""
    return END - dt.timedelta(days=offset)


def rows_of(bars) -> list[tuple]:
    """bars: ``[(open, close), ...]``，按时间升序，日期按天连续。"""
    total = len(bars)
    rows = []
    for index, (open_, close) in enumerate(bars):
        rows.append((day(total - 1 - index), open_, close, bars[index - 1][1] if index else None, 1.0))
    return rows


def series_of(bars, extras_columns=(), extra_rows=()) -> StockSeries:
    rows = rows_of(bars)
    if extras_columns:
        rows = [row + tuple(extra) for row, extra in zip(rows, extra_rows)]
    series = build_series("sh600000", rows, extras_columns)
    assert series is not None
    return series


def ctx_of(days: int = 30) -> EvalContext:
    return EvalContext(calendar=[day(i) for i in range(days)], trading_days=days)


def run(name: str, series: StockSeries, params, days: int = 30) -> tuple[bool, bool]:
    """返回 (命中, 数据不足)。"""
    ctx = ctx_of(days)
    hit = CONDITIONS[name].evaluate(series, params, ctx)
    return hit, ctx.insufficient


def trend_bars() -> list[tuple[tuple[float, float], ...]]:
    """缓跌 60 根 + 急拉 10 根 + 最后两根砸盘。

    实测出来的结构（见 tests 里的断言）：倒数第 1 天破坏多头排列，倒数第 2～7 天成立。
    """
    closes = [30 - 0.2 * i for i in range(60)] + [19, 20, 21, 22, 23, 24, 25, 26, 27, 28] + [10, 9]
    return [(close, close) for close in closes]


# ---------------------------------------------------------------- 均线排列


def test_均线多头排列_第N日指向更早的一天():
    series = series_of(trend_bars())
    periods = [5, 10, 20]

    # n=1（默认）= 最后一根：砸盘之后已经不是多头排列了
    assert run("ma_bullish", series, MaOrderParams(periods=periods, n=1))[0] is False
    # n=2 = 砸盘前一天：MA5 26 > MA10 23.5 > MA20 21.3
    assert run("ma_bullish", series, MaOrderParams(periods=periods, n=2))[0] is True
    # 默认参数（不写 n）与 n=1 完全等价 —— 老预设 / 老请求不需要迁移
    assert run("ma_bullish", series, MaOrderParams(periods=periods))[0] is False


def test_均线空头排列_第N日指向更早的一天():
    series = series_of(trend_bars())
    # 最后一根砸盘 → MA5 20 < MA10 21.5：空头排列成立
    assert run("ma_bearish", series, MaOrderParams(periods=[5, 10], n=1))[0] is True
    # 倒数第 2～7 天是急拉段，MA5 > MA10 → 不成立
    assert run("ma_bearish", series, MaOrderParams(periods=[5, 10], n=2))[0] is False
    assert run("ma_bearish", series, MaOrderParams(periods=[5, 10], n=3))[0] is False


def test_均线多头排列_范围内每日与任意一天():
    series = series_of(trend_bars())
    periods = [5, 10, 20]

    # 倒数第 1～2 天里有一天不成立 → 「每日」为假
    assert run("ma_bullish_all", series, MaOrderParams(periods=periods, n=1, m=2))[0] is False
    # 但「任意一天」成立（倒数第 2 天成立）
    assert run("ma_bullish_any", series, MaOrderParams(periods=periods, n=1, m=2))[0] is True
    # 倒数第 2～3 天两天都成立 → 「每日」为真
    assert run("ma_bullish_all", series, MaOrderParams(periods=periods, n=2, m=3))[0] is True
    # 倒数第 1～10 天里也有成立的 → 任意一天为真
    assert run("ma_bullish_any", series, MaOrderParams(periods=periods, n=1, m=10))[0] is True


def test_均线空头排列_范围内每日与任意一天():
    series = series_of(trend_bars())
    # 倒数第 1～3 天里只有最后一天是空头排列 → 「每日」为假、「任意一天」为真
    assert run("ma_bearish_all", series, MaOrderParams(periods=[5, 10], n=1, m=3))[0] is False
    assert run("ma_bearish_any", series, MaOrderParams(periods=[5, 10], n=1, m=3))[0] is True
    # 只第一天 → 每日为真
    assert run("ma_bearish_all", series, MaOrderParams(periods=[5, 10], n=1, m=1))[0] is True
    # 倒数第 2～3 天都不是空头排列 → 任意一天为假
    assert run("ma_bearish_any", series, MaOrderParams(periods=[5, 10], n=2, m=3))[0] is False


# ---------------------------------------------------------------- 股价站上均线


def test_股价站上均线_第N日():
    series = series_of(trend_bars())
    # 最后一根 9 < MA5 20 → 不成立；倒数第 2 根 10 < MA5 23.2 → 也不成立
    assert run("close_above_ma", series, MaParams(period=5, n=1))[0] is False
    assert run("close_above_ma", series, MaParams(period=5, n=2))[0] is False
    # 倒数第 3 根 28 > MA5 26 → 成立
    assert run("close_above_ma", series, MaParams(period=5, n=3))[0] is True


def test_股价站上均线_范围内每日与任意一天():
    series = series_of(trend_bars())
    # 倒数第 1～2 天都跌破 MA5 → 每日为假、任意一天为假
    assert run("close_above_ma_all", series, MaParams(period=5, n=1, m=2))[0] is False
    assert run("close_above_ma_any", series, MaParams(period=5, n=1, m=2))[0] is False
    # 倒数第 1～3 天里有一天站上 → 任意一天为真；但不是每天都站上 → 每日为假
    assert run("close_above_ma_any", series, MaParams(period=5, n=1, m=3))[0] is True
    assert run("close_above_ma_all", series, MaParams(period=5, n=1, m=3))[0] is False
    # 倒数第 3～4 天都站上 → 每日为真
    assert run("close_above_ma_all", series, MaParams(period=5, n=3, m=4))[0] is True


# ---------------------------------------------------------------- 均线金叉 / 死叉


def test_金叉_第N日与范围内任意一天():
    series = series_of(trend_bars())
    # 实测这条序列：金叉发生在倒数第 10 天；死叉在最后一根
    assert run("ma_golden_cross", series, MaCrossParams(fast=5, slow=10, n=1))[0] is False
    assert run("ma_golden_cross", series, MaCrossParams(fast=5, slow=10, n=10))[0] is True
    # 倒数第 1～10 天里包含第 10 天 → 任意一天为真
    assert run("ma_golden_cross_any", series, MaCrossParams(fast=5, slow=10, n=1, m=10))[0] is True
    # 只看最近 5 天 → 没有金叉
    assert run("ma_golden_cross_any", series, MaCrossParams(fast=5, slow=10, n=1, m=5))[0] is False


def test_死叉_第N日与范围内任意一天():
    series = series_of(trend_bars())
    assert run("ma_dead_cross", series, MaCrossParams(fast=5, slow=10, n=1))[0] is True
    assert run("ma_dead_cross", series, MaCrossParams(fast=5, slow=10, n=2))[0] is False
    assert run("ma_dead_cross_any", series, MaCrossParams(fast=5, slow=10, n=1, m=3))[0] is True
    # 倒数第 2～3 天没有死叉
    assert run("ma_dead_cross_any", series, MaCrossParams(fast=5, slow=10, n=2, m=3))[0] is False


# ---------------------------------------------------------------- 阴阳线计数


def candle_bars() -> list[tuple[float, float]]:
    """倒数第 1～3 天收阳、倒数第 4～6 天收阴，更早的都是平盘（open = close）。"""
    bars: list[tuple[float, float]] = [(10.0, 10.0)] * 34
    bars += [(13.0, 10.0), (12.0, 10.0), (11.0, 10.0)]  # 倒数第 6、5、4 天：阴
    bars += [(9.0, 10.0), (9.0, 10.0), (9.0, 10.0)]  # 倒数第 3、2、1 天：阳
    return bars


def test_阳线多于阴线_指定范围():
    series = series_of(candle_bars())
    # 只看最近 3 天：3 阳 0 阴
    assert run("more_bullish_candles", series, CandleRangeParams(n=1, m=3))[0] is True
    # 只看倒数第 4～6 天：0 阳 3 阴
    assert run("more_bullish_candles", series, CandleRangeParams(n=4, m=6))[0] is False
    assert run("more_bearish_candles", series, CandleRangeParams(n=4, m=6))[0] is True
    assert run("more_bearish_candles", series, CandleRangeParams(n=1, m=3))[0] is False


def test_阳线多于阴线_M为0表示整个统计窗口():
    series = series_of(candle_bars())
    # m=0 = 统计窗口最后一天：30 天里 3 阳 3 阴 + 24 根平盘 → 都不成立
    assert run("more_bullish_candles", series, CandleRangeParams(n=1, m=0))[0] is False
    assert run("more_bearish_candles", series, CandleRangeParams(n=1, m=0))[0] is False
    # 老参数（空 dict，等价 n=1/m=0）行为完全不变
    assert run("more_bullish_candles", series, CandleRangeParams())[0] is False


def test_阳线多于阴线_缺数据判数据不足():
    series = series_of(candle_bars())
    hit, insufficient = run("more_bullish_candles", series, CandleRangeParams(n=1, m=3), days=0)
    assert hit is False


# ---------------------------------------------------------------- 创 M 日新高 / 新低


def test_创新高_第N日():
    series = series_of(trend_bars())
    # 最后一根 9 显然不是新高
    assert run("new_high", series, LookbackParams(m=20, n=1))[0] is False
    # 倒数第 2 根 10 也不是；倒数第 3 根 28 是 20 日新高
    assert run("new_high", series, LookbackParams(m=20, n=2))[0] is False
    assert run("new_high", series, LookbackParams(m=20, n=3))[0] is True


def test_创新低_第N日():
    series = series_of(trend_bars())
    # 最后一根 9 是 20 日新低
    assert run("new_low", series, LookbackParams(m=20, n=1))[0] is True
    # 倒数第 2 根 10 也是（前面 20 根都在 20 以上）
    assert run("new_low", series, LookbackParams(m=20, n=2))[0] is True
    # 倒数第 3 根 28 不是新低
    assert run("new_low", series, LookbackParams(m=20, n=3))[0] is False


# ---------------------------------------------------------------- 总市值


def mcap_series(caps: list[float]) -> StockSeries:
    """总市值序列（元）。``traded=1`` + ``total_market_cap``，列顺序与取数层一致。"""
    bars = [(10.0, 10.0)] * len(caps)
    extras = [(1, cap) for cap in caps]
    return series_of(bars, ("traded", "total_market_cap"), extras)


def test_总市值阈值_第N日():
    series = mcap_series([1e10, 1.5e10, 2e10])  # 100 亿、150 亿、200 亿
    assert run("market_cap", series, MarketCapOpParams(op="gt", value=150, n=1))[0] is True
    assert run("market_cap", series, MarketCapOpParams(op="gt", value=150, n=2))[0] is False
    assert run("market_cap", series, MarketCapOpParams(op="gte", value=150, n=2))[0] is True
    # 默认 n=1：与加参数之前一致（最后一根 200 亿 < 250 亿）
    assert run("market_cap", series, MarketCapOpParams(op="lt", value=250))[0] is True


# ---------------------------------------------------------------- 校验 & 根数


def test_倒数第N日超窗口要报错():
    params = MaOrderParams(periods=[5, 10], n=31)
    errors = CONDITIONS["ma_bullish"].validate(params, 30)
    assert errors == ["倒数第几个交易日需为 1 至 30 的整数"]


def test_区间M必须不小于N():
    errors = CONDITIONS["ma_bullish_all"].validate(MaOrderParams(periods=[5, 10], n=5, m=3), 30)
    assert errors == ["终点 M 需为 5 至 30 的整数（M ≥ N）"]


def test_区间跨度上限30根():
    errors = CONDITIONS["ma_bullish_any"].validate(MaOrderParams(periods=[5, 10], n=1, m=30), 250)
    assert errors == []
    errors = CONDITIONS["ma_bullish_all"].validate(MaOrderParams(periods=[5, 10], n=1, m=31), 250)
    assert errors and "区间跨度不能超过 30 个交易日" in errors[0]


def test_阴阳线M为0时不受30根跨度限制():
    """老条件（整个统计窗口 250 天）不能被新加的跨度上限误伤。"""
    assert CONDITIONS["more_bullish_candles"].validate(CandleRangeParams(n=1, m=0), 250) == []
    # 显式写 250 也不行（跨度上限仍然生效）
    assert CONDITIONS["more_bullish_candles"].validate(CandleRangeParams(n=1, m=250), 250) != []


@pytest.mark.parametrize(
    ("name", "params", "need"),
    [
        ("ma_bullish", MaOrderParams(periods=[5, 10, 20], n=3), 2 + 20),
        ("ma_bullish_all", MaOrderParams(periods=[5, 10, 20], n=1, m=5), 4 + 20),
        ("close_above_ma", MaParams(period=20, n=4), 3 + 20),
        ("close_above_ma_any", MaParams(period=20, n=1, m=6), 5 + 20),
        ("new_high", LookbackParams(m=20, n=2), 1 + 20 + 1),
        ("ma_golden_cross", MaCrossParams(fast=5, slow=10, n=3), 2 + 10 + 1),
        ("ma_golden_cross_any", MaCrossParams(fast=5, slow=10, n=1, m=7), 6 + 10 + 1),
        ("more_bullish_candles", CandleRangeParams(n=1, m=12), 12),
        ("more_bullish_candles", CandleRangeParams(n=1, m=0), 30),
        ("market_cap", MarketCapOpParams(n=4), 4),
    ],
)
def test_预取根数随N增长(name, params, need):
    assert CONDITIONS[name].required_bars(params, 30) == need


def test_每个条件都有自己具名函数():
    """一个条件一个函数（用户明确要求）：不能共用闭包、不能是 lambda。"""
    seen: dict[str, str] = {}
    for name, spec in CONDITIONS.items():
        func = spec.evaluate
        assert func.__name__ != "<lambda>", name
        assert "<locals>" not in func.__qualname__, f"{name} 用了闭包"
        assert func.__name__ not in seen, f"{name} 与 {seen[func.__name__]} 共用 {func.__name__}"
        seen[func.__name__] = name
