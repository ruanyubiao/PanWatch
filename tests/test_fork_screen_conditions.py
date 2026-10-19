"""条件选股：7 个条件的纯函数单测（需求规格 §12.1 C1–C20）。

构造方式刻意「从库行开始」：``build_series`` 收的是 ③ 那条 SQL 的列
``(trade_date, open, close, pre_close, adj_factor)``，测试直接喂这个形状，
顺带覆盖「无效记录丢弃 / 复权因子归一」这两条容易写错的规则。
"""

from __future__ import annotations

import datetime as dt

from src.modules.market.fork_screen.conditions import (
    CONDITIONS,
    ChangePctParams,
    ConsecutiveParams,
    EvalContext,
    MaOrderParams,
    MaParams,
    NoParams,
    StockSeries,
    ma,
)
from src.modules.market.fork_screen.evaluator import build_series

END = dt.date(2026, 10, 16)


def day(offset: int) -> dt.date:
    """offset=0 是 asof（``D[1]``），1 是前一个日历日。"""
    return END - dt.timedelta(days=offset)


def series_from(rows, symbol: str = "sh600000") -> StockSeries:
    """rows: ``[(date, open, close, pre_close, adj_factor), ...]``（升序）。"""
    series = build_series(symbol, rows)
    assert series is not None
    return series


def flat_series(closes, adj=1.0, prev_close=None, symbol="sh600000") -> StockSeries:
    """按「收盘价序列」造日线（open = close，涨跌条件不参与时够用）。"""
    rows = []
    total = len(closes)
    for index, close in enumerate(closes):
        trade_date = day(total - 1 - index)
        pre = closes[index - 1] if index else prev_close
        rows.append((trade_date, close, close, pre, adj))
    return series_from(rows, symbol)


def ctx_of(days: int = 30, calendar: list[dt.date] | None = None) -> EvalContext:
    return EvalContext(calendar=calendar or [day(i) for i in range(days)], trading_days=days)


# ---------------------------------------------------------------- 均线


def test_C1_均线多头排列():
    """MA5=12 > MA10=11 > MA20=10 > MA60=9（60 根）。"""
    closes = [8.5] * 40 + [9.0] * 10 + [10.0] * 5 + [12.0] * 5
    series = flat_series(closes)
    assert ma(series, 5) == 12.0
    assert ma(series, 10) == 11.0
    assert ma(series, 20) == 10.0
    assert ma(series, 60) == 9.0

    ctx = ctx_of(60)
    assert CONDITIONS["ma_bullish"].evaluate(series, MaOrderParams(), ctx) is True
    assert ctx.insufficient is False


def test_C2_相邻均线相等不算多头排列():
    # MA10 == MA20 == 10：最后 10 根平均 10（5×8 + 5×12），前 20 根也平均 10
    closes = [8.5] * 40 + [10.0] * 10 + [8.0] * 5 + [12.0] * 5
    series = flat_series(closes)
    assert ma(series, 10) == 10.0
    assert ma(series, 20) == 10.0
    ctx = ctx_of(60)
    assert CONDITIONS["ma_bullish"].evaluate(series, MaOrderParams(), ctx) is False


def test_C3_历史不足60根判false并标记数据不足():
    series = flat_series([10.0] * 59)
    ctx = ctx_of(60)
    assert CONDITIONS["ma_bullish"].evaluate(series, MaOrderParams(), ctx) is False
    assert ctx.insufficient is True


def test_C4_均线空头排列():
    closes = [12.0] * 40 + [10.0] * 10 + [9.0] * 5 + [8.5] * 5
    series = flat_series(closes)
    ctx = ctx_of(60)
    assert CONDITIONS["ma_bearish"].evaluate(series, MaOrderParams(), ctx) is True


def test_C5_收盘价等于均线不算站上():
    series = flat_series([10.0] * 5)
    ctx = ctx_of(5)
    assert CONDITIONS["close_above_ma"].evaluate(series, MaParams(period=5), ctx) is False


