"""统计分析方法 2（``stat_v2``）：最高价达成率 + 覆盖率。

规格来源：用户 2026-10-23 提供的《选股条件历史统计评估算法开发规格》（统计分析方法 2）。
本文件是那套规格的**完整实现**，纯算法：输入是已算好前瞻行情的逐条事件，输出是
八张表 + 中文报告，不依赖 HTTP、不依赖界面、也不依赖方法 1 的任何统计模块。

与分析方法 1 的区别（不是为了多一套而多一套）
------------------------------------------
* 方法 1 问「持有到第 N 天，收盘涨了没有」——衡量**能不能拿住**。
* 方法 2 问「N 天内摸到过多高的价」——衡量**有没有机会**，与卖出时机无关，
  所以窗口越长数越大（这是定义，不是缺陷），可用来回答「这个条件选出来的票，
  一周内给不给 3% 的机会」。
* 方法 2 额外给「按日期」的覆盖率：某天命中 50 只，有几只达到目标 —— 这是
  选股条件在**组合层面**是否有用的直接指标（方法 1 只按条统计，不看同日密集度）。

口径（与规格逐条对应）
--------------------
1. 买入价 = 信号日之后第一个有行情的交易日的**开盘价**（后复权）。规格写的是「下一
   交易日开盘价」；如果次日停牌，取停牌结束后的第一个开盘价，并把推后的天数记进
   ``entry_days``。
2. 窗口 N 的累计最高价 = 第 1..N 个交易日的最高价（后复权）中的最大值；
   ``max_return_N = max_high_N / buy_price - 1``。
   停牌日没有行情：不参与取最大/最小（等价于「按停牌前价格」，即不新增波动），
   并计入 ``avail``（真有行情的天数）。
3. 0% 目标严格大于 0，其余目标 ``>= target``。
4. 缺失/停牌/退市/异常行情单独记录原因，**不**视为盈利或亏损。
5. 窗口是累计的，所以 ``max_return_5 <= max_return_10 <= … <= max_return_35`` 恒成立；
   这一条在 ``check_invariants`` 里做自检（写进数据质量报告）。
6. 主表只用「35 个交易日完整」的样本（规格第 4 节的「主分析集」），同时给出宽松样本数。
"""

from __future__ import annotations

import csv
import math
import os
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

from .contracts import (
    Artifact,
    Column,
    Headline,
    MethodSpec,
    ParamSpec,
    StandardReport,
    Table,
    cap_rows,
    metric,
)

#: 观察窗口（规格 2 节固定参数）
WINDOWS: tuple[int, ...] = (5, 10, 15, 20, 25, 35)
#: 涨幅目标（小数）；0% 用严格大于，其余 >=
RETURN_TARGETS: tuple[float, ...] = (0.01, 0.02, 0.03, 0.05, 0.10)
#: 主分析集要求的天数（= 最长窗口）
FULL_DAYS = WINDOWS[-1]

METHOD = MethodSpec(
    id="stat_v2",
    name="统计分析方法 2：最高价达成率与覆盖率",
    version="v1",
    summary=(
        "逐日回放条件选股，统计命中后 5/10/15/20/25/35 个交易日内「最高价」相对次日开盘"
        "买入价的涨幅，给出 1%/2%/3%/5%/10% 目标的达成率、逐日覆盖率与对照基准。"
    ),
    forward_days=FULL_DAYS,
    windows=WINDOWS,
    targets=RETURN_TARGETS,
    params=(),
    outputs=(
        "stock_event_metrics.csv",
        "window_summary.csv",
        "target_edge.csv",
        "return_distribution.csv",
        "date_summary.csv",
        "coverage_summary.csv",
        "data_quality_report.csv",
        "baseline_comparison.csv",
        "stock_summary.csv",
        "report.md",
    ),
    caliber="次日开盘买入（后复权），不扣成本；统计的是窗口内最高价，不是卖出收益",
    entry="d0 收盘出信号，d0+1 开盘成交（停牌则顺延到复牌首日）",
)

#: 涨幅分布的分档（百分数，左闭右开，最后一档含右端）
_DIST_EDGES: tuple[tuple[float, float, str], ...] = (
    (-999.0, -10.0, "跌超 10%"),
    (-10.0, -5.0, "-10% ~ -5%"),
    (-5.0, -3.0, "-5% ~ -3%"),
    (-3.0, 0.0, "-3% ~ 0%"),
    (0.0, 1.0, "0% ~ 1%"),
    (1.0, 3.0, "1% ~ 3%"),
    (3.0, 5.0, "3% ~ 5%"),
    (5.0, 10.0, "5% ~ 10%"),
    (10.0, 1e9, "10% 以上"),
)


# --------------------------------------------------------------------------- #
# 数据结构
# --------------------------------------------------------------------------- #
@dataclass(slots=True)
class Event:
    """一条已算好前瞻极值的选股事件。"""

    d0: str
    code: str
    name: str
    buy_price: float
    #: window → 窗口内最高价（后复权，绝对价）
    highs: dict[int, float] = field(default_factory=dict)
    #: window → 窗口内最低价（后复权）
    lows: dict[int, float] = field(default_factory=dict)
    avail: int = 0
    is_control: bool = False
    valid: bool = True
    reason: str = ""
    entry_days: int = 1
    extra: dict[str, Any] = field(default_factory=dict)

    def max_return(self, window: int) -> Optional[float]:
        if not self.valid or self.buy_price <= 0:
            return None
        high = self.highs.get(window)
        if high is None or high <= 0:
            return None
        return high / self.buy_price - 1.0

    def adverse_return(self, window: int) -> Optional[float]:
        if not self.valid or self.buy_price <= 0:
            return None
        low = self.lows.get(window)
        if low is None or low <= 0:
            return None
        return low / self.buy_price - 1.0

    def hit(self, window: int, target: float) -> Optional[bool]:
        value = self.max_return(window)
        if value is None:
            return None
        if target <= 0:
            return value > 0
        return value >= target


# --------------------------------------------------------------------------- #
# 基础统计（自己实现，保持本文件可独立运行）
# --------------------------------------------------------------------------- #
def wilson(wins: int, n: int, z: float = 1.96) -> tuple[Optional[float], Optional[float]]:
    """Wilson 95% 区间（返回百分数）。``n=0`` 时给 ``(None, None)``。"""
    if n <= 0:
        return None, None
    p = wins / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return round(max(0.0, (centre - half) * 100), 2), round(min(1.0, (centre + half) * 100), 2)


def _mean(values: Sequence[float]) -> Optional[float]:
    return sum(values) / len(values) if values else None


def _median(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def _std(values: Sequence[float]) -> Optional[float]:
    if len(values) < 2:
        return None
    avg = sum(values) / len(values)
    return math.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1))


def _quantile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[int(position)]
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def _round(value: Optional[float], digits: int = 2) -> Optional[float]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), digits)


def _pct(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value * 100.0, 4)


def target_key(target: float) -> str:
    """``0.03`` → ``3pct``（列名/文件名用）。"""
    return f"{round(target * 100)}pct"


def _label(target: float) -> str:
    return f"≥{round(target * 100)}%"


