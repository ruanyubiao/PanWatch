"""变体评估引擎：一个条件 × 一批交易日 → 每个持有期的盈利概率与基准对比。

口径（与「数据分析」完全一致，不然搜出来的条件和分析出来的数会是两件事）
--------------------------------------------------------------------------
* 信号：某只股票在 d0 当天收盘后成立（求值器就是 ``fork_screen`` 的那一个，
  ``evaluate_node`` 逐字复用 —— 自己再写一套向量化判定会有偏差，而这个功能的
  价值全在「可信」）。
* 入场：d0 的**次日开盘**。信号收盘后才成立，人只可能第二天开盘买。
* 涨幅：第 N 个交易日收盘 / 次日开盘 − 1。
* 成本：往返 0.2%（``EXEC_COST``），「盈利」= 扣成本后 > 0。
* 停牌：按停牌前最后一个有效收盘顺延，最多 20 天（``SUSPEND_CAP``）；
  超过判「不可验证」，不拿 0% 冒充不涨不跌。
* 次日开盘一字涨停：标记买不进，从可执行口径里剔除。
* 此外还记一套「收盘口径」（d0 收盘买、第 N 天收盘卖）和「最高价触及」
  （窗口内最高价相对 d0 收盘的涨幅），因为方法 1/2/3 各自看其中一套。
  排行榜按用户选的方法给分，三套数字都留在结果里。

基准（随机买入）
----------------
同一天、同一批候选股（同市场、同 ST 口径）里**每一只**都走同样的口径算一遍，
就是当天的基准。比「随机抽 200 只」更准也更省事：反正所有股票都在内存里。
"""

from __future__ import annotations

import datetime as _dt
import logging
import math
from array import array
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional, Sequence

from ..fork_screen.conditions import Bar, BarExtras, EvalContext, StockSeries, extras_columns_of
from ..fork_screen.evaluator import (
    compile_rule,
    evaluate_node,
    required_bars_of_group,
    validate_params,
    validate_rule,
)
from ..fork_screen.models import ScreenRequest
from .data import Dataset, StockData
from .models import INFER_HORIZONS

logger = logging.getLogger(__name__)

#: 往返成本（与 forward.EXEC_COST 同一个值；这里独立常量，避免循环 import）
COST = 0.002
#: 停牌顺延上限（与 forward.SUSPEND_CAP 一致）
SUSPEND_CAP = 20
#: 「摸到 5%」目标（方法 2 的主指标）
TOUCH_TARGET = 0.05
#: 涨停判定的容差（与 forward 一致）
_LIMIT_TOLERANCE = 0.005


def limit_pct_of(board: str) -> float:
    """涨停幅度：创业板 / 科创板 20%，其余 10%。"""
    return 0.20 if board in ("cyb", "kcb") else 0.10


# --------------------------------------------------------------------------- #
# 前瞻涨幅（纯数组运算，不构造 Bar）
# --------------------------------------------------------------------------- #
@dataclass
class Forward:
    """一只股票在一个信号日的全部前瞻结果（四个口径各 H 个持有期）。

    ``peak`` 是用户 2026-11-06 定的**计分口径**：窗口内最高**收盘**价相对
    次日开盘买入价的收益（扣除不能成交的那天不参与）。允许为负——整段都在亏时
    取的是「亏最少的那一天」，正是用户说的「亏最少那个」。
    它和 ``touch``（盘中最高价）不同：摸到高价又回落不算赚，这里只认收盘。
    """

    close: list[Optional[float]]
    exec_: list[Optional[float]]
    touch: list[Optional[float]]
    unfillable: bool
    peak: list[Optional[float]] = field(default_factory=list)