def test_C6_收盘价高于均线():
    series = flat_series([10.0] * 4 + [10.5])
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    # MA5 = (10*4 + 10.5)/5 = 10.1
    assert ma(series, 5) == 10.1
    assert CONDITIONS["close_above_ma"].evaluate(series, MaParams(period=5), ctx) is True


def test_C7_除权不复权价平稳但复权后是上升的():
    """原始价格从 10 平到 5（10 送 10），复权后 c_adj 一路 10 → 15。

    只看不复权价会判「跌破均线」；按复权空间算才是对的。
    """
    rows = []
    for index in range(6):
        trade_date = day(5 - index)
        if index < 5:
            rows.append((trade_date, 10.0, 10.0, 10.0, 1.0))
        else:
            # 除权日：价格砍半、因子翻倍 → c_adj = 5 × 3 = 15
            rows.append((trade_date, 5.0, 5.0, 5.0, 3.0))
    series = series_from(rows)
    ctx = ctx_of(6)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    # MA5 = (10*4 + 15)/5 = 11
    assert ma(series, 5) == 11.0
    assert CONDITIONS["close_above_ma"].evaluate(series, MaParams(period=5), ctx) is True


# ---------------------------------------------------------------- K 线计数


def _candle_series(pattern: list[str], missing: set[int] | None = None) -> StockSeries:
    """pattern 里 '+' 阳线、'-' 阴线、'=' 平盘；missing 里的下标当作停牌（无记录）。"""
    missing = missing or set()
    rows = []
    total = len(pattern)
    for index, mark in enumerate(pattern):
        if index in missing:
            continue
        close, open_ = 10.0, 10.0
        if mark == "+":
            close, open_ = 10.5, 10.0
        elif mark == "-":
            close, open_ = 9.5, 10.0
        rows.append((day(total - 1 - index), open_, close, 10.0, 1.0))
    return series_from(rows)


def test_C8_阳线多于阴线():
    series = _candle_series(["+", "+", "+", "-", "="])
    ctx = ctx_of(5)
    assert CONDITIONS["more_bullish_candles"].evaluate(series, NoParams(), ctx) is True
    assert CONDITIONS["more_bearish_candles"].evaluate(series, NoParams(), ctx) is False


def test_C9_阴阳相等两个条件都不成立():
    series = _candle_series(["+", "+", "-", "-"])
    ctx = ctx_of(4)
    assert CONDITIONS["more_bullish_candles"].evaluate(series, NoParams(), ctx) is False
    assert CONDITIONS["more_bearish_candles"].evaluate(series, NoParams(), ctx) is False


def test_C10_停牌日不计入阴阳统计():
    # W=5，D[3]（下标 2）停牌：剩下 阳2 阴2 → 阳 > 阴 不成立
    series = _candle_series(["-", "+", "+", "-", "="], missing={2})
    ctx = ctx_of(5)
    assert CONDITIONS["more_bullish_candles"].evaluate(series, NoParams(), ctx) is False


# ---------------------------------------------------------------- 连续阳线


def test_C11_最近4天连阳():
    series = _candle_series(["-", "+", "+", "+", "+"])
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    assert (
        CONDITIONS["consecutive_bullish"].evaluate(series, ConsecutiveParams(days=4), ctx) is True
    )


def test_C12_其中一天是阴线():
    series = _candle_series(["+", "+", "-", "+", "+"])
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    assert (
        CONDITIONS["consecutive_bullish"].evaluate(series, ConsecutiveParams(days=4), ctx) is False
    )


def test_C13_停牌缺一天不算阳线():
    series = _candle_series(["+", "+", "+", "+", "+"], missing={2})
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    assert (
        CONDITIONS["consecutive_bullish"].evaluate(series, ConsecutiveParams(days=4), ctx) is False
    )