# --------------------------------------------------------------------------- #
# 单条事件 → 逐条指标
# --------------------------------------------------------------------------- #
def event_metrics(event: Event, windows: Sequence[int] = WINDOWS,
                  targets: Sequence[float] = RETURN_TARGETS) -> dict[str, Any]:
    """一条事件的完整指标行（对应 `stock_event_metrics.csv` 的一行）。"""
    row: dict[str, Any] = {
        "signal_date": event.d0,
        "stock_code": event.code,
        "stock_name": event.name,
        "group": "control" if event.is_control else "signal",
        "buy_open": _round(event.buy_price, 4),
        "entry_days": int(event.entry_days),
        "avail_days": int(event.avail),
        "valid": int(event.valid),
        "reason": event.reason,
    }
    for window in windows:
        value = event.max_return(window)
        row[f"max_return_{window}d_pct"] = _round(_pct(value))
        row[f"adverse_{window}d_pct"] = _round(_pct(event.adverse_return(window)))
        for target in targets:
            hit = event.hit(window, target)
            row[f"hit_{window}d_{target_key(target)}"] = None if hit is None else int(hit)
    return row


# --------------------------------------------------------------------------- #
# 窗口汇总
# --------------------------------------------------------------------------- #
def window_summary(events: Iterable[Event], windows: Sequence[int] = WINDOWS,
                   targets: Sequence[float] = RETURN_TARGETS) -> list[dict[str, Any]]:
    """每个窗口的均值/中位数/分位数/胜率/达标率（含 Wilson 区间）。"""
    items = [event for event in events if event.valid]
    rows: list[dict[str, Any]] = []
    for window in windows:
        values = [value for value in (event.max_return(window) for event in items) if value is not None]
        n = len(values)
        positive = sum(1 for value in values if value > 0)
        low, high = wilson(positive, n)
        row: dict[str, Any] = {
            "window": window,
            "valid": n,
            "mean_pct": _round(_pct(_mean(values))),
            "median_pct": _round(_pct(_median(values))),
            "std_pct": _round(_pct(_std(values))),
            "p25_pct": _round(_pct(_quantile(values, 0.25))),
            "p75_pct": _round(_pct(_quantile(values, 0.75))),
            "positive": positive,
            "positive_rate": _round(100.0 * positive / n) if n else None,
            "ci_low": low,
            "ci_high": high,
        }
        for target in targets:
            hits = sum(1 for event in items if event.hit(window, target))
            row[f"hit_{target_key(target)}"] = hits
            row[f"hit_{target_key(target)}_rate"] = _round(100.0 * hits / n) if n else None
        rows.append(row)
    return rows


def return_distribution(events: Iterable[Event], windows: Sequence[int] = WINDOWS) -> list[dict[str, Any]]:
    """互斥涨幅区间的样本数与占比（每个窗口一行一档）。"""
    items = [event for event in events if event.valid]
    rows: list[dict[str, Any]] = []
    for window in windows:
        values = [value for value in (event.max_return(window) for event in items) if value is not None]
        total = len(values)
        for low, high, label in _DIST_EDGES:
            count = sum(1 for value in values if low <= value * 100 < high)
            rows.append({
                "window": window,
                "bucket": label,
                "count": count,
                "share_pct": _round(100.0 * count / total) if total else None,
            })
    return rows


# --------------------------------------------------------------------------- #
# 按日期 / 覆盖率 / 按股票
# --------------------------------------------------------------------------- #
def _by_date(events: Iterable[Event]) -> dict[str, list[Event]]:
    buckets: dict[str, list[Event]] = {}
    for event in events:
        if not event.is_control:
            buckets.setdefault(event.d0, []).append(event)
    return buckets


def date_summary(events: Iterable[Event], windows: Sequence[int] = WINDOWS,
                 targets: Sequence[float] = RETURN_TARGETS) -> list[dict[str, Any]]:
    """逐日期 × 窗口 × 目标（长表，对应 `date_summary.csv`）。"""
    rows: list[dict[str, Any]] = []
    buckets = _by_date(events)
    for d0 in sorted(buckets):
        group = buckets[d0]
        valid = [event for event in group if event.valid]
        for window in windows:
            for target in targets:
                hits = sum(1 for event in valid if event.hit(window, target))
                rows.append({
                    "signal_date": d0,
                    "window": window,
                    "target": _label(target),
                    "stock_count": len(group),
                    "valid_stock_count": len(valid),
                    "hit_count": hits,
                    "hit_ratio": _round(100.0 * hits / len(valid)) if valid else None,
                })
    return rows


def coverage_summary(date_rows: Sequence[dict[str, Any]],
                     windows: Sequence[int] = WINDOWS,
                     targets: Sequence[float] = RETURN_TARGETS) -> list[dict[str, Any]]:
    """每个窗口 × 目标的「盈利机会覆盖率」：至少一只有效命中目标的日期占比。"""
    rows: list[dict[str, Any]] = []
    for window in windows:
        for target in targets:
            label = _label(target)
            subset = [row for row in date_rows
                      if row["window"] == window and row["target"] == label and row["valid_stock_count"] > 0]
            if not subset:
                rows.append({"window": window, "target": label, "days": 0,
                             "days_with_hit": 0, "coverage_rate": None, "avg_daily_hit_ratio": None})
                continue
            with_hit = sum(1 for row in subset if row["hit_count"] > 0)
            ratios = [row["hit_ratio"] for row in subset if row["hit_ratio"] is not None]
            rows.append({
                "window": window,
                "target": label,
                "days": len(subset),
                "days_with_hit": with_hit,
                "coverage_rate": _round(100.0 * with_hit / len(subset)),
                "avg_daily_hit_ratio": _round(_mean(ratios)),
            })
    return rows


def stock_summary(events: Iterable[Event], windows: Sequence[int] = WINDOWS,
                  targets: Sequence[float] = RETURN_TARGETS) -> list[dict[str, Any]]:
    """按股票的达成率（用户要的「对哪些股票特别有效」）。"""
    buckets: dict[str, list[Event]] = {}
    for event in events:
        if event.is_control or not event.valid:
            continue
        buckets.setdefault(event.code, []).append(event)
    rows: list[dict[str, Any]] = []
    for code, group in buckets.items():
        row: dict[str, Any] = {
            "code": code,
            "name": group[0].name,
            "n": len(group),
            "industry": group[0].extra.get("industry") or "",
        }
        for window in windows:
            values = [value for value in (event.max_return(window) for event in group) if value is not None]
            positives = sum(1 for value in values if value > 0)
            row[f"positive_{window}d"] = _round(100.0 * positives / len(values)) if values else None
            hits = sum(1 for event in group if event.hit(window, targets[2] if len(targets) > 2 else targets[0]))
            row[f"hit3_{window}d"] = _round(100.0 * hits / len(group)) if group else None
        rows.append(row)
    rows.sort(key=lambda item: (-item["n"], item["code"]))
    return rows


