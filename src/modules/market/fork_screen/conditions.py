"""7 个技术条件的精确定义（规格 §9）。

设计要点
--------
每个条件是**单股谓词** ``evaluate(series, params, ctx) -> bool``，不是
「map → map」的批量过滤器。理由：条件树里 AND / OR 要短路求值，谓词形式天然
支持；也不必为每个条件复制一份行情数组。

三条约束（与规格 §1 的非功能目标一致）：
- **纯函数**：不改 ``series.bars``（指标缓存在 ``series.cache`` 里，是每只股票
  每根均线只算一次的惰性缓存，不影响结果）；
- **可单测**：构造 ``StockSeries`` 就能测，不需要数据库；
- **数据不足判 False 并置 ``ctx.insufficient``**，绝不抛异常 —— 抛异常只留给
  「不该发生」的程序错误（由端点转成 500）。

复权口径：均线与回退涨跌幅都只在**复权空间**（``c_adj = close × adj_factor``）
计算，否则除权缺口会被误判成「空头排列」。
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from typing import Any, Callable

from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------------- 数据结构


@dataclass(frozen=True, slots=True)
class Bar:
    """一根**有效**日线（``open``/``close`` 都 > 0）。

    ``slots=True``：最坏情况要同时持有约 120 万根（5577 只 × 251 天），
    普通 dataclass 的 ``__dict__`` 会让内存峰值翻倍。
    """

    trade_date: _dt.date
    open: float
    close: float
    pre_close: float | None
    c_adj: float  # close × f


@dataclass
class StockSeries:
    """一只股票在窗口内的有效日线，按日期升序（最后一根应当是 asof）。"""

    symbol: str
    bars: list[Bar]
    by_date: dict[_dt.date, int] = field(default_factory=dict)
    # 指标惰性缓存：("ma", 20) → 值。只在单次请求、单只股票内有效。
    cache: dict[tuple, Any] = field(default_factory=dict)

    @classmethod
    def build(cls, symbol: str, bars: list[Bar]) -> "StockSeries":
        """同一天重复的行只保留第一条（库里有唯一键，这里只是防御）。"""
        ordered = sorted(bars, key=lambda b: b.trade_date)
        unique: list[Bar] = []
        for bar in ordered:
            if unique and unique[-1].trade_date == bar.trade_date:
                continue
            unique.append(bar)
        return cls(
            symbol=symbol,
            bars=unique,
            by_date={bar.trade_date: i for i, bar in enumerate(unique)},
        )

    def bar_on(self, day: _dt.date) -> Bar | None:
        index = self.by_date.get(day)
        return None if index is None else self.bars[index]

    def index_on(self, day: _dt.date) -> int | None:
        return self.by_date.get(day)


@dataclass
class EvalContext:
    """求值上下文。**每只股票新建一个** —— ``insufficient`` 不能跨股票共享。"""

    calendar: list[_dt.date]  # D[1..K]，下标 0 = asof
    trading_days: int  # W：统计类条件只看 D[1..W]
    insufficient: bool = False


# ---------------------------------------------------------------- 参数模型


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


#：允许的均线周期（规格 §7.1 ``MA_PERIODS``）。库里有同名的 ma5..ma250 列，
#：但我们一律自己按 c_adj 现算，避免「库里的均线口径」和条件口径不一致。
MA_PERIODS: tuple[int, ...] = (5, 10, 20, 30, 60, 120, 250)


class MaOrderParams(_Strict):
    periods: list[int] = Field(default_factory=lambda: [5, 10, 20, 60])


class MaParams(_Strict):
    period: int = 5


class NoParams(_Strict):
    pass


#: 连续阳线：起点（倒数第几个交易日）+ 天数 的跨度上限
MAX_CONSECUTIVE_SPAN = 30


class ConsecutiveParams(_Strict):
    """从倒数第 ``start`` 个交易日起，连续 ``days`` 天每天都收阳。

    ``start=1`` 就是「最近 days 天」，与加这个参数之前的语义完全一致，
    所以老请求（只带 days）不需要迁移。
    """

    start: int = 1
    days: int = 4


class ChangePctParams(_Strict):
    n: int = 1
    min: float = -30
    max: float = 30


@dataclass(frozen=True)
class ConditionSpec:
    """一个条件的注册项。新增条件 = 注册一条 + 补测试。"""

    name: str
    params_model: type[BaseModel]
    #: (params, W) → 需要的日历根数（预热部分不算进窗口）
    #: 参数类型写成 Any：每个条件吃的是自己那个 params_model 的实例，
    #: 用 BaseModel 会让 Pyright 对 ``p.periods`` 这类访问报错
    required_bars: Callable[[Any, int], int]
    #: (params, W) → 中文错误清单
    validate: Callable[[Any, int], list[str]]
    #: 纯谓词；数据不足时置 ``ctx.insufficient`` 并返回 False
    evaluate: Callable[[StockSeries, Any, EvalContext], bool]


# ---------------------------------------------------------------- 指标


def ma(series: StockSeries, period: int) -> float | None:
    """最后一根起往前 ``period`` 根 ``c_adj`` 的算术平均；不足则 None。

    用**个股自己的**最后 period 根有效日线（停牌日顺延），与行情软件常见口径一致。
    同一只股票内多个条件共用结果（``series.cache``）。
    """
    key = ("ma", period)
    if key in series.cache:
        return series.cache[key]
    if period <= 0 or len(series.bars) < period:
        value: float | None = None
    else:
        total = 0.0
        for bar in series.bars[-period:]:
            total += bar.c_adj
        value = round(total / period, 6)
    series.cache[key] = value
    return value


def _r(value: float) -> float:
    """比较前统一保留 6 位，避免浮点尾差导致「看起来相等却判 >」。"""
    return round(float(value), 6)


# ---------------------------------------------------------------- 7 个条件


def _ma_bullish(series: StockSeries, params: MaOrderParams, ctx: EvalContext) -> bool:
    values: list[float] = []
    for period in sorted(set(params.periods)):
        value = ma(series, period)
        if value is None:
            ctx.insufficient = True
            return False
        values.append(_r(value))
    return all(values[i] > values[i + 1] for i in range(len(values) - 1))


def _ma_bearish(series: StockSeries, params: MaOrderParams, ctx: EvalContext) -> bool:
    values: list[float] = []
    for period in sorted(set(params.periods)):
        value = ma(series, period)
        if value is None:
            ctx.insufficient = True
            return False
        values.append(_r(value))
    return all(values[i] < values[i + 1] for i in range(len(values) - 1))


def _close_above_ma(series: StockSeries, params: MaParams, ctx: EvalContext) -> bool:
    value = ma(series, params.period)
    if value is None:
        ctx.insufficient = True
        return False
    return _r(series.bars[-1].c_adj) > _r(value)


def _candle_counts(series: StockSeries, ctx: EvalContext, days: int) -> tuple[int, int, int]:
    """窗口 D[1..days] 内的（阳线, 阴线, 有效日线条数）。停牌日没有记录，不计入。"""
    bull = bear = seen = 0
    for day in ctx.calendar[:days]:
        bar = series.bar_on(day)
        if bar is None:
            continue
        seen += 1
        if bar.close > bar.open:
            bull += 1
        elif bar.close < bar.open:
            bear += 1
    return bull, bear, seen


def _more_bullish_candles(series: StockSeries, params: NoParams, ctx: EvalContext) -> bool:
    bull, bear, seen = _candle_counts(series, ctx, ctx.trading_days)
    if seen == 0:
        ctx.insufficient = True
        return False
    return bull > bear


def _more_bearish_candles(series: StockSeries, params: NoParams, ctx: EvalContext) -> bool:
    bull, bear, seen = _candle_counts(series, ctx, ctx.trading_days)
    if seen == 0:
        ctx.insufficient = True
        return False
    return bear > bull


def _consecutive_bullish(series: StockSeries, params: ConsecutiveParams, ctx: EvalContext) -> bool:
    # 起点 = 倒数第 start 个交易日（start=1 → 日历下标 0），落到窗口末尾
    first = params.start - 1
    last = first + params.days  # 不含
    if last > len(ctx.calendar):
        ctx.insufficient = True
        return False
    for offset in range(first, last):
        index = series.index_on(ctx.calendar[offset])
        if index is None:
            # 停牌缺一条就不成立，也计入「数据不足」—— 这一条要求窗口内**每天都有**记录
            ctx.insufficient = True
            return False
        bar = series.bars[index]
        if not bar.close > bar.open:
            return False
    return True


def _change_pct(series: StockSeries, params: ChangePctParams, ctx: EvalContext) -> bool:
    if params.n > len(ctx.calendar):
        ctx.insufficient = True
        return False
    index = series.index_on(ctx.calendar[params.n - 1])
    if index is None:
        ctx.insufficient = True
        return False
    bar = series.bars[index]

    # 优先用 pre_close：交易所前收已经处理过除权，结果和表格「涨跌」列一致。
    # 回退（pre_close 缺失）才用前一根有效日线的复权收盘。
    pct: float | None = None
    if bar.pre_close is not None and bar.pre_close > 0:
        pct = (bar.close / bar.pre_close - 1.0) * 100.0
    else:
        if index == 0:
            ctx.insufficient = True
            return False
        prev = series.bars[index - 1]
        if prev.c_adj <= 0:
            ctx.insufficient = True
            return False
        pct = (bar.c_adj / prev.c_adj - 1.0) * 100.0

    pct = round(pct, 2)
    return _r(params.min) < pct < _r(params.max)


# ---------------------------------------------------------------- 校验


def _validate_ma_order(params: MaOrderParams, trading_days: int) -> list[str]:
    periods = list(params.periods)
    if len(set(periods)) != len(periods):
        return ["均线周期不能重复"]
    if not 2 <= len(periods) <= 6:
        return ["均线周期至少选 2 个且不能重复"]
    bad = [p for p in periods if p not in MA_PERIODS]
    if bad:
        return [f"均线周期不合法：{bad[0]}（可选 {', '.join(str(p) for p in MA_PERIODS)}）"]
    return []


def _validate_ma(params: MaParams, trading_days: int) -> list[str]:
    if params.period not in MA_PERIODS:
        return ["均线周期不合法"]
    return []


def _validate_none(params: NoParams, trading_days: int) -> list[str]:
    return []


def _validate_consecutive(params: ConsecutiveParams, trading_days: int) -> list[str]:
    # 起点与天数各自 ≤ 窗口（再压到 30 根跨度上限），且两者合起来必须落在窗口内
    limit = min(int(trading_days), MAX_CONSECUTIVE_SPAN)
    errors: list[str] = []
    if not 1 <= params.start <= limit:
        errors.append(f"倒数第几个交易日需为 1 至 {limit} 的整数")
    if not 1 <= params.days <= limit:
        errors.append(f"连续天数需为 1 至 {limit} 的整数")
    if not errors and params.start - 1 + params.days > limit:
        errors.append(f"起点与天数之和不能超过 {limit}（当前统计窗口上限）")
    return errors


def _validate_change_pct(params: ChangePctParams, trading_days: int) -> list[str]:
    errors: list[str] = []
    if not 1 <= params.n <= int(trading_days):
        errors.append("N 需为 1 至统计窗口之间的整数")
    if not params.min < params.max:
        errors.append("涨跌幅下限必须小于上限")
    elif not -100 <= params.min <= 1000 or not -100 <= params.max <= 1000:
        errors.append("涨跌幅需在 -100 至 1000 之间")
    return errors


# ---------------------------------------------------------------- 注册表

CONDITIONS: dict[str, ConditionSpec] = {
    "ma_bullish": ConditionSpec(
        name="ma_bullish",
        params_model=MaOrderParams,
        required_bars=lambda p, w: max(p.periods) if p.periods else 1,
        validate=_validate_ma_order,
        evaluate=_ma_bullish,
    ),
    "ma_bearish": ConditionSpec(
        name="ma_bearish",
        params_model=MaOrderParams,
        required_bars=lambda p, w: max(p.periods) if p.periods else 1,
        validate=_validate_ma_order,
        evaluate=_ma_bearish,
    ),
    "close_above_ma": ConditionSpec(
        name="close_above_ma",
        params_model=MaParams,
        required_bars=lambda p, w: p.period,
        validate=_validate_ma,
        evaluate=_close_above_ma,
    ),
    "more_bullish_candles": ConditionSpec(
        name="more_bullish_candles",
        params_model=NoParams,
        required_bars=lambda p, w: w,
        validate=_validate_none,
        evaluate=_more_bullish_candles,
    ),
    "more_bearish_candles": ConditionSpec(
        name="more_bearish_candles",
        params_model=NoParams,
        required_bars=lambda p, w: w,
        validate=_validate_none,
        evaluate=_more_bearish_candles,
    ),
    "consecutive_bullish": ConditionSpec(
        name="consecutive_bullish",
        params_model=ConsecutiveParams,
        # 起点之前那 start-1 根也要取到日历（窗口上限 30，实际影响很小）
        required_bars=lambda p, w: p.start - 1 + p.days,
        validate=_validate_consecutive,
        evaluate=_consecutive_bullish,
    ),
    "change_pct": ConditionSpec(
        name="change_pct",
        params_model=ChangePctParams,
        # +1：pre_close 缺失时要往回多取一根做回退
        required_bars=lambda p, w: p.n + 1,
        validate=_validate_change_pct,
        evaluate=_change_pct,
    ),
}