def test_C14_平盘不算阳线():
    series = _candle_series(["+", "+", "+", "+", "="])
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    assert (
        CONDITIONS["consecutive_bullish"].evaluate(series, ConsecutiveParams(days=1), ctx) is False
    )


# ---------------------------------------------------------------- 涨跌幅


def _pct_series(pre_close, close, prev_c_adj=None, adj=1.0) -> StockSeries:
    rows = []
    if prev_c_adj is not None:
        rows.append((day(1), prev_c_adj, prev_c_adj, prev_c_adj, 1.0))
    rows.append((day(0), close, close, pre_close, adj))
    return series_from(rows)


def test_C15_恰好等于下限不算():
    series = _pct_series(pre_close=10.0, close=10.5)
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    params = ChangePctParams(n=1, min=5, max=30)
    assert CONDITIONS["change_pct"].evaluate(series, params, ctx) is False


def test_C16_略高于下限算():
    series = _pct_series(pre_close=10.0, close=10.5)
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    params = ChangePctParams(n=1, min=4.99, max=30)
    assert CONDITIONS["change_pct"].evaluate(series, params, ctx) is True


def test_C17_前收缺失时用复权收盘回退():
    # D[2] 的 pre_close 为 NULL：前一根 c_adj 20，当根 c_adj 21 → 5%
    series = series_from(
        [
            (day(2), 20.0, 20.0, 20.0, 1.0),
            (day(1), 21.0, 21.0, None, 1.0),
        ]
    )
    ctx = ctx_of(5)
    params = ChangePctParams(n=2, min=4, max=6)
    assert CONDITIONS["change_pct"].evaluate(series, params, ctx) is True


def test_C18_前收为0且没有前一根则数据不足():
    series = _pct_series(pre_close=0.0, close=10.0)
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    params = ChangePctParams(n=1, min=-30, max=30)
    assert CONDITIONS["change_pct"].evaluate(series, params, ctx) is False
    assert ctx.insufficient is True


def test_C19_目标日停牌判false():
    series = _pct_series(pre_close=10.0, close=10.5)  # 只有 D[1]
    ctx = ctx_of(5)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    params = ChangePctParams(n=2, min=-100, max=1000)
    assert CONDITIONS["change_pct"].evaluate(series, params, ctx) is False


# ---------------------------------------------------------------- 纯函数


def test_C20_求值不修改输入序列():
    series = flat_series([8.5] * 40 + [9.0] * 10 + [10.0] * 5 + [12.0] * 5)
    before = list(series.bars)
    ctx = ctx_of(60)
    from src.modules.market.fork_screen.conditions import CONDITIONS

    for name, params in (
        ("ma_bullish", MaOrderParams()),
        ("ma_bearish", MaOrderParams()),
        ("close_above_ma", MaParams(period=5)),
        ("more_bullish_candles", NoParams()),
        ("consecutive_bullish", ConsecutiveParams(days=4)),
        ("change_pct", ChangePctParams(n=1)),
    ):
        CONDITIONS[name].evaluate(series, params, ctx)

    assert series.bars == before
    assert [bar.trade_date for bar in series.bars] == [bar.trade_date for bar in before]


def test_无效日线被丢弃():
    """open/close 为空或 ≤ 0 的记录等同于缺失（停牌、脏数据）。"""
    rows = [
        (day(2), 10.0, 10.0, 10.0, 1.0),
        (day(1), None, 10.2, 10.0, 1.0),
        (day(0), 0.0, 0.0, 10.2, 1.0),
    ]
    series = build_series("sh600000", rows)
    assert series is not None
    assert len(series.bars) == 1
    assert series.bars[0].trade_date == day(2)


def test_复权因子缺失或非正按1处理():
    rows = [(day(1), 10.0, 10.0, 10.0, None), (day(0), 11.0, 11.0, 10.0, 0)]
    series = series_from(rows)
    assert series.bars[-1].c_adj == 11.0
    assert series.bars[0].c_adj == 10.0