# --------------------------------------------------------------------------- #
# 对照基准
# --------------------------------------------------------------------------- #
def _date_rates(events: Iterable[Event], window: int) -> dict[str, float]:
    """每个日期的「上涨比例」（0–100）。"""
    rates: dict[str, float] = {}
    for d0, group in _by_date(events).items():
        valid = [event for event in group if event.valid]
        if not valid:
            continue
        positives = sum(1 for event in valid if (event.max_return(window) or 0) > 0)
        rates[d0] = 100.0 * positives / len(valid)
    return rates


def aggregate_events(events: Iterable[Event], windows: Sequence[int] = WINDOWS,
                     targets: Sequence[float] = RETURN_TARGETS) -> dict[int, dict[str, Any]]:
    """把一组事件压成「每窗口的计数 + 每日比例」。

    对照组可能几十万条，全部保留成 ``Event`` 对象会吃掉几百 MB。统计对照组只需要
    「每个窗口多少条、多少条为正、每个目标命中多少、每天的比例」，所以压成计数即可 ——
    与 :func:`window_summary` 用的是同一组公式（``mh/buy-1``），SQL 版见
    :func:`load_control_aggregates`，两者必须一致（有单测对数）。
    """
    buckets: dict[int, dict[str, Any]] = {
        window: {"n": 0, "positives": 0, "hits": {target: 0 for target in targets}, "rates": {},
                 "target_rates": {target: {} for target in targets}}
        for window in windows
    }
    per_day: dict[int, dict[str, list[int]]] = {window: {} for window in windows}
    per_day_target: dict[int, dict[float, dict[str, list[int]]]] = {
        window: {target: {} for target in targets} for window in windows
    }
    for event in events:
        if not event.valid:
            continue
        for window in windows:
            value = event.max_return(window)
            if value is None:
                continue
            bucket = buckets[window]
            bucket["n"] += 1
            positive = 1 if value > 0 else 0
            bucket["positives"] += positive
            for target in targets:
                if value >= target:
                    bucket["hits"][target] += 1
                day_hit = per_day_target[window][target].setdefault(event.d0, [0, 0])
                day_hit[0] += 1
                day_hit[1] += 1 if value >= target else 0
            day = per_day[window].setdefault(event.d0, [0, 0])
            day[0] += 1
            day[1] += positive
    for window in windows:
        buckets[window]["rates"] = {
            d0: 100.0 * counts[1] / counts[0]
            for d0, counts in per_day[window].items() if counts[0]
        }
        for target in targets:
            buckets[window]["target_rates"][target] = {
                d0: 100.0 * counts[1] / counts[0]
                for d0, counts in per_day_target[window][target].items() if counts[0]
            }
    return buckets


def load_control_aggregates(conn: sqlite3.Connection,
                            windows: Sequence[int] = WINDOWS,
                            targets: Sequence[float] = RETURN_TARGETS) -> dict[int, dict[str, Any]]:
    """对照组按 SQL 聚合（不把几十万行读成对象）。

    只取值有效的行（``valid = 1``）—— 与信号组口径一致；``valid`` 已经排除停牌不完整、
    买不进、缺复权的事件。
    """
    select = ["d0", "COUNT(*) AS n"]
    for window in windows:
        select.append(
            f"SUM(CASE WHEN mh{window} / buy_price - 1 > 0 THEN 1 ELSE 0 END) AS pos{window}"
        )
        for target in targets:
            select.append(
                f"SUM(CASE WHEN mh{window} / buy_price - 1 >= {float(target)} THEN 1 ELSE 0 END) "
                f"AS hit{window}_{target_key(target)}"
            )
    sql = (
        f"SELECT {', '.join(select)} FROM m2_events "
        "WHERE is_control = 1 AND valid = 1 AND buy_price > 0 "
        "GROUP BY d0"
    )
    buckets: dict[int, dict[str, Any]] = {
        window: {"n": 0, "positives": 0, "hits": {target: 0 for target in targets}, "rates": {},
                 "target_rates": {target: {} for target in targets}}
        for window in windows
    }
    for row in conn.execute(sql):
        d0 = str(row["d0"])
        for window in windows:
            # 每个窗口的 n 相同（同一批行），但为了安全仍按窗口读自己的计数
            count = int(row["n"] or 0)
            positives = int(row[f"pos{window}"] or 0)
            bucket = buckets[window]
            bucket["n"] += count
            bucket["positives"] += positives
            if count:
                bucket["rates"][d0] = 100.0 * positives / count
            for target in targets:
                hits = int(row[f"hit{window}_{target_key(target)}"] or 0)
                bucket["hits"][target] += hits
                if count:
                    bucket["target_rates"][target][d0] = 100.0 * hits / count
    return buckets


def target_comparison(signal_events: Sequence[Event],
                      control: "Sequence[Event] | dict[int, dict[str, Any]]",
                      windows: Sequence[int] = WINDOWS,
                      targets: Sequence[float] = RETURN_TARGETS) -> list[dict[str, Any]]:
    """按「窗口 × 涨幅目标」比较达成率（这才是判断条件好坏的依据）。

    为什么不用 0% 目标（``positive_rate``）做结论：A 股任意一只股票在 5 个交易日内
    盘中摸到买入价上方的概率就有 97% 上下，0% 目标接近饱和，条件和随机买入都贴着
    100%，差不出东西。3%/5%/10% 这种真门槛才有区分度 —— 实测同一个条件 5 日
    ≥3% 达成率比基准高 7pp，而 >0 只高 0.08pp。
    """
    signal_agg = aggregate_events(signal_events, windows, targets)
    base = control if isinstance(control, dict) else aggregate_events(control, windows, targets)
    rows: list[dict[str, Any]] = []
    for window in windows:
        sig = signal_agg[window]
        agg = base.get(window) or {"n": 0, "hits": {}, "target_rates": {}}
        if not sig["n"] or not agg.get("n"):
            continue
        for target in targets:
            sig_rate = 100.0 * sig["hits"][target] / sig["n"]
            base_rate = 100.0 * float((agg.get("hits") or {}).get(target) or 0) / int(agg["n"])
            test = paired_day_test(
                sig["target_rates"].get(target) or {},
                (agg.get("target_rates") or {}).get(target) or {},
            )
            rows.append({
                "window": window,
                "target": _label(target),
                "target_pct": round(target * 100),
                "signal_n": sig["n"],
                "baseline_n": int(agg["n"]),
                "signal_rate": _round(sig_rate),
                "baseline_rate": _round(base_rate),
                "difference_pp": _round(sig_rate - base_rate),
                "paired_days": test["days"],
                "paired_t": test["t"],
            })
    return rows


#: 振幅分层（信号日振幅，%）：方法 2 的「摸到过高价」会随波动率机械变大，
#: 所以必须看同一振幅档内的超额，否则把波动率当成条件优势。
_AMP_BUCKETS: tuple[tuple[str, float | None, float | None], ...] = (
    ("<3%", None, 3.0),
    ("3-5%", 3.0, 5.0),
    ("5-7%", 5.0, 7.0),
    ("7-10%", 7.0, 10.0),
    (">=10%", 10.0, None),
)