def forward_of(
    stock: StockData,
    pos: int,
    day_index: int,
    calendar_size: int,
    horizons: Sequence[int] = INFER_HORIZONS,
) -> Optional[Forward]:
    """算一只股票在一个信号日的三个口径。不可验证时返回 None。"""
    length = len(stock.dates)
    if pos < 0 or pos >= length:
        return None
    base = stock.c_adj[pos]
    if base <= 0:
        return None

    # ---- 入场：信号日之后的第一个交易日开盘价
    entry: Optional[float] = None
    entry_pos = pos + 1
    if entry_pos < length and stock.dates[entry_pos] - day_index <= SUSPEND_CAP:
        value = stock.open_adj[entry_pos]
        if value > 0:
            entry = value
    unfillable = False
    if entry is not None:
        gap = entry / base - 1.0
        if gap >= limit_pct_of(stock.board) - _LIMIT_TOLERANCE:
            unfillable = True

    closes: list[Optional[float]] = []
    execs: list[Optional[float]] = []
    touches: list[Optional[float]] = []
    peaks: list[Optional[float]] = []
    best = base
    best_close = 0.0
    for horizon in horizons:
        target = day_index + horizon
        if target >= calendar_size:
            closes.append(None)
            execs.append(None)
            touches.append(None)
            peaks.append(None)
            continue
        tail = stock.last_at_or_before(target)
        if tail is None or tail < pos:
            closes.append(None)
            execs.append(None)
            touches.append(None)
            peaks.append(None)
            continue
        stale = target - stock.dates[tail]
        if stale > SUSPEND_CAP:
            # 长期停牌 / 退市：不拿顺延出来的价格冒充「不涨不跌」
            closes.append(None)
            execs.append(None)
            touches.append(None)
            peaks.append(None)
            continue
        close_adj = stock.c_adj[tail]
        if close_adj <= 0:
            closes.append(None)
            execs.append(None)
            touches.append(None)
            peaks.append(None)
            continue
        closes.append(close_adj / base - 1.0)
        execs.append((close_adj / entry - 1.0) if entry else None)
        # 窗口内最高价 / 最高收盘价：只取 (day_index, target] 之间真有的 K 线。
        # 两者在同一趟里累计，多一次比较而已（用户要的 peak 口径）。
        window_best = best
        cursor = pos + 1
        while cursor <= tail:
            high_value = stock.high_adj[cursor]
            if high_value > window_best:
                window_best = high_value
            close_value = stock.c_adj[cursor]
            if close_value > best_close:
                best_close = close_value
            cursor += 1
        best = window_best
        touches.append(window_best / base - 1.0)
        peaks.append((best_close / entry - 1.0) if entry and best_close > 0 else None)
    return Forward(close=closes, exec_=execs, touch=touches, unfillable=unfillable,
                   peak=peaks)


# --------------------------------------------------------------------------- #
# 逐日记录
# --------------------------------------------------------------------------- #
@dataclass
class DayRecord:
    """一天的条件组 / 基准组计数。所有上层统计都从这里推。"""

    day: _dt.date
    year: int
    hits: int
    #: 与 ``horizons`` 对齐
    close_win: list[int]
    close_n: list[int]
    exec_win: list[int]
    exec_n: list[int]
    touch_win: list[int]
    touch_n: list[int]
    base_close: list[float]
    base_exec: list[float]
    base_touch: list[float]
    #: 计分口径（窗口内最高收盘盈利，可执行价买入）：条件组逐日合计 / 笔数
    peak_sum: list[float] = field(default_factory=list)
    peak_n: list[int] = field(default_factory=list)
    #: 同日全市场（候选池）的 peak 合计 / 笔数 —— 用来做「剔除命中股」的横截面基准
    base_peak_sum: list[float] = field(default_factory=list)
    base_peak_n: list[int] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"day": self.day.isoformat(), "year": self.year, "hits": self.hits,
                "close_win": self.close_win, "close_n": self.close_n,
                "exec_win": self.exec_win, "exec_n": self.exec_n,
                "touch_win": self.touch_win, "touch_n": self.touch_n,
                "base_close": self.base_close, "base_exec": self.base_exec,
                "base_touch": self.base_touch,
                "peak_sum": self.peak_sum, "peak_n": self.peak_n,
                "base_peak_sum": self.base_peak_sum, "base_peak_n": self.base_peak_n}


