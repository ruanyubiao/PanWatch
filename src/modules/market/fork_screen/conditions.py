"""技术条件的精确定义（规格 §9）。

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
import math
from array import array as _array
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
class BarExtras:
    """量价列（与 ``StockSeries.bars`` **按下标对齐**）。

    为什么不用往 ``Bar`` 里加字段：只有量价类条件才需要这些列，而 ``Bar`` 是
    全市场都要持有的对象（最坏 5577 只 × 251 天 ≈ 126 万根）。加 5 个 float 字段
    会让峰值多出约 150MB；用 ``array`` 平行数组、并且**只建请求真正用到的那几列**
    （见 ``repository.bars_sql``），不需要时一个字节都不付。

    ``traded`` 是**停牌标记**（0 = 当日无成交：``high/low`` 为 NULL、
    ``volume/amount/turnover_rate`` 都是 0）。实测云端 2026-10-21 三个条件完全等价
    （10 只停牌股三项同时成立），用它比拿 ``high IS NULL`` 当标记更明确，也省两列。

    没取的列是 ``None``；取到的列里缺失值是 ``NaN``。
    """

    traded: "_array"  # 0/1
    volume: "_array | None"  # 股
    amount: "_array | None"  # 元
    turnover: "_array | None"  # 百分数（管道已算好）

    @classmethod
    def empty_for(cls, columns: "frozenset[str]") -> "BarExtras":
        def maybe(name: str) -> "_array | None":
            return _array("d") if name in columns else None

        return cls(
            traded=_array("b"),
            volume=maybe("volume"),
            amount=maybe("amount"),
            turnover=maybe("turnover_rate"),
        )


@dataclass
class StockSeries:
    """一只股票在窗口内的有效日线，按日期升序（最后一根应当是 asof）。"""

    symbol: str
    bars: list[Bar]
    by_date: dict[_dt.date, int] = field(default_factory=dict)
    # 指标惰性缓存：("ma", 20) → 值。只在单次请求、单只股票内有效。
    cache: dict[tuple, Any] = field(default_factory=dict)
    #: 量价列；请求里没有量价条件时为 None（见 ``BarExtras``）
    extras: BarExtras | None = None

    @classmethod
    def build(cls, symbol: str, bars: list[Bar], extras: BarExtras | None = None) -> "StockSeries":
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
            extras=extras,
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
    #: 候选行自带的代码/名称（6 位代码、名称含 ST 前缀）—— 只给「股票代码或名称
    #: 完整匹配」用，其他条件不读。默认空串，老测试不用改。
    code: str = ""
    name: str = ""


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
    #: 这个条件要从库里多取哪些列（``volume`` / ``amount`` / ``turnover_rate``）。
    #: 空 = 只用 OHLC。取数层按并集取列 —— 取数体积实测每多一列都涨，能省就省。
    extras_columns: tuple[str, ...] = ()


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


def _day_change_pct(series: StockSeries, index: int) -> float | None:
    """单根日线的**真实涨跌幅**（%）：优先交易所 ``pre_close``，缺失才回退复权收盘。

    与 ``_change_pct`` 同一个口径，只是这里按**下标**取某一天（条件要连着看好几天）。
    """
    bar = series.bars[index]
    if bar.pre_close is not None and bar.pre_close > 0:
        return (bar.close / bar.pre_close - 1.0) * 100.0
    if index == 0:
        return None
    prev = series.bars[index - 1]
    if prev.c_adj <= 0:
        return None
    return (bar.c_adj / prev.c_adj - 1.0) * 100.0


def _consecutive_rising(series: StockSeries, params: ConsecutiveParams, ctx: EvalContext) -> bool:
    """连续 N 日**涨幅为正**（收盘 > 前收）。

    与 ``consecutive_bullish`` 的区别（用户要求两个条件分开、名字写清区别）：

    - ``consecutive_bullish``（阳线）看 **open → close**：低开高走的下跌日也算阳线；
    - ``consecutive_rising``（上涨）看 **pre_close → close**：那根低开回升但全天仍跌
      1.4% 的 K 线是阳线、但**不是**上涨。
    """
    first = params.start - 1
    last = first + params.days  # 不含
    if last > len(ctx.calendar):
        ctx.insufficient = True
        return False
    for offset in range(first, last):
        index = series.index_on(ctx.calendar[offset])
        if index is None:
            ctx.insufficient = True
            return False
        pct = _day_change_pct(series, index)
        if pct is None:
            ctx.insufficient = True
            return False
        if not _r(pct) > 0:
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
    "consecutive_rising": ConditionSpec(
        name="consecutive_rising",
        params_model=ConsecutiveParams,
        # 起点之前那 start-1 根也要取到日历；+1 给 pre_close 缺失时回退前一根
        required_bars=lambda p, w: p.start - 1 + p.days + 1,
        validate=_validate_consecutive,
        evaluate=_consecutive_rising,
    ),
}


# ==========================================================================
# 量价条件（2026-10 第二批）
#
# 设计：**指标是参数、形状是循环**，一条条件不写一份求值循环。
#
#   形状 single      倒数第 n 日
#   形状 all         D[n..m] 每一天都在区间内（任一缺数据 → 数据不足）
#   形状 any         D[n..m] 至少一天在区间内（缺数据的那天跳过）
#   形状 span        累计：涨跌幅算复权区间涨幅，量能算合计，量比算均值
#   形状 consecutive 起点 + 天数（复用 ConsecutiveParams 的语义）
#
# 指标 pct / turnover / volume / amount / vol_ratio，共 5 个取值分支；
# 形状 5 个 → 20 条注册项（pct 的 single 就是既有的 ``change_pct``）。
#
# 单位（界面口径，与行情表一致）：成交量**万手**、成交额**亿元**、换手率**百分数**、
# 涨跌幅**百分数**、量比**倍**。区间一律**开区间** :math:`lo < x < hi`。
#
# 停牌日：库里有行，但 ``volume/amount/turnover_rate = 0``、``high/low`` 为 NULL。
# 这类行按**数据不足**处理（不当 0 用）—— 否则「每日换手率 < 5%」会命中一堆停牌股。
# ==========================================================================

#: 量价指标
METRICS: tuple[str, ...] = ("pct", "turnover", "volume", "amount", "vol_ratio")

#: 指标的界面名称（后端只用于拼错误文案，界面文案在前端）
_METRIC_LABEL: dict[str, str] = {
    "pct": "涨跌幅",
    "turnover": "换手率",
    "volume": "成交量",
    "amount": "成交额",
    "vol_ratio": "量比",
}

#: 指标允许的取值边界（界面单位）
_METRIC_BOUNDS: dict[str, tuple[float, float]] = {
    "pct": (-100.0, 1000.0),
    "turnover": (0.0, 1000.0),
    "volume": (0.0, 1e9),
    "amount": (0.0, 1e9),
    "vol_ratio": (0.0, 1e6),
}

#: 参数缺省时的区间（正常请求里前端总会带全，这里只给程序化调用兜底）
_METRIC_DEFAULTS: dict[str, tuple[float, float]] = {
    "pct": (-30.0, 30.0),
    "turnover": (0.0, 30.0),
    "volume": (0.0, 100000.0),
    "amount": (0.0, 100.0),
    "vol_ratio": (0.0, 10.0),
}

#: 量比默认回看几日均量（不含当日）
DEFAULT_VOL_RATIO_WINDOW = 5
#: 区间形状的跨度上限（与连续类条件一致）
MAX_VALUE_SPAN = 30
#: 「股票代码或名称」一次最多写几个
MAX_MATCH_TOKENS = 10

#: 指标 → 需要从库里多取的列（pct 用收盘价，不需要额外列）
_METRIC_COLUMN: dict[str, tuple[str, ...]] = {
    "pct": (),
    "turnover": ("turnover_rate",),
    "volume": ("volume",),
    "amount": ("amount",),
    "vol_ratio": ("volume",),
}


def _make_value_models(metric: str) -> tuple[type[BaseModel], type[BaseModel], type[BaseModel]]:
    """按指标生成三种形状的参数模型（缺省区间随指标走）。"""
    lo, hi = _METRIC_DEFAULTS[metric]

    class _Single(_Strict):
        n: int = 1
        min: float = lo
        max: float = hi
        #: 只有 vol_ratio 读它：量比 = 当日量 ÷ 前 window 日均量
        window: int = DEFAULT_VOL_RATIO_WINDOW

    class _Range(_Strict):
        n: int = 1
        m: int = 1
        min: float = lo
        max: float = hi
        window: int = DEFAULT_VOL_RATIO_WINDOW

    class _Consecutive(_Strict):
        start: int = 1
        days: int = 4
        min: float = lo
        max: float = hi
        window: int = DEFAULT_VOL_RATIO_WINDOW

    _Single.__name__ = f"{metric}_single_params"
    _Range.__name__ = f"{metric}_range_params"
    _Consecutive.__name__ = f"{metric}_consecutive_params"
    return _Single, _Range, _Consecutive


# ---------------------------------------------------------------- 取值


def _ma_at(series: StockSeries, index: int, period: int) -> float | None:
    """第 ``index`` 根往前 ``period`` 根的复权收盘均值（金叉/死叉要算昨天那根）。"""
    if period <= 0 or index + 1 < period:
        return None
    key = ("ma@", index, period)
    cached = series.cache.get(key, _MISSING)
    if cached is not _MISSING:
        return cached
    total = 0.0
    for bar in series.bars[index - period + 1 : index + 1]:
        total += bar.c_adj
    value = round(total / period, 6)
    series.cache[key] = value
    return value


_MISSING = object()


def _vol_ratio(series: StockSeries, index: int, window: int) -> float | None:
    """量比 = 当日成交量 ÷ 前 ``window`` 个**有量**交易日的均量（不含当日）。"""
    extras = series.extras
    volumes = None if extras is None else extras.volume
    if volumes is None or window <= 0:
        return None
    today = volumes[index]
    if not today or today <= 0:
        return None
    picked: list[float] = []
    cursor = index - 1
    while cursor >= 0 and len(picked) < window:
        value = volumes[cursor]
        if value and value > 0:
            picked.append(value)
        cursor -= 1
    if len(picked) < window:
        return None
    return today / (sum(picked) / window)


def _metric_at(series: StockSeries, index: int, metric: str, window: int) -> float | None:
    """某根日线上指标的值（已换算成界面单位）；停牌或缺列 → None。"""
    if metric == "pct":
        return _day_change_pct(series, index)
    extras = series.extras
    if extras is None:
        return None
    if not extras.traded[index]:
        # 停牌行：volume/amount/turnover 都是 0，但「0 成交」不是事实，按缺数据处理
        return None
    if metric == "vol_ratio":
        return _vol_ratio(series, index, window)
    if metric == "turnover":
        column = extras.turnover
        divisor = 1.0
    elif metric == "volume":
        column = extras.volume
        divisor = 1e6  # 股 → 万手
    elif metric == "amount":
        column = extras.amount
        divisor = 1e8  # 元 → 亿元
    else:
        return None
    if column is None:
        return None
    value = column[index]
    return None if math.isnan(value) else value / divisor


# ---------------------------------------------------------------- 求值器


def _single_eval(metric: str):
    def run(series: StockSeries, params: Any, ctx: EvalContext) -> bool:
        n = int(params.n)
        if n > len(ctx.calendar):
            ctx.insufficient = True
            return False
        index = series.index_on(ctx.calendar[n - 1])
        if index is None:
            ctx.insufficient = True
            return False
        value = _metric_at(series, index, metric, int(params.window))
        if value is None:
            ctx.insufficient = True
            return False
        return _r(params.min) < _r(value) < _r(params.max)

    return run


def _all_eval(metric: str):
    def run(series: StockSeries, params: Any, ctx: EvalContext) -> bool:
        for offset in range(int(params.n) - 1, int(params.m)):
            if offset >= len(ctx.calendar):
                ctx.insufficient = True
                return False
            index = series.index_on(ctx.calendar[offset])
            if index is None:
                ctx.insufficient = True
                return False
            value = _metric_at(series, index, metric, int(params.window))
            if value is None:
                ctx.insufficient = True
                return False
            if not _r(params.min) < _r(value) < _r(params.max):
                return False
        return True

    return run


def _any_eval(metric: str):
    def run(series: StockSeries, params: Any, ctx: EvalContext) -> bool:
        seen = False
        for offset in range(int(params.n) - 1, int(params.m)):
            if offset >= len(ctx.calendar):
                break
            index = series.index_on(ctx.calendar[offset])
            if index is None:
                continue
            value = _metric_at(series, index, metric, int(params.window))
            if value is None:
                continue
            seen = True
            if _r(params.min) < _r(value) < _r(params.max):
                return True
        if not seen:
            # 区间内一天数据都没有 —— 是「算不出来」，不是「不满足」
            ctx.insufficient = True
        return False

    return run


def _span_eval(metric: str):
    def run(series: StockSeries, params: Any, ctx: EvalContext) -> bool:
        near, far = int(params.n) - 1, int(params.m) - 1
        if far >= len(ctx.calendar):
            ctx.insufficient = True
            return False
        indexes: list[int] = []
        for offset in range(near, far + 1):
            index = series.index_on(ctx.calendar[offset])
            if index is None:
                ctx.insufficient = True
                return False
            indexes.append(index)
        window = int(params.window)
        if metric == "pct":
            # 区间涨跌幅用**后复权**价，否则除权日会算出假涨幅
            newest = series.bars[indexes[0]]
            oldest = series.bars[indexes[-1]]
            if oldest.c_adj <= 0:
                ctx.insufficient = True
                return False
            value = (newest.c_adj / oldest.c_adj - 1.0) * 100.0
        elif metric == "vol_ratio":
            values = [
                item
                for item in (_metric_at(series, index, metric, window) for index in indexes)
                if item is not None
            ]
            if not values:
                ctx.insufficient = True
                return False
            value = sum(values) / len(values)
        else:
            total = 0.0
            for index in indexes:
                item = _metric_at(series, index, metric, window)
                if item is None:
                    ctx.insufficient = True
                    return False
                total += item
            value = total
        return _r(params.min) < _r(value) < _r(params.max)

    return run


def _consecutive_value_eval(metric: str):
    def run(series: StockSeries, params: Any, ctx: EvalContext) -> bool:
        first = int(params.start) - 1
        last = first + int(params.days)
        if last > len(ctx.calendar):
            ctx.insufficient = True
            return False
        for offset in range(first, last):
            index = series.index_on(ctx.calendar[offset])
            if index is None:
                ctx.insufficient = True
                return False
            value = _metric_at(series, index, metric, int(params.window))
            if value is None:
                ctx.insufficient = True
                return False
            if not _r(params.min) < _r(value) < _r(params.max):
                return False
        return True

    return run


# ---------------------------------------------------------------- 校验


def _check_value_range(params: Any, metric: str) -> list[str]:
    lo, hi = _METRIC_BOUNDS[metric]
    label = _METRIC_LABEL[metric]
    errors: list[str] = []
    if not _r(params.min) < _r(params.max):
        errors.append(f"{label}下限必须小于上限")
    elif not lo <= params.min <= hi or not lo <= params.max <= hi:
        errors.append(f"{label}需在 {lo:g} 至 {hi:g} 之间")
    return errors


def _check_window(params: Any) -> list[str]:
    if not 1 <= int(params.window) <= 60:
        return ["量比回看天数需为 1 至 60 的整数"]
    return []


def _validate_value_single(metric: str):
    def run(params: Any, trading_days: int) -> list[str]:
        limit = max(1, int(trading_days))
        errors: list[str] = []
        if not 1 <= int(params.n) <= limit:
            errors.append(f"N 需为 1 至 {limit} 之间的整数")
        errors.extend(_check_value_range(params, metric))
        if metric == "vol_ratio":
            errors.extend(_check_window(params))
        return errors

    return run


def _validate_value_range(metric: str):
    def run(params: Any, trading_days: int) -> list[str]:
        limit = max(1, int(trading_days))
        errors: list[str] = []
        if not 1 <= int(params.n) <= limit:
            errors.append(f"起点 N 需为 1 至 {limit} 的整数")
        if not int(params.n) <= int(params.m) <= limit:
            errors.append(f"终点 M 需为 N 至 {limit} 的整数（M ≥ N）")
        elif int(params.m) - int(params.n) + 1 > MAX_VALUE_SPAN:
            errors.append(f"区间跨度不能超过 {MAX_VALUE_SPAN} 个交易日")
        errors.extend(_check_value_range(params, metric))
        if metric == "vol_ratio":
            errors.extend(_check_window(params))
        return errors

    return run


def _validate_value_consecutive(metric: str):
    def run(params: Any, trading_days: int) -> list[str]:
        errors = _validate_consecutive(ConsecutiveParams(start=params.start, days=params.days), trading_days)
        errors.extend(_check_value_range(params, metric))
        if metric == "vol_ratio":
            errors.extend(_check_window(params))
        return errors

    return run


# ---------------------------------------------------------------- 根数


def _warmup(metric: str, params: Any) -> int:
    """条件本身之外还需要多取几根。"""
    if metric == "pct":
        return 1  # pre_close 缺失时回退前一根
    if metric == "vol_ratio":
        return max(1, int(params.window))
    return 0


def _required_single(metric: str):
    return lambda p, w: int(p.n) + _warmup(metric, p)


def _required_range(metric: str):
    return lambda p, w: int(p.m) + _warmup(metric, p)


def _required_consecutive(metric: str):
    return lambda p, w: int(p.start) - 1 + int(p.days) + _warmup(metric, p)


# ---------------------------------------------------------------- 注册


#: (条件名, 指标, 形状)
_VALUE_CONDITIONS: tuple[tuple[str, str, str], ...] = (
    ("change_pct_all", "pct", "all"),
    ("change_pct_any", "pct", "any"),
    ("change_pct_span", "pct", "span"),
    ("turnover_single", "turnover", "single"),
    ("turnover_all", "turnover", "all"),
    ("turnover_any", "turnover", "any"),
    ("turnover_span", "turnover", "span"),
    ("volume_single", "volume", "single"),
    ("volume_all", "volume", "all"),
    ("volume_any", "volume", "any"),
    ("volume_span", "volume", "span"),
    ("amount_single", "amount", "single"),
    ("amount_all", "amount", "all"),
    ("amount_any", "amount", "any"),
    ("amount_span", "amount", "span"),
    ("vol_ratio_single", "vol_ratio", "single"),
    ("vol_ratio_all", "vol_ratio", "all"),
    ("vol_ratio_any", "vol_ratio", "any"),
    ("vol_ratio_avg", "vol_ratio", "span"),
    ("vol_ratio_consecutive", "vol_ratio", "consecutive"),
)

_VALUE_MODELS: dict[str, tuple[type[BaseModel], type[BaseModel], type[BaseModel]]] = {
    metric: _make_value_models(metric) for metric in METRICS
}


def _build_value_conditions() -> dict[str, ConditionSpec]:
    built: dict[str, ConditionSpec] = {}
    for name, metric, shape in _VALUE_CONDITIONS:
        single_model, range_model, consecutive_model = _VALUE_MODELS[metric]
        if shape == "single":
            params_model, evaluate, validate, required = (
                single_model,
                _single_eval(metric),
                _validate_value_single(metric),
                _required_single(metric),
            )
        elif shape in ("all", "any", "span"):
            evaluate = {"all": _all_eval, "any": _any_eval, "span": _span_eval}[shape](metric)
            params_model = range_model
            validate = _validate_value_range(metric)
            required = _required_range(metric)
        else:
            params_model = consecutive_model
            evaluate = _consecutive_value_eval(metric)
            validate = _validate_value_consecutive(metric)
            required = _required_consecutive(metric)
        built[name] = ConditionSpec(
            name=name,
            params_model=params_model,
            required_bars=required,
            validate=validate,
            evaluate=evaluate,
            extras_columns=_METRIC_COLUMN[metric],
        )
    return built


CONDITIONS.update(_build_value_conditions())


# ==========================================================================
# 第二批：连续下跌 / 连续缩量 / 创 M 日新高新低 / 均线金叉死叉
#          ＋「股票代码或名称完整匹配」
# ==========================================================================


class LookbackParams(_Strict):
    """回看 M 根（创 M 日新高/新低）。"""

    m: int = 20


class MaCrossParams(_Strict):
    fast: int = 5
    slow: int = 10


class StockMatchParams(_Strict):
    """股票代码或名称，**完整匹配**；多个用逗号/顿号/空格分隔。"""

    text: str = ""


def _consecutive_falling(series: StockSeries, params: ConsecutiveParams, ctx: EvalContext) -> bool:
    """连续 N 日下跌（收盘 < 前收）—— ``consecutive_rising`` 的镜像。"""
    first = params.start - 1
    last = first + params.days
    if last > len(ctx.calendar):
        ctx.insufficient = True
        return False
    for offset in range(first, last):
        index = series.index_on(ctx.calendar[offset])
        if index is None:
            ctx.insufficient = True
            return False
        pct = _day_change_pct(series, index)
        if pct is None:
            ctx.insufficient = True
            return False
        if not _r(pct) < 0:
            return False
    return True


def _new_extreme(highest: bool):
    def run(series: StockSeries, params: LookbackParams, ctx: EvalContext) -> bool:
        lookback = int(params.m)
        if len(series.bars) < lookback + 1:
            ctx.insufficient = True
            return False
        last = series.bars[-1].c_adj
        previous = [bar.c_adj for bar in series.bars[-lookback - 1 : -1]]
        return last > max(previous) if highest else last < min(previous)

    return run


def _ma_cross(upward: bool):
    def run(series: StockSeries, params: MaCrossParams, ctx: EvalContext) -> bool:
        index = len(series.bars) - 1
        if index < 1:
            ctx.insufficient = True
            return False
        fast_now = _ma_at(series, index, params.fast)
        slow_now = _ma_at(series, index, params.slow)
        fast_prev = _ma_at(series, index - 1, params.fast)
        slow_prev = _ma_at(series, index - 1, params.slow)
        if None in (fast_now, slow_now, fast_prev, slow_prev):
            ctx.insufficient = True
            return False
        # 上面的 None 检查之后 pyright 仍按 float|None 推断，这里显式收窄
        f_now = float(fast_now)  # type: ignore[arg-type]
        s_now = float(slow_now)  # type: ignore[arg-type]
        f_prev = float(fast_prev)  # type: ignore[arg-type]
        s_prev = float(slow_prev)  # type: ignore[arg-type]
        if upward:
            return f_prev <= s_prev and f_now > s_now
        return f_prev >= s_prev and f_now < s_now

    return run


def _match_tokens(text: str) -> list[str]:
    raw = (text or "").replace("，", ",").replace("、", ",").replace(";", ",").replace("；", ",")
    tokens: list[str] = []
    for chunk in raw.split(","):
        for token in chunk.split():
            if token:
                tokens.append(token)
    return tokens


def _stock_match(series: StockSeries, params: StockMatchParams, ctx: EvalContext) -> bool:
    """代码（6 位）或名称（含 ST 前缀）**完整相等**才算命中。"""
    tokens = _match_tokens(params.text)
    if not tokens:
        ctx.insufficient = True
        return False
    return ctx.code in tokens or ctx.name in tokens


def _validate_lookback(params: LookbackParams, trading_days: int) -> list[str]:
    limit = min(max(1, int(trading_days)), 250)
    if not 1 <= int(params.m) <= limit:
        return [f"回看天数需为 1 至 {limit} 的整数"]
    return []


def _validate_ma_cross(params: MaCrossParams, trading_days: int) -> list[str]:
    if params.fast not in MA_PERIODS or params.slow not in MA_PERIODS:
        return [f"均线周期不合法（可选 {', '.join(str(p) for p in MA_PERIODS)}）"]
    if params.fast >= params.slow:
        return ["快线周期必须小于慢线周期"]
    return []


def _validate_stock_match(params: StockMatchParams, trading_days: int) -> list[str]:
    tokens = _match_tokens(params.text)
    if not tokens:
        return ["请填写股票代码或名称"]
    if len(tokens) > MAX_MATCH_TOKENS:
        return [f"一次最多 {MAX_MATCH_TOKENS} 个股票代码或名称"]
    if any(len(token) > 20 for token in tokens):
        return ["股票代码或名称过长"]
    return []


CONDITIONS.update(
    {
        "consecutive_falling": ConditionSpec(
            name="consecutive_falling",
            params_model=ConsecutiveParams,
            required_bars=lambda p, w: p.start - 1 + p.days + 1,
            validate=_validate_consecutive,
            evaluate=_consecutive_falling,
        ),
        "consecutive_shrinking": ConditionSpec(
            name="consecutive_shrinking",
            params_model=_VALUE_MODELS["vol_ratio"][2],
            required_bars=_required_consecutive("vol_ratio"),
            validate=_validate_value_consecutive("vol_ratio"),
            evaluate=_consecutive_value_eval("vol_ratio"),
            extras_columns=("volume",),
        ),
        "new_high": ConditionSpec(
            name="new_high",
            params_model=LookbackParams,
            required_bars=lambda p, w: int(p.m) + 1,
            validate=_validate_lookback,
            evaluate=_new_extreme(True),
        ),
        "new_low": ConditionSpec(
            name="new_low",
            params_model=LookbackParams,
            required_bars=lambda p, w: int(p.m) + 1,
            validate=_validate_lookback,
            evaluate=_new_extreme(False),
        ),
        "ma_golden_cross": ConditionSpec(
            name="ma_golden_cross",
            params_model=MaCrossParams,
            required_bars=lambda p, w: int(p.slow) + 1,
            validate=_validate_ma_cross,
            evaluate=_ma_cross(True),
        ),
        "ma_dead_cross": ConditionSpec(
            name="ma_dead_cross",
            params_model=MaCrossParams,
            required_bars=lambda p, w: int(p.slow) + 1,
            validate=_validate_ma_cross,
            evaluate=_ma_cross(False),
        ),
        "stock_match": ConditionSpec(
            name="stock_match",
            params_model=StockMatchParams,
            # 至少返回 1：K=0 会让取数层整段跳过（连日历都不取），股票就全被当成「数据不足」
            required_bars=lambda p, w: 1,
            validate=_validate_stock_match,
            evaluate=_stock_match,
        ),
    }
)


def extras_columns_of(rule: Any) -> frozenset[str]:
    """编译后的树要用到哪些额外列（取数层据此决定 SELECT 加哪几列）。

    空集 = 只用 OHLC，一分钱不付。量比条件也要 ``volume``。
    """
    used: set[str] = set()
    children = getattr(rule, "children", ())
    for child in children:
        if hasattr(child, "children"):
            used |= extras_columns_of(child)
        else:
            used |= set(child.spec.extras_columns)
    return frozenset(used)