def _amp_case(column: str = "amplitude") -> str:
    whens = []
    for label, low, high in _AMP_BUCKETS:
        parts = []
        if low is not None:
            parts.append(f"{column} >= {low}")
        if high is not None:
            parts.append(f"{column} < {high}")
        whens.append(f"WHEN {' AND '.join(parts)} THEN '{label}'")
    return "CASE " + " ".join(whens) + " ELSE 'NA' END"


def amplitude_adjusted(conn: sqlite3.Connection, windows: Sequence[int] = WINDOWS,
                       targets: Sequence[float] = RETURN_TARGETS) -> dict[int, dict[float, dict[str, Any]]]:
    """按信号日振幅分层后的超额（控制波动率）。

    条件选出来的股票振幅明显更大（实测平均 5.73% vs 基准 4.50%），而「窗口内最高价
    摸到 +5%」本身就会随波动率变大 —— 不分层的话，+7pp 里有一半只是「更波动」。
    这里按振幅档做直接标准化：档内算条件减基准，再按条件组在各档的样本量加权。
    """
    result: dict[int, dict[float, dict[str, Any]]] = {window: {} for window in windows}
    for window in windows:
        sums = [f"SUM(CASE WHEN mh{window} / buy_price - 1 >= {float(target)} THEN 1 ELSE 0 END) "
                f"AS hit_{target_key(target)}" for target in targets]
        sql = (
            f"SELECT {_amp_case()} AS bucket, is_control, COUNT(*) AS n, {', '.join(sums)} "
            "FROM m2_events WHERE valid = 1 AND amplitude IS NOT NULL "
            "GROUP BY bucket, is_control"
        )
        table: dict[str, dict[int, sqlite3.Row]] = {}
        for row in conn.execute(sql):
            table.setdefault(str(row["bucket"]), {})[int(row["is_control"])] = row
        for target in targets:
            buckets: list[dict[str, Any]] = []
            weighted_sum = 0.0
            weight_total = 0.0
            for label, _low, _high in _AMP_BUCKETS:
                pair = table.get(label) or {}
                sig = pair.get(0)
                ctl = pair.get(1)
                if sig is None or ctl is None or not int(sig["n"]) or not int(ctl["n"]):
                    continue
                sig_n = int(sig["n"])
                ctl_n = int(ctl["n"])
                sig_hits = int(sig[f"hit_{target_key(target)}"] or 0)
                ctl_hits = int(ctl[f"hit_{target_key(target)}"] or 0)
                sig_rate = 100.0 * sig_hits / sig_n
                ctl_rate = 100.0 * ctl_hits / ctl_n
                diff = sig_rate - ctl_rate
                buckets.append({
                    "bucket": label,
                    "signal_n": sig_n,
                    "control_n": ctl_n,
                    "signal_rate": _round(sig_rate),
                    "control_rate": _round(ctl_rate),
                    "diff_pp": _round(diff),
                })
                weighted_sum += diff * sig_n
                weight_total += sig_n
            result[window][target] = {
                "adjusted_pp": _round(weighted_sum / weight_total) if weight_total else None,
                "buckets": buckets,
            }
    return result


def paired_day_test(signal_rates: dict[str, float], base_rates: dict[str, float]) -> dict[str, Any]:
    """按日期配对检验超额（同一天条件组 vs 基准组）。

    同一只股票连续命中、同日大量命中都会让逐条检验的显著性虚高（方法 1 实测放大
    3–10 倍），所以这里按日期先算差，再对日序列做 t 检验。
    """
    diffs = [signal_rates[d0] - base_rates[d0] for d0 in signal_rates if d0 in base_rates]
    days = len(diffs)
    if days < 2:
        return {"days": days, "mean_pp": _round(diffs[0]) if diffs else None,
                "se_pp": None, "t": None}
    mean = sum(diffs) / days
    variance = sum((value - mean) ** 2 for value in diffs) / (days - 1)
    se = math.sqrt(variance / days)
    if se <= 0:
        # 每个交易日的差值完全一致：t 在数学上是无穷大。JSON 不能写 Infinity，
        # 给一个 ±99 的哨兵值（显著性判断只看 |t| ≥ 2），并在报告里保留真实均值。
        t = 0.0 if abs(mean) < 1e-9 else math.copysign(99.0, mean)
    else:
        t = mean / se
    return {
        "days": days,
        "mean_pp": _round(mean),
        "se_pp": _round(se, 3),
        "t": _round(t, 2),
    }


def baseline_comparison(signal_events: Sequence[Event],
                         control: "Sequence[Event] | dict[int, dict[str, Any]]",
                         windows: Sequence[int] = WINDOWS,
                         targets: Sequence[float] = RETURN_TARGETS) -> list[dict[str, Any]]:
    """信号组 vs 基准组。``control`` 可以是事件列表，也可以是聚合结果。"""
    signal_summary = {row["window"]: row for row in window_summary(signal_events, windows, targets)}
    base = control if isinstance(control, dict) else aggregate_events(control, windows, targets)
    rows: list[dict[str, Any]] = []
    for window in windows:
        sig = signal_summary.get(window) or {}
        agg = base.get(window) or {"n": 0, "positives": 0, "hits": {}, "rates": {}}
        sig_rate = sig.get("positive_rate")
        total = int(agg.get("n") or 0)
        base_rate = _round(100.0 * float(agg.get("positives") or 0) / total) if total else None
        test = paired_day_test(_date_rates(signal_events, window), agg.get("rates") or {})
        row: dict[str, Any] = {
            "window": window,
            "signal_n": sig.get("valid"),
            "baseline_n": total,
            "signal_rate": sig_rate,
            "baseline_rate": base_rate,
            "difference_pp": _round(sig_rate - base_rate) if sig_rate is not None and base_rate is not None else None,
            "paired_days": test["days"],
            "paired_t": test["t"],
        }
        for target in targets:
            key = f"hit_{target_key(target)}_rate"
            sig_hit = sig.get(key)
            base_hit = (_round(100.0 * float((agg.get("hits") or {}).get(target) or 0) / total)
                        if total else None)
            row[f"signal_{key}"] = sig_hit
            row[f"baseline_{key}"] = base_hit
            row[f"diff_{key}"] = (_round(sig_hit - base_hit)
                                  if sig_hit is not None and base_hit is not None else None)
        rows.append(row)
    return rows