@dataclass
class VariantMetrics:
    """一个变体在一批交易日上的结果。"""

    horizons: list[int]
    records: list[DayRecord] = field(default_factory=list)
    days: int = 0
    seconds: float = 0.0
    #: 逐股明细（只有最终验算才开，见 ``Engine.evaluate(collect_stocks=True)``）。
    #: ``{symbol: {"code", "name", "win": [...], "n": [...], "base": [...], "days": int}}``
    by_stock: dict[str, dict[str, Any]] = field(default_factory=dict)

    # -- 汇总 ----------------------------------------------------------------
    def signals(self) -> int:
        return sum(record.hits for record in self.records)

    def days_with_hits(self) -> int:
        return sum(1 for record in self.records if record.hits > 0)

    def rate(self, horizon_index: int, metric: str) -> Optional[float]:
        """合并概率（百分点）：metric ∈ close / exec / touch。"""
        wins = 0
        total = 0
        for record in self.records:
            if metric == "close":
                wins += record.close_win[horizon_index]
                total += record.close_n[horizon_index]
            elif metric == "exec":
                wins += record.exec_win[horizon_index]
                total += record.exec_n[horizon_index]
            else:
                wins += record.touch_win[horizon_index]
                total += record.touch_n[horizon_index]
        return (wins / total * 100.0) if total else None

    def base_rate(self, horizon_index: int, metric: str) -> Optional[float]:
        key = {"close": "base_close", "exec": "base_exec", "touch": "base_touch"}[metric]
        values = [getattr(record, key)[horizon_index] for record in self.records
                  if getattr(record, key)[horizon_index] is not None]
        if not values:
            return None
        return sum(values) / len(values) * 100.0

    def day_excess_series(self, horizon_index: int, metric: str) -> list[float]:
        """逐日的「条件胜率 − 当天基准」（小数，不是百分数）。评分要它的 t 值。"""
        diffs: list[float] = []
        for record in self.records:
            if record.hits <= 0:
                continue
            if metric == "close":
                base = record.base_close[horizon_index]
                if base is None or record.close_n[horizon_index] <= 0:
                    continue
                diffs.append(record.close_win[horizon_index] / record.close_n[horizon_index] - base)
            elif metric == "exec":
                base = record.base_exec[horizon_index]
                if base is None or record.exec_n[horizon_index] <= 0:
                    continue
                diffs.append(record.exec_win[horizon_index] / record.exec_n[horizon_index] - base)
            else:
                base = record.base_touch[horizon_index]
                if base is None or record.touch_n[horizon_index] <= 0:
                    continue
                diffs.append(record.touch_win[horizon_index] / record.touch_n[horizon_index] - base)
        return diffs

    def day_t(self, horizon_index: int, metric: str) -> Optional[float]:
        """逐日超额的 t 值（按日聚类：同一天的多只股票不算独立样本）。"""
        diffs = self.day_excess_series(horizon_index, metric)
        count = len(diffs)
        if count < 3:
            return None
        mean = sum(diffs) / count
        variance = sum((value - mean) ** 2 for value in diffs) / (count - 1)
        if variance <= 0:
            return None
        standard_error = (variance / count) ** 0.5
        return mean / standard_error if standard_error > 0 else None

    def day_excess(self, horizon_index: int, metric: str) -> Optional[float]:
        """按日等权的超额（百分点）：每天先算「条件胜率 − 当天基准」，再对天平均。

        为什么不是「合并概率 − 合并基准」：命中数多的日子权重更大，会被拥挤日主导
        （用户 2026-10-23 明确要求两个口径都报）。这里给的是「随便挑一天」的口径。
        """
        diffs: list[float] = []
        for record in self.records:
            if record.hits <= 0:
                continue
            if metric == "close":
                base = record.base_close[horizon_index]
                if base is None or record.close_n[horizon_index] <= 0:
                    continue
                diffs.append(record.close_win[horizon_index] / record.close_n[horizon_index] - base)
            elif metric == "exec":
                base = record.base_exec[horizon_index]
                if base is None or record.exec_n[horizon_index] <= 0:
                    continue
                diffs.append(record.exec_win[horizon_index] / record.exec_n[horizon_index] - base)
            else:
                base = record.base_touch[horizon_index]
                if base is None or record.touch_n[horizon_index] <= 0:
                    continue
                diffs.append(record.touch_win[horizon_index] / record.touch_n[horizon_index] - base)
        if not diffs:
            return None
        return sum(diffs) / len(diffs) * 100.0

    def year_excess(self, horizon_index: int, metric: str) -> dict[int, float]:
        """按年拆分的按日超额 —— 用来判断「是不是只在某一年有效」。"""
        buckets: dict[int, list[float]] = {}
        for record in self.records:
            if record.hits <= 0:
                continue
            if metric == "close":
                base = record.base_close[horizon_index]
                if base is None or record.close_n[horizon_index] <= 0:
                    continue
                value = record.close_win[horizon_index] / record.close_n[horizon_index] - base
            elif metric == "exec":
                base = record.base_exec[horizon_index]
                if base is None or record.exec_n[horizon_index] <= 0:
                    continue
                value = record.exec_win[horizon_index] / record.exec_n[horizon_index] - base
            else:
                base = record.base_touch[horizon_index]
                if base is None or record.touch_n[horizon_index] <= 0:
                    continue
                value = record.touch_win[horizon_index] / record.touch_n[horizon_index] - base
            buckets.setdefault(record.year, []).append(value)
        return {year: sum(items) / len(items) * 100.0 for year, items in buckets.items() if items}

    def excess(self, horizon_index: int, metric: str) -> Optional[float]:
        """合并口径的超额（百分点）。"""
        rate = self.rate(horizon_index, metric)
        base = self.base_rate(horizon_index, metric)
        if rate is None or base is None:
            return None
        return rate - base

    # -- 计分口径：窗口内最高收盘盈利（用户 2026-11-06 定的规则） ----------------
    def peak_mean(self, index: int) -> Optional[float]:
        """条件组的平均「窗口内最高收盘盈利」（小数，已扣往返成本）。"""
        total = sum(record.peak_sum[index] for record in self.records)
        count = sum(record.peak_n[index] for record in self.records)
        if count <= 0:
            return None
        return total / count - COST

    def peak_base_mean(self, index: int, exclude_hits: bool = True) -> Optional[float]:
        """同日全截面的平均 peak（小数，已扣往返成本）。

        ``exclude_hits``：把当天命中的股票自己从基准里减掉。条件一天命中两千多只、
        占全市场三四成时，不剔就是自己跟自己比（用户问「同日全市场随机均值」时的结论）。
        """
        total = 0.0
        count = 0
        for record in self.records:
            sum_all = record.base_peak_sum[index]
            n_all = record.base_peak_n[index]
            if exclude_hits:
                sum_all -= record.peak_sum[index]
                n_all -= record.peak_n[index]
            total += sum_all
            count += n_all
        if count <= 0:
            return None
        return total / count - COST

    def peak_series(self, index: int) -> list[float]:
        """逐日「条件均值 − 同日全截面均值（剔除命中股）」，单位小数。"""
        series: list[float] = []
        for record in self.records:
            if record.peak_n[index] <= 0:
                continue
            sum_all = record.base_peak_sum[index] - record.peak_sum[index]
            n_all = record.base_peak_n[index] - record.peak_n[index]
            if n_all <= 0:
                continue
            series.append(record.peak_sum[index] / record.peak_n[index] - sum_all / n_all)
        return series

    def peak_excess(self, index: int) -> Optional[float]:
        """按日等权的平均超额（百分点）。"""
        series = self.peak_series(index)
        if not series:
            return None
        return sum(series) / len(series) * 100.0

    def peak_lower(self, index: int, horizon: int) -> Optional[float]:
        """超额的下界（百分点）：Newey–West 标准误，滞后 = 持有期。

        用户 2026-11-06：*「你直接在计算的时候，把信号样本的重叠问题考虑进去就行，
        结果直接给分数」*。所以重叠不进界面，而是进这里 —— 滞后取持有期，
        连续两天命中同一只股票（窗口重叠 29 天）只算作一个独立片段。
        """
        series = self.peak_series(index)
        count = len(series)
        if count < 3:
            return None
        mean = sum(series) / count
        lag = max(1, int(horizon) - 1)
        lag = min(lag, count - 1)
        variance = sum((value - mean) ** 2 for value in series) / count
        for offset in range(1, lag + 1):
            cov = sum((series[i] - mean) * (series[i - offset] - mean)
                      for i in range(offset, count)) / count
            variance += 2.0 * (1.0 - offset / (lag + 1.0)) * cov
        if variance <= 0:
            return mean * 100.0
        standard_error = (variance / count) ** 0.5
        return (mean - 1.96 * standard_error) * 100.0

    def peak_neff(self, horizon: int) -> int:
        """独立片段数 ≈ 有信号的天数 / 持有期（给界面看「这个分数有多硬」）。"""
        return int(sum(1 for record in self.records if record.peak_n and any(
            n > 0 for n in record.peak_n)) // max(1, int(horizon)))

    def signal_count(self, horizon_index: int, metric: str) -> int:
        if metric == "close":
            return sum(record.close_n[horizon_index] for record in self.records)
        if metric == "exec":
            return sum(record.exec_n[horizon_index] for record in self.records)
        return sum(record.touch_n[horizon_index] for record in self.records)

    def table(self) -> list[dict[str, Any]]:
        """五档持有期的完整数字（排行榜与最终报告共用）。"""
        rows: list[dict[str, Any]] = []
        for index, horizon in enumerate(self.horizons):
            row: dict[str, Any] = {"horizon": horizon}
            for metric in ("close", "exec", "touch"):
                rate = self.rate(index, metric)
                base = self.base_rate(index, metric)
                row[f"{metric}_rate"] = None if rate is None else round(rate, 2)
                row[f"{metric}_base"] = None if base is None else round(base, 2)
                excess = self.excess(index, metric)
                row[f"{metric}_excess"] = None if excess is None else round(excess, 2)
                day_excess = self.day_excess(index, metric)
                row[f"{metric}_day_excess"] = None if day_excess is None else round(day_excess, 2)
                row[f"{metric}_n"] = self.signal_count(index, metric)
            primary = primary_metric("stat_v3")[0]
            row["years"] = {str(year): round(value, 2)
                            for year, value in self.year_excess(index, primary).items()}
            rows.append(row)
        return rows

    def as_dict(self) -> dict[str, Any]:
        return {"days": self.days, "signals": self.signals(),
                "days_with_hits": self.days_with_hits(), "seconds": round(self.seconds, 1),
                "rows": self.table(),
                "records": [record.as_dict() for record in self.records]}


#: 每个统计方法的主口径：(metric, 用按日等权还是合并)
_PRIMARY: dict[str, tuple[str, str]] = {
    "stat_v1": ("close", "day"),   # 收盘口径、按日等权（方法 1 的诚实口径）
    "stat_v2": ("touch", "pooled"),  # 最高价触及 5%、合并（方法 2）
    "stat_v3": ("exec", "pooled"),  # 扣成本可执行、合并（方法 3 的每笔口径）
}


def primary_metric(method: str) -> tuple[str, str]:
    return _PRIMARY.get(method, _PRIMARY["stat_v3"])


#: 计分持有期：用户 2026-11-06 定「验证天数固定 30 计分」，其余周期降为明细列
SCORE_HORIZON = 30
#: 分数锚点：50 = 与随机买入相同；每 +1pp 超额 +5 分；60 = +2pp
SCORE_BASE = 50.0
SCORE_PER_PP = 5.0


def score_index(metrics: VariantMetrics) -> Optional[int]:
    """计分用哪一个持有期：固定 30 日（没有 30 就用最长的那个）。"""
    if SCORE_HORIZON in metrics.horizons:
        return metrics.horizons.index(SCORE_HORIZON)
    return len(metrics.horizons) - 1 if metrics.horizons else None


def score_of(metrics: VariantMetrics, method: str) -> tuple[Optional[float], Optional[int]]:
    """给一个变体打分：返回 ``(0–100 的分数, 计分持有期)``。

    用户 2026-11-06 把评分规则定死成一句话：**50 分 = 和随机买入一样，每多 5 分就是
    多 1 个百分点；60 分 = 比随机好 2 个百分点**。所以：

    ::

        分 = 50 + 5 × 超额下限(pp)    然后截到 0–100

    * 超额 = 每笔信号「窗口内最高收盘盈利」的均值 − 同日全截面均值（剔除命中股）。
      不是胜率、不是「摸到 5%」，也不是「所有股票各打一分再平均」。
    * 用**下限**而不是点估计：下限来自 Newey–West 标准误（滞后 = 30），连续两天命中
      同一只股票的 29 天重叠只算一个独立片段。重叠问题就这样被算进分数里，
      界面上不必再显示区间。
    * 硬门槛（样本 / 独立片段 / 每天信号数）不满足 → 封顶 55，即「判不了，不能及格」。
    """
    from ..fork_analysis import scoring as _scoring
    from .models import MIN_DAYS_WITH_HITS, MIN_SIGNALS

    if metrics.signals() < MIN_SIGNALS or metrics.days_with_hits() < MIN_DAYS_WITH_HITS:
        return None, None
    index = score_index(metrics)
    if index is None:
        return None, None
    horizon = metrics.horizons[index]
    lower = metrics.peak_lower(index, horizon)
    if lower is None:
        return None, horizon

    score = SCORE_BASE + SCORE_PER_PP * float(lower)
    if (metrics.signals() < _scoring.MIN_EVENTS
            or metrics.peak_neff(horizon) < _scoring.MIN_EFFECTIVE
            or metrics.signals() / max(1, metrics.days) < _scoring.MIN_SIGNALS_PER_DAY):
        score = min(score, _scoring.PASS_SCORE - 5.0)
    mean_peak = metrics.peak_mean(index)
    if mean_peak is not None and mean_peak <= 0:
        score = min(score, _scoring.PASS_SCORE - 5.0)
    return round(max(0.0, min(100.0, score)), 1), horizon


# --------------------------------------------------------------------------- #
# 求值器
# --------------------------------------------------------------------------- #
class Engine:
    """在预读好的 ``Dataset`` 上评估变体。"""

    def __init__(self, dataset: Dataset, base_request: ScreenRequest,
                 horizons: Sequence[int] = INFER_HORIZONS) -> None:
        self.dataset = dataset
        self.base_request = base_request
        self.horizons = list(horizons)
        self._base_cache: dict[int, tuple[list[Optional[float]], list[Optional[float]],
                                          list[Optional[float]], list[float], list[int]]] = {}
        self._calendar_cache: dict[tuple[int, int], list[_dt.date]] = {}
        #: 只保留候选池里真有的股票
        self.stocks: list[StockData] = [stock for stock in dataset.stocks.values()]

    # -- 基准 ----------------------------------------------------------------
    def baseline(self, day_index: int) -> tuple[list[Optional[float]], list[Optional[float]],
                                               list[Optional[float]], list[float], list[int]]:
        """当天全市场（候选池）的基准：三套概率 + 计分口径的 peak 合计/笔数。

        用户 2026-11-06 问「同日全市场随机均值与指数，哪个更好」，结论是**同日全截面**：
        指数是组合、和「买一只」不是同一个统计量，而 peak 对组合会被平滑掉。
        这里就是全截面，不抽样，所以没有抽样误差。计分时再把当天的命中股自己减掉
        （见 ``VariantMetrics.peak_excess_series``），避免「自己跟自己比」。
        """
        cached = self._base_cache.get(day_index)
        if cached is not None:
            return cached
        close_wins = [0] * len(self.horizons)
        close_n = [0] * len(self.horizons)
        exec_wins = [0] * len(self.horizons)
        exec_n = [0] * len(self.horizons)
        touch_wins = [0] * len(self.horizons)
        touch_n = [0] * len(self.horizons)
        peak_sum = [0.0] * len(self.horizons)
        peak_n = [0] * len(self.horizons)
        total = 0
        size = len(self.dataset.calendar)
        for stock in self.stocks:
            pos = stock.position(day_index)
            if pos is None:
                continue
            total += 1
            result = forward_of(stock, pos, day_index, size, self.horizons)
            if result is None:
                continue
            for index in range(len(self.horizons)):
                close_value = result.close[index]
                if close_value is not None:
                    close_n[index] += 1
                    close_wins[index] += 1 if close_value > COST else 0
                exec_value = result.exec_[index]
                if exec_value is not None and not result.unfillable:
                    exec_n[index] += 1
                    if exec_value > COST:
                        exec_wins[index] += 1
                touch_value = result.touch[index]
                if touch_value is not None:
                    touch_n[index] += 1
                    if touch_value >= TOUCH_TARGET:
                        touch_wins[index] += 1
                peak_value = result.peak[index] if index < len(result.peak) else None
                if peak_value is not None and not result.unfillable:
                    peak_sum[index] += float(peak_value)
                    peak_n[index] += 1
        close_rate = [(close_wins[i] / close_n[i]) if close_n[i] else None
                      for i in range(len(self.horizons))]
        exec_rate = [(exec_wins[i] / exec_n[i]) if exec_n[i] else None for i in range(len(self.horizons))]
        touch_rate = [(touch_wins[i] / touch_n[i]) if touch_n[i] else None for i in range(len(self.horizons))]
        result_tuple = (close_rate, exec_rate, touch_rate, peak_sum, peak_n)
        self._base_cache[day_index] = result_tuple
        return result_tuple

    # -- 变体 ----------------------------------------------------------------
    def request_for(self, rule: dict[str, Any]) -> ScreenRequest:
        # 必须走 model_validate 重新校验：``model_copy(update=...)`` 不校验，
        # rule 会保持成 dict，求值器随后按 GroupNode 访问属性就会炸
        data = self.base_request.model_dump(mode="json")
        data["rule"] = rule
        return ScreenRequest.model_validate(data)

    def validate(self, rule: dict[str, Any]) -> list[str]:
        """结构 + 语义校验（与条件选股同一个入口）。返回中文错误清单。"""
        try:
            request = self.request_for(rule)
        except Exception as exc:  # noqa: BLE001 - pydantic 结构错误
            return [f"条件结构不合法：{exc}"]
        issues = [f"{issue.path}：{issue.message}" for issue in validate_params(request)]
        issues += [f"{issue.path}：{issue.message}" for issue in validate_rule(request)]
        return issues

    def evaluate(self, rule: dict[str, Any], day_indices: Sequence[int],
                 should_stop: Optional[Any] = None,
                 collect_stocks: bool = False) -> VariantMetrics:
        """在这批交易日上跑一个变体。

        ``collect_stocks=True`` 时额外按股票聚合（最终验算才用：判断这个条件
        是不是「只对某些个股有效」，用户 2026-11-03 第 4/5 条）。搜索阶段不开，
        否则一天几千只股票 × 1000 次变体的字典开销会把搜索拖慢一半。
        """
        import time

        request = self.request_for(rule)
        compiled = compile_rule(request)
        trading_days = int(request.trading_days)
        k = max(1, required_bars_of_group(compiled, trading_days))
        columns = extras_columns_of(compiled)
        horizons = self.horizons
        size = len(self.dataset.calendar)
        metrics = VariantMetrics(horizons=list(horizons))
        by_stock: dict[str, dict[str, Any]] = {}
        started = time.perf_counter()

        for day_index in day_indices:
            if should_stop is not None and should_stop():
                raise InterruptedError("评估被停止")
            calendar = self._calendar_cache.get((day_index, k))
            if calendar is None:
                calendar = self.dataset.calendar_window(day_index, k)
                self._calendar_cache[(day_index, k)] = calendar
            base_close, base_exec, base_touch, base_peak_sum, base_peak_n = self.baseline(day_index)
            close_win = [0] * len(horizons)
            close_n = [0] * len(horizons)
            exec_win = [0] * len(horizons)
            exec_n = [0] * len(horizons)
            touch_win = [0] * len(horizons)
            touch_n = [0] * len(horizons)
            peak_sum = [0.0] * len(horizons)
            peak_n = [0] * len(horizons)
            hits = 0
            for stock in self.stocks:
                pos = stock.position(day_index)
                if pos is None:
                    continue
                series = self._series(stock, pos, k, columns)
                context = EvalContext(calendar=calendar, trading_days=trading_days,
                                      code=stock.code, name=stock.name)
                if not evaluate_node(compiled, series, context):
                    continue
                result = forward_of(stock, pos, day_index, size, horizons)
                if result is None:
                    continue
                hits += 1
                entry = None
                if collect_stocks:
                    entry = by_stock.get(stock.symbol)
                    if entry is None:
                        entry = by_stock[stock.symbol] = {
                            "code": stock.code, "name": stock.name,
                            "win": [0] * len(horizons), "n": [0] * len(horizons),
                            "base": [0.0] * len(horizons), "days": 0,
                        }
                    entry["days"] += 1
                for index in range(len(horizons)):
                    close_value = result.close[index]
                    if close_value is not None:
                        close_n[index] += 1
                        if close_value > COST:
                            close_win[index] += 1
                    exec_value = result.exec_[index]
                    if exec_value is not None and not result.unfillable:
                        exec_n[index] += 1
                        if exec_value > COST:
                            exec_win[index] += 1
                            ok = True
                        else:
                            ok = False
                        if entry is not None:
                            entry["n"][index] += 1
                            entry["win"][index] += 1 if ok else 0
                            base_value = base_exec[index]
                            if base_value is not None:
                                entry["base"][index] += float(base_value)
                    touch_value = result.touch[index]
                    if touch_value is not None:
                        touch_n[index] += 1
                        if touch_value >= TOUCH_TARGET:
                            touch_win[index] += 1
                    peak_value = result.peak[index] if index < len(result.peak) else None
                    if peak_value is not None and not result.unfillable:
                        peak_sum[index] += float(peak_value)
                        peak_n[index] += 1
            metrics.records.append(DayRecord(
                day=self.dataset.calendar[day_index],
                year=self.dataset.calendar[day_index].year,
                hits=hits,
                close_win=close_win, close_n=close_n, exec_win=exec_win, exec_n=exec_n,
                touch_win=touch_win, touch_n=touch_n,
                base_close=base_close, base_exec=base_exec, base_touch=base_touch,
                peak_sum=peak_sum, peak_n=peak_n,
                base_peak_sum=base_peak_sum, base_peak_n=base_peak_n,
            ))
        metrics.days = len(day_indices)
        metrics.by_stock = by_stock
        metrics.seconds = time.perf_counter() - started
        return metrics

    def _series(self, stock: StockData, pos: int, k: int,
                columns: frozenset[str]) -> StockSeries:
        """把一只股票的下标窗口包成 ``StockSeries``（Bar 对象按窗口现建）。"""
        start = max(0, pos - k + 1)
        days = self.dataset.calendar
        bars = [
            Bar(
                trade_date=days[stock.dates[index]],
                open=stock.open[index],
                close=stock.close[index],
                pre_close=stock.pre_close[index] if stock.pre_close[index] > 0 else None,
                c_adj=stock.c_adj[index],
            )
            for index in range(start, pos + 1)
        ]
        extras = None
        if columns:
            extras = BarExtras(
                traded=array("b", [1] * len(bars)),
                volume=stock.volume[start:pos + 1] if "volume" in columns else None,
                amount=stock.amount[start:pos + 1] if "amount" in columns else None,
                turnover=stock.turnover[start:pos + 1] if "turnover_rate" in columns else None,
                mcap=stock.mcap[start:pos + 1] if "total_market_cap" in columns else None,
            )
        return StockSeries(
            symbol=stock.symbol,
            bars=bars,
            by_date={bar.trade_date: index for index, bar in enumerate(bars)},
            extras=extras,
        )