# --------------------------------------------------------------------------- #
# 自检（规格第 10 节）
# --------------------------------------------------------------------------- #
def check_invariants(events: Sequence[Event], summary: Sequence[dict[str, Any]],
                     windows: Sequence[int] = WINDOWS,
                     targets: Sequence[float] = RETURN_TARGETS) -> list[str]:
    """返回违反的验收条件（空列表 = 全部通过）。"""
    problems: list[str] = []
    # 1. 累计窗口必须包含之前的窗口
    for event in events:
        if not event.valid:
            continue
        previous: Optional[float] = None
        for window in windows:
            value = event.max_return(window)
            if value is None:
                continue
            if previous is not None and value < previous - 1e-9:
                problems.append(f"{event.d0} {event.code} 第 {window} 日涨幅小于更短窗口")
                break
            previous = value
    # 2. 达标率随目标提高不得增加
    for row in summary:
        previous_hit: Optional[float] = None
        for target in sorted(targets):
            rate = row.get(f"hit_{target_key(target)}_rate")
            if rate is None:
                continue
            if previous_hit is not None and rate > previous_hit + 1e-9:
                problems.append(f"第 {row['window']} 日：{_label(target)} 达成率高于更低的门槛")
                break
            previous_hit = rate
    # 3. 达标率随窗口延长不得降低
    by_window = {row["window"]: row for row in summary}
    for target in targets:
        key = f"hit_{target_key(target)}_rate"
        previous: Optional[float] = None
        for window in windows:
            rate = (by_window.get(window) or {}).get(key)
            if rate is None:
                continue
            if previous is not None and rate < previous - 1e-9:
                problems.append(f"{_label(target)} 在第 {window} 日达成率低于更短窗口")
                break
            previous = rate
    # 4. 每个比例都能从计数复算
    for row in summary:
        n = row.get("valid") or 0
        positive = row.get("positive") or 0
        if n and abs((row.get("positive_rate") or 0) - 100.0 * positive / n) > 0.01:
            problems.append(f"第 {row['window']} 日 positive_rate 与计数不符")
        for target in targets:
            hits = row.get(f"hit_{target_key(target)}") or 0
            rate = row.get(f"hit_{target_key(target)}_rate") or 0
            if n and abs(rate - 100.0 * hits / n) > 0.01:
                problems.append(f"第 {row['window']} 日 {_label(target)} 达成率与计数不符")
    return problems


def data_quality(signal_events: Sequence[Event], control_events: Sequence[Event],
                 duplicate_rows: int = 0) -> list[dict[str, Any]]:
    """异常清单（对应 `data_quality_report.csv`）。"""
    rows: list[dict[str, Any]] = []
    for group_name, events in (("signal", signal_events), ("control", control_events)):
        reasons: dict[str, int] = {}
        for event in events:
            if event.valid:
                continue
            key = event.reason or "unknown"
            reasons[key] = reasons.get(key, 0) + 1
        rows.append({
            "group": group_name,
            "rows": len(events),
            "valid": sum(1 for event in events if event.valid),
            "invalid": sum(1 for event in events if not event.valid),
            "reason": "；".join(f"{key}={value}" for key, value in sorted(reasons.items())) or "",
        })
    if duplicate_rows:
        rows.append({"group": "signal", "rows": duplicate_rows, "valid": 0, "invalid": duplicate_rows,
                     "reason": "duplicate_event(同一天同一只股票重复计入，已去重)"})
    return rows


# --------------------------------------------------------------------------- #
# 结论
# --------------------------------------------------------------------------- #
def _excess_by_window(summary: Sequence[dict[str, Any]],
                      baseline: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    base_map = {row["window"]: row for row in baseline}
    items = []
    for row in summary:
        base = base_map.get(row["window"]) or {}
        signal_rate = row.get("positive_rate")
        base_rate = base.get("baseline_rate")
        if signal_rate is None or base_rate is None:
            continue
        items.append({
            "window": row["window"],
            "excess_pp": _round(signal_rate - base_rate),
            "t": base.get("paired_t"),
            "days": base.get("paired_days"),
            "signal_rate": signal_rate,
            "baseline_rate": base_rate,
        })
    return items


def headline_for(summary: Sequence[dict[str, Any]], baseline: Sequence[dict[str, Any]],
                 quality: Sequence[dict[str, Any]], days: int,
                 target_rows: Sequence[dict[str, Any]] | None = None) -> Headline:
    """五档结论（与方法 1 同一套语义，便于跨方法比较）。

    判定用「窗口 × 目标」的达成率差（``target_rows``），不用 0% 上涨概率：
    后者在 A 股接近饱和（97%+），条件和随机买入几乎一样，拿它做结论等于没结论。
    """
    valid = sum(int(row.get("valid") or 0) for row in summary if row["window"] == WINDOWS[0])
    if valid < 100 or days < 20:
        return Headline(
            verdict="insufficient",
            title="样本不足，给不出结论",
            detail=f"有效事件 {valid} 条、交易日 {days} 天，先扩大区间再判断。",
            metrics=[metric("sample", "有效事件", valid, "条"),
                     metric("days", "交易日", days, "天")],
        )
    rows = [row for row in (target_rows or []) if row.get("difference_pp") is not None]
    if not rows:
        best = max(summary, key=lambda row: row.get("positive_rate") or 0)
        return Headline(
            verdict="unrated",
            title="没有对照基准，只能看绝对水平",
            detail=f"{best['window']} 日内上涨概率 {best.get('positive_rate')}%（无基准，不做优劣判断）。",
            metrics=[metric("best_window", "上涨概率最高的窗口", best["window"], "日"),
                     metric("rate", "上涨概率", best.get("positive_rate"), "%"),
                     metric("sample", "有效事件", valid, "条")],
        )

    def _significant(row: dict[str, Any], direction: int) -> bool:
        # 有「控制波动率」的调整值时用它，否则用原始差 —— 条件天然偏爱高波动股，
        # 只用原始差会把波动率当成条件优势
        value = row.get("adjusted_pp")
        if value is None:
            value = row.get("difference_pp") or 0.0
        stat = row.get("paired_t")
        if stat is None:
            return False
        return value * direction >= 2.0 and stat * direction >= 2.0

    usable = [row for row in rows if _significant(row, 1)]
    worse = [row for row in rows if _significant(row, -1)]
    best = max(rows, key=lambda row: row["difference_pp"])
    worst = min(rows, key=lambda row: row["difference_pp"])

    adjusted_note = ""
    if best.get("adjusted_pp") is not None:
        adjusted_note = (f"控制振幅（波动率）后为 {best['adjusted_pp']}pp"
                         f"（原始 {best['difference_pp']}pp）。")

    if usable and worse:
        head = Headline(
            verdict="mixed",
            title="结论不一致：部分窗口/目标高于基准、部分低于",
            detail=(f"最好的 {best['window']} 日 {best['target']} 达成率 {best['signal_rate']}%"
                    f"（基准 {best['baseline_rate']}%，{best['difference_pp']}pp），"
                    f"最差的 {worst['window']} 日 {worst['target']} 为 {worst['difference_pp']}pp。"),
        )
    elif len(usable) >= 2:
        head = Headline(
            verdict="usable",
            title="这个条件明显好于同期随机买入",
            detail=(f"{best['window']} 日内达到 {best['target']} 的比例 {best['signal_rate']}%，"
                    f"基准 {best['baseline_rate']}%，高 {best['difference_pp']}pp"
                    f"（按日配对 t={best['paired_t']}）。{adjusted_note}"),
        )
    elif len(worse) >= 2:
        head = Headline(
            verdict="worse",
            title="这个条件比同期随机买入更差",
            detail=(f"{worst['window']} 日内达到 {worst['target']} 的比例 {worst['signal_rate']}%，"
                    f"基准 {worst['baseline_rate']}%，低 {abs(worst['difference_pp'])}pp"
                    f"（按日配对 t={worst['paired_t']}）。"),
        )
    else:
        # 「统计显著」和「有优势」是两件事：原始差常常显著（t>10），但控制振幅后
        # 不到门槛 —— 这时候说「达不到显著」会自相矛盾（t 明明很大），必须分开说。
        raw_sig = (abs(best.get("difference_pp") or 0.0) >= 2.0
                   and abs(best.get("paired_t") or 0.0) >= 2.0)
        adj_value = best.get("adjusted_pp")
        if raw_sig and adj_value is not None and abs(adj_value) < 2.0:
            # 原始差显著、调整后不显著：一句话说完，别再重复 t 和 adjusted 数字
            detail = (f"最好的组合是 {best['window']} 日 / {best['target']}："
                      f"{best['signal_rate']}% 对基准 {best['baseline_rate']}%"
                      f"（{best['difference_pp']}pp，按日配对 t={best['paired_t']}）。"
                      f"统计上显著，但控制振幅（波动率）后只剩 {adj_value}pp，低于 2pp 门槛"
                      f" —— 条件选出来的票波动更大，不是更准。")
        else:
            detail = (f"最好的组合是 {best['window']} 日 / {best['target']}："
                      f"{best['signal_rate']}% 对基准 {best['baseline_rate']}%"
                      f"（{best['difference_pp']}pp，t={best['paired_t']}），"
                      f"达不到显著。{adjusted_note}")
        head = Headline(
            verdict="no_edge",
            title="没有可确认的优势",
            detail=detail,
        )
    head.metrics = [
        metric("best_window", "最优窗口", best["window"], "日"),
        metric("best_target", "最优目标", best["target"], ""),
        metric("excess", "超额", best["difference_pp"], "pp"),
        metric("adjusted", "控制波动率后", best.get("adjusted_pp"), "pp"),
        metric("rate", "达成率", best["signal_rate"], "%"),
        metric("baseline", "基准", best["baseline_rate"], "%"),
        metric("sample", "有效事件", valid, "条"),
        metric("days", "交易日", days, "天"),
        metric("n_eff", "有效样本", max(1, days // int(best["window"] or 1)), "段"),
    ]
    return head


# --------------------------------------------------------------------------- #
# 表格（统一信封）
# --------------------------------------------------------------------------- #
def _summary_table(summary: Sequence[dict[str, Any]]) -> Table:
    columns = [
        Column("window", "窗口", "int"),
        Column("valid", "有效样本", "int"),
        Column("mean_pct", "平均最高涨幅", "percent"),
        Column("median_pct", "中位", "percent"),
        Column("p25_pct", "25 分位", "percent"),
        Column("p75_pct", "75 分位", "percent"),
        Column("positive_rate", "上涨概率", "percent"),
        Column("ci_low", "区间下限", "percent"),
        Column("ci_high", "区间上限", "percent"),
    ]
    columns += [Column(f"hit_{target_key(target)}_rate", f"{_label(target)} 达成率", "percent")
                for target in RETURN_TARGETS]
    return Table(key="window_summary", title="各窗口最高价达成率",
                 hint="涨幅 = 窗口内最高价 / 次日开盘买入价；累计窗口，所以越长的窗口数值不会更小",
                 columns=columns, rows=list(summary), sort_key="window", sort_order="asc")


def _target_table(rows: Sequence[dict[str, Any]]) -> Table:
    return Table(
        key="target_edge",
        title="各目标达成率与基准对比（判断依据）",
        hint="0% 目标（单纯「摸到买入价上方」）在 A 股接近饱和，条件与随机买入都贴着 97%，"
             "所以结论只看 3%/5%/10% 这种真门槛；t 为按日配对检验",
        columns=[
            Column("window", "窗口", "int"),
            Column("target", "目标", "text"),
            Column("signal_n", "条件样本", "int"),
            Column("baseline_n", "基准样本", "int"),
            Column("signal_rate", "条件达成率", "percent"),
            Column("baseline_rate", "基准达成率", "percent"),
            Column("difference_pp", "差", "pp"),
            Column("adjusted_pp", "控制波动率后", "pp"),
            Column("paired_days", "配对交易日", "int"),
            Column("paired_t", "t", "number"),
        ],
        rows=list(rows), sort_key="difference_pp",
    )


def _amplitude_table(buckets: Sequence[dict[str, Any]], window: int, target: str) -> Table:
    return Table(
        key="amplitude",
        title=f"按信号日振幅分层（{window} 日 / {target}）",
        hint="同一振幅档内比较条件与基准；条件选出来的股票本来就更波动，不分层会把波动率当成优势",
        columns=[
            Column("bucket", "振幅", "text"),
            Column("signal_n", "条件样本", "int"),
            Column("control_n", "基准样本", "int"),
            Column("signal_rate", "条件达成率", "percent"),
            Column("control_rate", "基准达成率", "percent"),
            Column("diff_pp", "差", "pp"),
        ],
        rows=list(buckets), sort_key="diff_pp",
    )


def _distribution_table(rows: Sequence[dict[str, Any]]) -> Table:
    return Table(
        key="distribution",
        title="最高涨幅分布",
        hint="每个窗口内互斥的涨幅区间，用来判断右尾够不够长、是否明显左偏",
        columns=[Column("window", "窗口", "int"), Column("bucket", "区间", "text"),
                 Column("count", "样本", "int"), Column("share_pct", "占比", "percent")],
        rows=list(rows), sort_key="window", sort_order="asc",
    )


def _coverage_table(rows: Sequence[dict[str, Any]]) -> Table:
    return Table(
        key="coverage",
        title="盈利机会覆盖率（按日期）",
        hint="有命中的交易日里，至少一只有效股票达到该目标的日期占比",
        columns=[Column("window", "窗口", "int"), Column("target", "目标", "text"),
                 Column("days", "有命中的交易日", "int"), Column("days_with_hit", "至少一只达标", "int"),
                 Column("coverage_rate", "覆盖率", "percent"),
                 Column("avg_daily_hit_ratio", "日均达标比例", "percent")],
        rows=list(rows), sort_key="window", sort_order="asc",
    )


def _baseline_table(rows: Sequence[dict[str, Any]]) -> Table:
    return Table(
        key="baseline",
        title="与同期随机买入的对比",
        hint="同一天、按命中股票市值档配比抽取的随机股票；t 为按日配对检验（重叠样本会让逐条检验虚高）",
        columns=[Column("window", "窗口", "int"), Column("signal_n", "条件样本", "int"),
                 Column("baseline_n", "基准样本", "int"),
                 Column("signal_rate", "条件上涨概率", "percent"),
                 Column("baseline_rate", "基准上涨概率", "percent"),
                 Column("difference_pp", "差", "pp"),
                 Column("paired_days", "配对交易日", "int"), Column("paired_t", "t", "number")],
        rows=list(rows), sort_key="window", sort_order="asc",
    )


def _stock_table(rows: Sequence[dict[str, Any]]) -> Table:
    columns = [Column("code", "代码", "text"), Column("name", "名称", "text"),
               Column("industry", "行业", "text"), Column("n", "命中次数", "int")]
    columns += [Column(f"positive_{window}d", f"{window} 日上涨概率", "percent") for window in WINDOWS]
    columns += [Column(f"hit3_{window}d", f"{window} 日 ≥3%", "percent") for window in WINDOWS]
    return Table(key="stocks", title="按股票（命中 ≥10 次）",
                 hint="命中次数少的股票概率不可靠：样本 <30 次的标灰，请结合「命中次数」看",
                 columns=columns, rows=[row for row in rows if int(row.get("n") or 0) >= 10],
                 total_rows=len(rows), sort_key="n")


def _quality_table(rows: Sequence[dict[str, Any]]) -> Table:
    return Table(
        key="quality",
        title="数据质量与异常清单",
        hint="缺失、停牌、退市、异常行情单独计数，不视为盈利或亏损",
        columns=[Column("group", "组", "text"), Column("rows", "行数", "int"),
                 Column("valid", "有效", "int"), Column("invalid", "无效", "int"),
                 Column("reason", "原因", "text")],
        rows=list(rows),
    )


# --------------------------------------------------------------------------- #
# CSV / Markdown
# --------------------------------------------------------------------------- #
def _write_csv(path: Path, columns: Sequence[str], rows: Sequence[dict[str, Any]]) -> None:
    """utf-8-sig：Excel 直接打开中文表头不乱码。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(columns), extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def _md_table(columns: Sequence[tuple[str, str]], rows: Sequence[dict[str, Any]]) -> str:
    head = "| " + " | ".join(label for _key, label in columns) + " |"
    sep = "| " + " | ".join("---" for _ in columns) + " |"
    body = []
    for row in rows:
        cells = []
        for key, _label in columns:
            value = row.get(key)
            cells.append("—" if value is None else str(value))
        body.append("| " + " | ".join(cells) + " |")
    return "\n".join([head, sep, *body])


def render_markdown(meta: dict[str, Any], headline: Headline, summary: Sequence[dict[str, Any]],
                    target_rows: Sequence[dict[str, Any]], baseline: Sequence[dict[str, Any]],
                    coverage: Sequence[dict[str, Any]], quality: Sequence[dict[str, Any]],
                    notes: Sequence[str]) -> str:
    lines = [
        f"# 条件「{meta.get('preset')}」统计分析方法 2 报告",
        "",
        f"- 区间：{meta.get('start_date')} ~ {meta.get('end_date')}（{meta.get('days_done')} 个交易日）",
        f"- 算法版本：{METHOD.version}；窗口：{' / '.join(str(w) for w in WINDOWS)} 个交易日",
        f"- 买入假设：{METHOD.entry}",
        "",
        "## 结论",
        "",
        f"**{headline.title}** — {headline.detail}",
        "",
        "## 各窗口达成率",
        "",
        _md_table([
            ("window", "窗口"), ("valid", "有效样本"), ("mean_pct", "平均最高涨幅%"),
            ("median_pct", "中位%"), ("positive_rate", "上涨概率%"),
            ("hit_1pct_rate", "≥1%"), ("hit_2pct_rate", "≥2%"), ("hit_3pct_rate", "≥3%"),
            ("hit_5pct_rate", "≥5%"), ("hit_10pct_rate", "≥10%"),
        ], summary),
        "",
        "## 目标达成率与基准对比（判断依据）",
        "",
        _md_table([
            ("window", "窗口"), ("target", "目标"), ("signal_rate", "条件达成率%"),
            ("baseline_rate", "基准达成率%"), ("difference_pp", "差（pp）"),
            ("paired_days", "配对交易日"), ("paired_t", "t"),
        ], target_rows),
        "",
        "## 与随机买入对比（0% 目标，仅供参考）",
        "",
        _md_table([
            ("window", "窗口"), ("signal_rate", "条件上涨概率%"), ("baseline_rate", "基准上涨概率%"),
            ("difference_pp", "差（pp）"), ("paired_days", "配对交易日"), ("paired_t", "t"),
        ], baseline),
        "",
        "## 覆盖率",
        "",
        _md_table([
            ("window", "窗口"), ("target", "目标"), ("days", "交易日"),
            ("days_with_hit", "至少一只达标"), ("coverage_rate", "覆盖率%"),
        ], [row for row in coverage if row["target"] == "≥3%"]),
        "",
        "## 数据质量",
        "",
        _md_table([("group", "组"), ("rows", "行数"), ("valid", "有效"),
                   ("invalid", "无效"), ("reason", "原因")], quality),
        "",
        "## 局限（必须与数字一起看）",
        "",
        "- 统计的是窗口内**最高价**达成率，不是真实卖出收益，也不是交易胜率。",
        "- 不扣交易成本；按次日开盘价成交，实际成交价可能更差。",
        "- 事件之间高度重叠（同一只股票连续命中、同日大量命中），按日配对检验只是缓解，不等于独立样本。",
        "- 退市股不在行情库、历史 ST 与行业为当前快照，存在幸存者偏差。",
    ]
    lines += [f"- {note}" for note in notes]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# 运行入口
# --------------------------------------------------------------------------- #
def load_events(conn: sqlite3.Connection, is_control: bool = False) -> tuple[list[Event], int]:
    """从 ``m2_events`` 读事件。返回 ``(events, 重复行数)``。"""
    columns = ["d0", "code", "name", "buy_price", "avail", "valid", "reason", "entry_days",
               "industry", "mcap", "amount", "turnover", "amplitude", "pe", "pb", "listed_days",
               *[f"mh{window}" for window in WINDOWS], *[f"ml{window}" for window in WINDOWS]]
    sql = f"SELECT {', '.join(columns)} FROM m2_events WHERE is_control = ?"
    events: list[Event] = []
    seen: set[tuple[str, str]] = set()
    duplicates = 0
    for row in conn.execute(sql, (1 if is_control else 0,)):
        key = (str(row["d0"]), str(row["code"]))
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        highs = {window: row[f"mh{window}"] for window in WINDOWS}
        lows = {window: row[f"ml{window}"] for window in WINDOWS}
        events.append(Event(
            d0=str(row["d0"]),
            code=str(row["code"]),
            name=str(row["name"] or ""),
            buy_price=float(row["buy_price"] or 0.0),
            highs={key: float(value) for key, value in highs.items() if value is not None},
            lows={key: float(value) for key, value in lows.items() if value is not None},
            avail=int(row["avail"] or 0),
            is_control=is_control,
            valid=bool(row["valid"]),
            reason=str(row["reason"] or ""),
            entry_days=int(row["entry_days"] or 0),
            extra={
                "industry": row["industry"], "mcap": row["mcap"], "amount": row["amount"],
                "turnover": row["turnover"], "amplitude": row["amplitude"], "pe": row["pe"],
                "pb": row["pb"], "listed_days": row["listed_days"],
            },
        ))
    return events, duplicates


def build_from_events(meta: dict[str, Any], signal_events: Sequence[Event],
                      control_events: "Sequence[Event] | dict[int, dict[str, Any]]",
                      duplicates: int = 0,
                      adjusted: dict[int, dict[float, dict[str, Any]]] | None = None,
                      ) -> tuple[StandardReport, dict[str, Any]]:
    """纯函数：事件 → 统一报告 + 产物数据（写文件由调用方做）。

    ``control_events`` 可以是事件列表（测试/小样本），也可以是
    :func:`load_control_aggregates` 的聚合结果（大任务，避免几十万个对象）。
    """
    summary = window_summary(signal_events)
    baseline = baseline_comparison(signal_events, control_events)
    target_rows = target_comparison(signal_events, control_events)
    if adjusted:
        for row in target_rows:
            info = (adjusted.get(int(row["window"])) or {}).get(float(row["target_pct"]) / 100.0) or {}
            row["adjusted_pp"] = info.get("adjusted_pp")
    coverage = coverage_summary(date_summary(signal_events))
    control_list = [] if isinstance(control_events, dict) else control_events
    control_rows = (sum(int(bucket.get("n") or 0) for bucket in control_events.values())
                    if isinstance(control_events, dict) else len(control_list))
    quality = data_quality(signal_events, control_list, duplicates)
    distribution = return_distribution(signal_events)
    stocks = stock_summary(signal_events)
    problems = check_invariants(signal_events, summary)

    dates = sorted({event.d0 for event in signal_events})
    headline = headline_for(summary, baseline, quality, len(dates), target_rows)
    if problems:
        headline.detail += f"（自检发现 {len(problems)} 处口径异常，见数据质量）"

    events_rows = [event_metrics(event) for event in signal_events]

    notes = [
        "「上涨概率」（0% 目标）在 A 股接近饱和：任意股票 5 个交易日内盘中摸到买入价上方的概率就有 97% 上下，"
        "所以判断条件好坏看 3%/5%/10% 的达成率差，不看这一列。",
        "方法 2 的达成率指窗口内最高价超过买入价加目标，窗口越长数值越大，不能用来挑「该拿几天」。",
        "判断条件好坏看「与随机买入对比」：同一天、同市场、按市值档配比抽样，t 为按日配对检验。",
        "「控制波动率后」是按信号日振幅分层的档内超额（按条件组样本量加权）；这个调整值没有单独的区间估计，"
        "t 仍是原始差值的按日配对检验，两者要一起看。",
        "退市股不在行情库里；历史 ST 状态与行业分类是当前快照。",
    ]
    if problems:
        notes.append("自检异常：" + "；".join(problems[:5]))

    best_row = max(target_rows, key=lambda row: row["difference_pp"]) if target_rows else None
    amp_table = None
    if adjusted and best_row:
        info = ((adjusted.get(int(best_row["window"])) or {})
                .get(float(best_row["target_pct"]) / 100.0) or {})
        if info.get("buckets"):
            amp_table = _amplitude_table(info["buckets"], int(best_row["window"]), str(best_row["target"]))

    tables = [
        _summary_table(summary),
        _target_table(target_rows),
        _baseline_table(baseline),
        _coverage_table(coverage),
        _distribution_table(distribution),
        _stock_table(stocks),
        _quality_table(quality),
    ]
    if amp_table is not None:
        tables.insert(2, amp_table)
    limited: list[Table] = []
    for table in tables:
        rows, total = cap_rows(table.rows, 300 if table.key == "coverage" else 200)
        table.rows = rows
        table.total_rows = max(total, table.total_rows or 0)
        limited.append(table)

    report = StandardReport(
        method=METHOD,
        parameters={
            "windows": list(WINDOWS),
            "targets": list(RETURN_TARGETS),
            "full_days": FULL_DAYS,
            "strict_only": True,
        },
        headline=headline,
        tables=limited,
        artifacts=[Artifact(name=name, kind=("md" if name.endswith(".md") else "csv"))
                   for name in METHOD.outputs],
        data_quality={
            "rows": quality,
            "events": len(signal_events),
            "control_events": control_rows,
            "valid_events": sum(1 for event in signal_events if event.valid),
            "duplicates": duplicates,
            "invariant_problems": problems,
            "days": len(dates),
        },
        notes=notes,
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"),
    )
    payload = {
        "events": events_rows,
        "window_summary": summary,
        "target_edge": target_rows,
        "distribution": distribution,
        "date_summary": date_summary(signal_events),
        "coverage": coverage,
        "quality": quality,
        "baseline": baseline,
        "stocks": stocks,
        "markdown": render_markdown(meta, headline, summary, target_rows, baseline, coverage,
                                    quality, notes),
    }
    return report, payload


def _fallback_columns(key: str) -> list[str]:
    """空产物也要有表头：下游拿 CSV 直接读列，空文件没有列会让人以为坏了。"""
    if key == "events":
        return list(event_metrics(Event(d0="", code="", name="", buy_price=1.0)).keys())
    if key == "target_edge":
        return ["window", "target", "signal_n", "baseline_n", "signal_rate", "baseline_rate",
                "difference_pp", "paired_days", "paired_t"]
    if key == "date_summary":
        return ["signal_date", "window", "target", "stock_count", "valid_stock_count",
                "hit_count", "hit_ratio"]
    if key == "stocks":
        columns = ["code", "name", "industry", "n"]
        columns += [f"positive_{window}d" for window in WINDOWS]
        columns += [f"hit3_{window}d" for window in WINDOWS]
        return columns
    return []


def write_artifacts(directory: Path, payload: dict[str, Any]) -> list[str]:
    """把规格里的文件写到 ``directory``（CSV + report.md）。空结果也写表头。"""
    directory.mkdir(parents=True, exist_ok=True)

    def dump(name: str, rows: Sequence[dict[str, Any]], key: str) -> None:
        columns = list(rows[0].keys()) if rows else _fallback_columns(key)
        if columns:
            _write_csv(directory / name, columns, rows)

    dump("stock_event_metrics.csv", payload["events"], "events")
    dump("window_summary.csv", payload["window_summary"], "window_summary")
    dump("target_edge.csv", payload.get("target_edge") or [], "target_edge")
    dump("return_distribution.csv", payload["distribution"], "distribution")
    dump("date_summary.csv", payload["date_summary"], "date_summary")
    dump("coverage_summary.csv", payload["coverage"], "coverage")
    _write_csv(directory / "data_quality_report.csv",
               ["group", "rows", "valid", "invalid", "reason"], payload["quality"])
    dump("baseline_comparison.csv", payload["baseline"], "baseline")
    dump("stock_summary.csv", payload["stocks"], "stocks")
    (directory / "report.md").write_text(payload["markdown"], encoding="utf-8")
    return [name for name in METHOD.outputs if (directory / name).is_file()]


def build(conn: sqlite3.Connection, meta: dict[str, Any]) -> StandardReport:
    """方法 2 的统一报告（读 ``m2_events``）。"""
    signal_events, duplicates = load_events(conn, is_control=False)
    # 对照组只按 SQL 聚合：全历史任务有几十万条，读成对象会白占几百 MB
    control_aggregates = load_control_aggregates(conn)
    adjusted = amplitude_adjusted(conn)
    report, payload = build_from_events(meta, signal_events, control_aggregates, duplicates, adjusted)
    # 产物必须存在才能给「下载」按钮；跑完时 runner 已写好，这里只补文件大小
    directory = Path(str(meta.get("_artifacts_dir") or ""))
    if directory.is_dir():
        for artifact in report.artifacts:
            path = directory / artifact.name
            if path.is_file():
                artifact.size = os.path.getsize(path)
    return report
