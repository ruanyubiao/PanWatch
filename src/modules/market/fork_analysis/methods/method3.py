"""统计分析方法 3（``stat_v3``）：条件适用面 —— 盈利概率 + 对哪些股票/行业/市值有效。

这套方法要回答的问题只有一个
--------------------------
「给定一个已保存的条件，它到底能不能赚钱？在什么股票上赚钱？几天最好？」

用户 2026-10-24 的原话：*「我相信，没有 1 个条件是适合全市场的所有股票的」*、*「比如条件 1，
对于股票 000001，5 日盈利概率 70%…最终选出来的，总有一个概率是特别高的」*。所以这套方法
不做全样本一句「好用/不好用」的结论，而是给出一张**适用说明书**：分层面（个股 / 行业 /
市值 / 成交额 / 换手 / 板块 / 年份）算盈利概率与超额，指出条件真正有效的那一小块，以及那块
占多大比例、够不够买。

为什么不能直接沿用方法 1 / 方法 2
--------------------------------
* 方法 1 的胜率是「第 N 天收盘涨幅 > 0」，但它按**笔**加权、且把成本当一个常数，
  回答的是「这个条件整体比随机好吗」。
* 方法 2 的达成率是「窗口内**最高价**摸到 X%」，A 股里这个指标饱和得厉害：0% 目标对
  条件组 97.7%、对随机 97.6%（差 0.08pp），根本没法用来判断「盈利概率」。
* 方法 3 用**收盘价**判定盈利：持有到第 N 个交易日收盘卖出、扣往返成本后仍为正才算赚。
  这样「摸高又回落」不算赚，符合真实交易的结算方式。

口径（写死，报告里逐条列出）
--------------------------
1. 买入：信号日次日**开盘价**（后复权）；次日停牌则顺延到复牌首日，记 ``entry_days``。
2. 卖出：第 N 个交易日**收盘价**；该日停牌则用停牌前最后一个收盘价（不新增波动）。
3. 盈利判定：``收盘价 / 买入价 − 1 > 往返成本``（成本按信号日成交额分档，2023-08-28 起
   印花税减半，见 :mod:`fork_analysis.costs`）。
4. 「总盈利概率」= 30 个交易日内**至少有一天收盘价**高于成本价（也就是「不贪就有机会走」）。
5. 买不进（次日开盘一字涨停）、缺复权、长期停牌、前瞻不足 → 单独计数，不当作亏损。
6. 基准：同日随机 200 只（按命中股市值档配比、排除命中股本身、CRC32 确定性抽样），
   同一条管道算，所以「超额」才是条件本身的价值。

统计上守两条纪律
---------------
* **按日聚类**：同一天命中的 300 只股票共享当天的大盘，不是 300 个独立样本。所有超额的
  t 值都用日度差值序列 + Newey–West（滞后 = 周期−1）算，等价于承认重叠窗口。
* **多重比较**：六个层面切成上百个格子，必然挑出假阳性。所有格子一起做 Benjamini–Hochberg
  校正，结论只认「样本够 + q 小 + 超额够大」三条同时成立。
"""

from __future__ import annotations

import csv
import math
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

from .. import costs as cost_model
from .. import scoring
from .. import significance
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

#: 用户指定的评价周期（2026-10-24：「5日 10 20 25 30」）——不含 15 日
WINDOWS: tuple[int, ...] = (5, 10, 20, 25, 30)
#: 主分析集要求的前瞻交易日数（= 最长窗口）
FULL_DAYS = 30

#: 统计窗口在行元组里的起始下标（见 :func:`load_events`）
_IDX_NET = 13
#: 行元组里「30 天内最高收盘」的位置
_IDX_ANY = _IDX_NET + len(WINDOWS)

#: 判断「特别有效」的门槛
MIN_SAMPLE_DEFAULT = 100
MIN_BASE_SAMPLE = 100
MIN_EXCESS_PP = 2.0
#: 「有效分类」要覆盖多少比例的信号才算有实际意义（%）
MIN_COVER_PCT = 2.0
FDR_Q = 0.10

METHOD = MethodSpec(
    id="stat_v3",
    name="统计分析方法 3：条件适用面（盈利概率 + 个股/行业/市值）",
    version="v1",
    summary=(
        "按收盘价结算算「扣成本后真赚钱」的概率：给出 5/10/20/25/30 日盈利概率、总盈利概率，"
        "并分个股、行业、市值、成交额、换手、板块、年份找出这个条件真正有效的那一块。"
    ),
    forward_days=FULL_DAYS,
    windows=WINDOWS,
    targets=(),
    params=(
        ParamSpec(
            key="min_sample", label="有效样本下限", kind="int", default=MIN_SAMPLE_DEFAULT,
            hint="少于这个样本数的股票/行业/市值档不参与「有效」判断（仍显示概率）",
            minimum=20, maximum=5000,
        ),
    ),
    outputs=(
        "window_summary.csv",
        "segment_tests.csv",
        "stock_ranking.csv",
        "industry_summary.csv",
        "bucket_summary.csv",
        "distribution.csv",
        "report.md",
    ),
    caliber=(
        "次日开盘买入、第 N 个交易日收盘卖出、扣往返成本后仍为正才算盈利；"
        "停牌按停牌前收盘顺延；买不进/缺复权/前瞻不足单独计数，不计入概率。"
    ),
    entry="次日开盘",
)


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson 区间（百分数）。小样本比正态近似可靠。"""
    if n <= 0:
        return (0.0, 0.0)
    p = wins / n
    denominator = 1.0 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    half = z * math.sqrt(max(0.0, p * (1 - p) / n + z * z / (4 * n * n))) / denominator
    return (max(0.0, (centre - half) * 100.0), min(100.0, (centre + half) * 100.0))


def _bh(pvalues: Sequence[float]) -> list[float]:
    """Benjamini–Hochberg 校正后的 q 值（保序，与 p 同序返回）。"""
    m = len(pvalues)
    if m == 0:
        return []
    order = sorted(range(m), key=lambda index: pvalues[index])
    qvalues = [1.0] * m
    running = 1.0
    for rank in range(m, 0, -1):
        index = order[rank - 1]
        value = pvalues[index] * m / rank
        running = min(running, value)
        qvalues[index] = min(1.0, running)
    return qvalues


def _normal_two_sided_p(z: Optional[float]) -> float:
    if z is None:
        return 1.0
    return max(0.0, min(1.0, math.erfc(abs(z) / math.sqrt(2.0))))


def _p_value(excess: dict[str, Any]) -> float:
    """超额序列的 p 值。

    退化情形要单独处理：如果每天的超额**完全一样**（日度差值标准差为 0），Newey–West
    标准误就是 0，t 值无定义。这时把它当成「p=1、不显著」是错的——那意味着「极其一致」，
    不是「没有证据」。样本天数太少（< 5 天）时才退回不显著。
    """
    if excess.get("pp") is None:
        return 1.0
    t_value = excess.get("t")
    if t_value is not None:
        return _normal_two_sided_p(t_value)
    days = int(excess.get("days") or 0)
    return 0.0 if abs(excess.get("pp") or 0.0) > 1e-9 and days >= 5 else 1.0


def _median(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2.0


def _bucket(value: Optional[float], edges: Sequence[tuple[float, str]], last_label: str) -> Optional[str]:
    """按上下限给数值贴标签（``None`` 表示数据缺失，不进分组）。"""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    for edge, label in edges:
        if number < edge:
            return label
    return last_label


_MCAP_EDGES = ((30.0, "<30亿"), (100.0, "30–100亿"), (300.0, "100–300亿"), (1000.0, "300–1000亿"))
_AMOUNT_EDGES = ((0.5, "<0.5亿"), (2.0, "0.5–2亿"), (5.0, "2–5亿"), (20.0, "5–20亿"))
_TURNOVER_EDGES = ((1.0, "<1%"), (3.0, "1–3%"), (7.0, "3–7%"), (15.0, "7–15%"))


def _mcap_bucket(value: Optional[float]) -> Optional[str]:
    return _bucket(value, _MCAP_EDGES, "≥1000亿")


def _amount_bucket(value: Optional[float]) -> Optional[str]:
    return _bucket(value, _AMOUNT_EDGES, "≥20亿")


def _turnover_bucket(value: Optional[float]) -> Optional[str]:
    return _bucket(value, _TURNOVER_EDGES, "≥15%")


# --------------------------------------------------------------------------- #
# 取数与行结构
# --------------------------------------------------------------------------- #
def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def load_events(conn: sqlite3.Connection) -> tuple[list[tuple], dict[str, int], int]:
    """读出方法 3 的事件，一行一个元组。

    元组布局（下标见 ``_IDX_NET``）：:

        0 d0  1 code  2 name  3 board  4 industry
        5 mcap 档  6 成交额档  7 换手档  8 年份  9 is_control  10 valid
        11 买入价  12 成本
        13..17  5/10/20/25/30 日净收益（小数）
        18  30 天内最高收盘的净收益（「总盈利」用）
    """
    present = _columns(conn, "m3_events")
    if not present:
        return [], {"missing_table": 1}, 0
    wanted = ["d0", "code", "name", "board", "industry", "mcap", "amount", "turnover",
              "is_control", "valid", "reason", "buy_price",
              *[f"c{window}" for window in WINDOWS],
              *[f"mc{window}" for window in WINDOWS]]
    select = ", ".join(name if name in present else f"NULL AS {name}" for name in wanted)
    order = " ORDER BY d0, code"
    cursor = conn.execute(f"SELECT {select} FROM m3_events{order}")
    rows: list[tuple] = []
    reasons: dict[str, int] = {}
    duplicates = 0
    seen: set[tuple[str, str, int]] = set()
    for record in cursor:
        (d0, code, name, board, industry, mcap, amount, turnover,
         is_control, valid, reason, buy_price) = record[:12]
        closes = record[12:12 + len(WINDOWS)]
        highs = record[12 + len(WINDOWS):12 + 2 * len(WINDOWS)]
        key = (str(d0), str(code), int(is_control or 0))
        if key in seen:
            duplicates += 1
            continue
        seen.add(key)
        if not valid:
            reasons[str(reason or "unknown")] = reasons.get(str(reason or "unknown"), 0) + 1
        try:
            buy = float(buy_price or 0.0)
        except (TypeError, ValueError):
            buy = 0.0
        try:
            cost = cost_model.realistic_cost(d0, float(amount) if amount is not None else None)
        except Exception:  # noqa: BLE001 - 成本取不到就用最高档，宁可保守
            cost = 0.004
        nets: list[Optional[float]] = []
        for value in closes:
            if buy > 0 and value is not None:
                nets.append(float(value) / buy - 1.0 - cost)
            else:
                nets.append(None)
        best = highs[-1] if highs else None
        any_net = (float(best) / buy - 1.0 - cost) if (buy > 0 and best is not None) else None
        rows.append((
            str(d0), str(code), str(name or ""), str(board or ""), str(industry or ""),
            _mcap_bucket(mcap), _amount_bucket(amount), _turnover_bucket(turnover),
            str(d0)[:4], int(is_control or 0), 1 if valid else 0, buy, cost,
            *nets, any_net,
        ))
    return rows, reasons, duplicates


# --------------------------------------------------------------------------- #
# 单组统计
# --------------------------------------------------------------------------- #
def _window_block(rows: Sequence[tuple], index: int) -> dict[str, Any]:
    """一组事件的第 ``index`` 个周期的净盈利统计。"""
    values = [row[_IDX_NET + index] for row in rows if row[_IDX_NET + index] is not None]
    n = len(values)
    if n == 0:
        return {"n": 0, "wins": 0, "p": None, "low": None, "high": None,
                "mean": None, "median": None, "payoff": None, "gross": None}
    wins = sum(1 for value in values if value > 0)
    gains = [value for value in values if value > 0]
    losses = [value for value in values if value < 0]
    low, high = _wilson(wins, n)
    gross = sum(1 for row in rows if row[_IDX_NET + index] is not None
                and row[_IDX_NET + index] + row[12] > 0)
    payoff = None
    if gains and losses:
        average_gain = sum(gains) / len(gains)
        average_loss = abs(sum(losses) / len(losses))
        payoff = (average_gain / average_loss) if average_loss > 0 else None
    return {
        "n": n,
        "wins": wins,
        "p": wins / n * 100.0,
        "low": low,
        "high": high,
        "mean": sum(values) / n * 100.0,
        "median": (_median(values) or 0.0) * 100.0,
        "payoff": payoff,
        "gross": gross / n * 100.0 if n else None,
    }


def _daily_series(rows: Iterable[tuple], index: int) -> dict[str, tuple[int, int]]:
    """按日聚合：``{d0: (wins, n)}``。"""
    buckets: dict[str, list[int]] = {}
    for row in rows:
        value = row[_IDX_NET + index]
        if value is None:
            continue
        slot = buckets.setdefault(row[0], [0, 0])
        slot[1] += 1
        if value > 0:
            slot[0] += 1
    return {day: (wins, n) for day, (wins, n) in buckets.items()}


def _cluster_excess(signal_rows: Sequence[tuple], base_rows: Sequence[tuple],
                    index: int) -> dict[str, Any]:
    """条件组 − 基准组的超额（百分点），按日聚类的 delta 法。

    为什么不是「两比例 z」
    ---------------------
    同一只股票连续两天命中，窗口重叠；同一天命中 300 只，共享同一段大盘。把 18 万条当成
    18 万个独立样本，t 值会虚高一个数量级。

    为什么不是「按日配对再平均」
    ---------------------------
    第一版就是这么写的，结果在薄样本分类上炸了：行业「住宿业」只有 232 条信号，对照里
    这个行业只在几十天里被抽到，那几十天的基准胜率恰好很低，于是「按日配对均值」给出
    +21pp，而两边合并的真实差值是 −3pp。两个估计量差了 24pp，纯粹是小样本噪声。

    现在改成**影响函数 + 按日聚类**（delta 法）：点估计就是两组合并比率的差（与报告里
    显示的 条件概率 / 基准概率 完全一致，不会再出现「显示 −3pp、结论 +21pp」），方差由
    日度影响函数求和得到，哪天才有一两条对照，那一天的权重大、方差也大，区间自然变宽。
    """
    if not signal_rows or not base_rows:
        return _no_base()
    signal_days = _daily_series(signal_rows, index)
    base_days = _daily_series(base_rows, index)
    signal_n = sum(n for _, n in signal_days.values())
    base_n = sum(n for _, n in base_days.values())
    if signal_n <= 0 or base_n <= 0:
        return _no_base()
    signal_p = sum(wins for wins, _ in signal_days.values()) / signal_n
    base_p = sum(wins for wins, _ in base_days.values()) / base_n

    days = sorted(set(signal_days) | set(base_days))
    lag = max(1, min(int(WINDOWS[index]) - 1, len(days) - 1))

    # 关键：日度差值必须**相减后再算方差**，不能把两组方差相加。
    # 条件组和对照组的日度胜率在同一天高度同向（同一段大盘），协方差几乎把方差抵消；
    # 忽略它会把标准误放大到 10 倍以上，把 −0.8pp 的差值说成「不显著」（实测 t 从 −4.4 崩到 −0.29）。
    combined = []
    for day in days:
        wins, count = signal_days.get(day, (0, 0))
        signal_term = (wins - signal_p * count) / signal_n
        wins, count = base_days.get(day, (0, 0))
        base_term = (wins - base_p * count) / base_n
        combined.append(signal_term - base_term)

    # newey_west_se 返回「均值」的标准误，这里要的是「求和」的：乘回天数
    se = significance.newey_west_se(combined, lag) * len(days)
    delta = signal_p - base_p
    t_value = (delta / se) if se > 0 else None
    return {
        "pp": delta * 100.0,
        "t": t_value,
        "days": len(days),
        "n_eff": max(1, len(days) // max(1, WINDOWS[index])),
        "low": (delta - 1.96 * se) * 100.0 if se > 0 else None,
        "high": (delta + 1.96 * se) * 100.0 if se > 0 else None,
        "base_p": base_p * 100.0,
        "base_n": base_n,
        "se": se,
    }


def _no_base() -> dict[str, Any]:
    return {"pp": None, "t": None, "days": 0, "n_eff": 0, "low": None, "high": None,
            "base_p": None, "base_n": 0, "se": None}


def _judge(n: int, excess: Optional[float], q: Optional[float], min_sample: int,
           base_n: int = 0) -> str:
    if excess is None:
        return "无基准"
    if base_n and base_n < MIN_BASE_SAMPLE:
        return "无基准"
    if n < min_sample:
        return "样本不足"
    if excess < MIN_EXCESS_PP:
        return "无优势"
    if q is None or q > FDR_Q:
        return "不显著"
    return "有效"


# --------------------------------------------------------------------------- #
# 主入口
# --------------------------------------------------------------------------- #
SEGMENT_LEVELS: tuple[tuple[str, int, str], ...] = (
    # (层面, 行元组下标, 过滤空值的 SQL 无关说明)
    ("market", 3, "板块"),
    ("industry", 4, "行业"),
    ("mcap", 5, "市值"),
    ("amount", 6, "成交额"),
    ("turnover", 7, "换手率"),
    ("year", 8, "年份"),
)


def _windows_rows(signal: Sequence[tuple], base: Sequence[tuple]) -> list[dict[str, Any]]:
    """一组事件的五个周期统计（总体表）。两段评分与整份报告共用同一段代码。"""
    rows: list[dict[str, Any]] = []
    for index, window in enumerate(WINDOWS):
        block = _window_block(signal, index)
        base_block = _window_block(base, index)
        excess = _cluster_excess(signal, base, index)
        rows.append({
            "window": window,
            "n": block["n"],
            "p_net": block["p"],
            "low": block["low"],
            "high": block["high"],
            "p_gross": block["gross"],
            "base_p": excess["base_p"] if excess["base_p"] is not None else base_block["p"],
            "base_n": excess["base_n"] or base_block["n"],
            "excess_pp": excess["pp"],
            "t": excess["t"],
            "days": excess["days"],
            "n_eff": excess["n_eff"],
            "median": block["median"],
            "payoff": block["payoff"],
            "expectancy": block["mean"],
        })
    return rows


def _peak_row(signal: Sequence[tuple], base: Sequence[tuple],
              horizon: int = 30) -> dict[str, Any]:
    """计分口径：``horizon`` 天内最高**收盘**盈利（净、可执行价买入）。

    用户 2026-11-06 的新规则就是这一条：每笔信号先算窗口内最高收盘盈利（允许为负，
    整段都亏时最大值天生就是「亏最少那天」），条件组按日取均值，减同日基准均值。
    ``_IDX_ANY`` 就是 30 天内最高收盘的净收益，所以不用重跑数据。

    基准这里是任务里的对照组（``is_control=1``），与条件组不重叠，不需要再做剔除。
    """
    def by_day(rows: Sequence[tuple]) -> dict[str, list[float]]:
        out: dict[str, list[float]] = {}
        for row in rows:
            value = row[_IDX_ANY]
            if value is None:
                continue
            out.setdefault(str(row[0]), []).append(float(value))
        return out

    picked = by_day(signal)
    peers = by_day(base)
    days = sorted(set(picked) & set(peers))
    series: list[float] = []
    for day in days:
        series.append(sum(picked[day]) / len(picked[day]) - sum(peers[day]) / len(peers[day]))
    count = len(series)
    excess_pp: Optional[float] = None
    lower_pp: Optional[float] = None
    if count:
        mean = sum(series) / count
        excess_pp = mean * 100.0
        # Newey–West，滞后 = 持有期 − 1：重叠样本只算一个独立片段
        lag = min(max(1, horizon - 1), max(1, count - 1))
        variance = sum((value - mean) ** 2 for value in series) / count
        for offset in range(1, lag + 1):
            cov = sum((series[i] - mean) * (series[i - offset] - mean)
                      for i in range(offset, count)) / count
            variance += 2.0 * (1.0 - offset / (lag + 1.0)) * cov
        if variance > 0:
            lower_pp = (mean - 1.96 * (variance / count) ** 0.5) * 100.0
        else:
            lower_pp = excess_pp
    values = [row[_IDX_ANY] for row in signal if row[_IDX_ANY] is not None]
    return {
        "window": horizon,
        "n": len(values),
        "excess_pp": None if excess_pp is None else round(excess_pp, 3),
        "lower_pp": None if lower_pp is None else round(lower_pp, 3),
        "n_eff": int(count // max(1, horizon)),
        "expectancy": round(sum(values) / len(values) * 100.0, 3) if values else None,
        "t": None,
        "p_net": None,
        "base_p": None,
    }


def _stress_excess(signal: Sequence[tuple], base: Sequence[tuple], index: int,
                   cost: float = scoring.STRESS_COST) -> Optional[float]:
    """成本抬到 ``cost`` 后、该周期的超额（pp）。简单差分，只作为评分门槛用。"""
    def rate(rows: Sequence[tuple]) -> Optional[float]:
        values = []
        for row in rows:
            net = row[_IDX_NET + index]
            if net is None:
                continue
            values.append(net + float(row[12]) - cost)
        if not values:
            return None
        return sum(1 for value in values if value > 0) / len(values) * 100.0

    picked = rate(signal)
    benchmark = rate(base)
    if picked is None or benchmark is None:
        return None
    return picked - benchmark


def _segment_extras(seg_signal: Sequence[tuple], seg_base: Sequence[tuple],
                    index: int) -> tuple[list[Optional[float]], list[Optional[float]]]:
    """分年 / 分板块的超额（一致性用）。板块只有四个值，代价可以忽略。"""
    years = sorted({str(row[0])[:4] for row in seg_signal})
    year_excess: list[Optional[float]] = []
    for year in years:
        picked = [row for row in seg_signal if str(row[0]).startswith(year)]
        peers = [row for row in seg_base if str(row[0]).startswith(year)]
        year_excess.append(_cluster_excess(picked, peers, index)["pp"])
    boards = sorted({str(row[3]) for row in seg_signal if row[3]})
    layer_excess: list[Optional[float]] = []
    for board in boards:
        picked = [row for row in seg_signal if str(row[3]) == board]
        peers = [row for row in seg_base if str(row[3]) == board]
        if len(picked) < 100:
            continue
        layer_excess.append(_cluster_excess(picked, peers, index)["pp"])
    return year_excess, layer_excess


def _segment_scores(meta: dict[str, Any], signal: Sequence[tuple],
                    base: Sequence[tuple]) -> dict[str, Any]:
    """推理段 / 测试段各打一个分（没配测试段时只有推理段）。

    事件按 ``d0`` 落在哪一段来分 —— 两段在创建任务时就校验过不重叠，
    所以不需要在表里多存一列 segment。
    """
    segments = [item for item in (meta.get("segments") or []) if isinstance(item, dict)]
    if not segments:
        segments = [{"kind": "train", "label": "全段",
                     "start": meta.get("start_date"), "end": meta.get("end_date")}]
    results: dict[str, Any] = {}
    for item in segments:
        kind = str(item.get("kind") or "train")
        start = str(item.get("start") or "")
        end = str(item.get("end") or "9999-12-31")
        picked_signal = [row for row in signal if start <= str(row[0]) <= end]
        picked_base = [row for row in base if start <= str(row[0]) <= end]
        if not picked_signal:
            results[kind] = {
                "score": None, "grade": "-", "grade_text": "这一段没有可用信号",
                "components": {}, "caps": ["没有信号"], "best_window": None,
                "lower_pp": None, "excess_pp": None,
                "events": 0, "days": 0, "label": item.get("label") or kind,
            }
            continue
        windows = _windows_rows(picked_signal, picked_base)
        # 计分只看 30 日「最高收盘盈利」这一条（用户 2026-11-06 定的规则）；
        # 5/10/20/25 那几档留着做明细，不参与打分。
        peak = _peak_row(picked_signal, picked_base)
        index = WINDOWS.index(30) if 30 in WINDOWS else len(WINDOWS) - 1
        _, layer_excess = _segment_extras(picked_signal, picked_base, index)
        days_with_hits = len({str(row[0]) for row in picked_signal})
        scored = scoring.score_segment(
            windows=[peak] if peak.get("excess_pp") is not None else [],
            events=len(picked_signal),
            days=days_with_hits,
            layer_excess=layer_excess,
            stress_excess=_stress_excess(picked_signal, picked_base, index),
        )
        scored["label"] = item.get("label") or kind
        scored["windows"] = windows
        results[kind] = scored
    return results


def build(conn: sqlite3.Connection, meta: dict[str, Any]) -> StandardReport:
    """算整份方法 3 报告（纯函数：只读 ``conn``，产物由调用方按 ``_artifacts_dir`` 落盘）。"""
    params = {"min_sample": int((meta.get("params") or {}).get("min_sample") or MIN_SAMPLE_DEFAULT)}
    min_sample = max(20, params["min_sample"])

    events, reasons, duplicates = load_events(conn)
    valid = [row for row in events if row[10] and all(
        row[_IDX_NET + index] is not None for index in range(len(WINDOWS)))]
    base = [row for row in valid if row[9]]
    signal = [row for row in valid if not row[9]]

    if not signal:
        return _empty_report(meta, params, events, reasons, duplicates)

    # ---------------- 总体：五个周期 + 总盈利 ----------------
    windows_rows = _windows_rows(signal, base)

    any_values = [row[_IDX_ANY] for row in signal if row[_IDX_ANY] is not None]
    any_base = [row[_IDX_ANY] for row in base if row[_IDX_ANY] is not None]
    p_any = (sum(1 for value in any_values if value > 0) / len(any_values) * 100.0) if any_values else None
    base_any = (sum(1 for value in any_base if value > 0) / len(any_base) * 100.0) if any_base else None
    any_low, any_high = _wilson(sum(1 for value in any_values if value > 0), len(any_values))

    best_index = max(
        range(len(WINDOWS)),
        key=lambda index: (windows_rows[index]["excess_pp"] if windows_rows[index]["excess_pp"] is not None else -99.0),
    )
    best = windows_rows[best_index]

    # ---------------- 分层面 ----------------
    tests: list[dict[str, Any]] = []
    for level, position, label in SEGMENT_LEVELS:
        signal_groups: dict[str, list[tuple]] = {}
        base_groups: dict[str, list[tuple]] = {}
        for row in signal:
            key = row[position]
            if not key:
                continue
            signal_groups.setdefault(str(key), []).append(row)
        for row in base:
            key = row[position]
            if not key:
                continue
            base_groups.setdefault(str(key), []).append(row)
        for value, group in signal_groups.items():
            peers = base_groups.get(value) or []
            for index, window in enumerate(WINDOWS):
                block = _window_block(group, index)
                if block["n"] == 0:
                    continue
                excess = _cluster_excess(group, peers, index)
                peer_block = _window_block(peers, index)
                tests.append({
                    "level": level,
                    "level_label": label,
                    "value": value,
                    "window": window,
                    "n": block["n"],
                    "p_net": block["p"],
                    "low": block["low"],
                    "high": block["high"],
                    "base_n": peer_block["n"],
                    "base_p": excess["base_p"] if excess["base_p"] is not None else None,
                    "excess_pp": excess["pp"],
                    "t": excess["t"],
                    "days": excess["days"],
                    "p_value": _p_value(excess),
                })

    qvalues = _bh([item["p_value"] for item in tests])
    for item, qvalue in zip(tests, qvalues):
        item["q"] = qvalue
        item["verdict"] = _judge(item["n"], item["excess_pp"], qvalue, min_sample,
                                 item.get("base_n") or 0)

    # 每个取值只保留「最好那个周期」，做成适用说明书
    by_segment: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in tests:
        by_segment.setdefault((item["level"], item["value"]), []).append(item)
    profile: list[dict[str, Any]] = []
    for (level, value), items in by_segment.items():
        ranked = sorted(items, key=lambda item: (item["excess_pp"] if item["excess_pp"] is not None else -99.0),
                        reverse=True)
        top = ranked[0]
        profile.append({
            "level": level,
            "level_label": top["level_label"],
            "value": value,
            "n": top["n"],
            "best_window": top["window"],
            "p_net": top["p_net"],
            "base_p": top["base_p"],
            "excess_pp": top["excess_pp"],
            "q": top["q"],
            "verdict": top["verdict"],
        })
    usable = [item for item in profile if item["verdict"] == "有效"]
    usable.sort(key=lambda item: (item["excess_pp"] or 0.0), reverse=True)
    usable_n = sum(item["n"] for item in usable)
    total_n = len(signal)

    # ---------------- 个股 ----------------
    stock_groups: dict[str, list[tuple]] = {}
    for row in signal:
        stock_groups.setdefault(row[1], []).append(row)
    stock_rows: list[dict[str, Any]] = []
    overall_p = [windows_rows[index]["p_net"] for index in range(len(WINDOWS))]
    for code, group in stock_groups.items():
        blocks = [_window_block(group, index) for index in range(len(WINDOWS))]
        if not blocks[0]["n"]:
            continue
        values = [row[_IDX_ANY] for row in group if row[_IDX_ANY] is not None]
        any_p = (sum(1 for value in values if value > 0) / len(values) * 100.0) if values else None
        # 收缩：命中次数少时向全体均值拉回，避免「3 战 3 胜」排第一
        n = blocks[0]["n"]
        prior = min(50.0, 200.0 / max(1, n))
        shrunk = []
        for index in range(len(WINDOWS)):
            base_p = overall_p[index] or 50.0
            value = blocks[index]["p"]
            shrunk.append(None if value is None else (value * n + base_p * prior) / (n + prior))
        best_stock = max(range(len(WINDOWS)),
                         key=lambda index: (shrunk[index] if shrunk[index] is not None else -1))
        stock_rows.append({
            "code": code,
            "name": group[0][2],
            "industry": group[0][4],
            "mcap_bucket": group[0][5],
            "n": n,
            "p5": blocks[0]["p"], "p10": blocks[1]["p"], "p20": blocks[2]["p"],
            "p25": blocks[3]["p"], "p30": blocks[4]["p"],
            "any": any_p,
            "best_window": WINDOWS[best_stock],
            "best_p": shrunk[best_stock],
            "median_10": blocks[1]["median"],
            # 个股没有自己的基准（对照是随机抽的，不可能按个股配比），
            # 所以这里只说「概率高低 + 样本够不够」，不用「有效」这种需要基准的词
            "verdict": ("样本不足" if n < 30 else
                        ("较强" if (shrunk[best_stock] or 0) >= 60 else
                         ("偏弱" if (shrunk[best_stock] or 0) < 40 else "一般"))),
        })
    stock_rows.sort(key=lambda item: (item["best_p"] or 0.0), reverse=True)

    # ---------------- 涨幅分布（10 日） ----------------
    distribution = _distribution([row[_IDX_NET + 1] for row in signal], [row[_IDX_NET + 1] for row in base])

    # ---------------- 结论卡 ----------------
    headline = _headline(signal, windows_rows, best, p_any, base_any, usable, usable_n, total_n, min_sample)

    # ---------------- 评分（推理段 / 测试段） ----------------
    scores = _segment_scores(meta, signal, base)
    train_score = scores.get("train")
    test_score = scores.get("test")
    combined = scoring.combined(train_score or {}, test_score)
    # 测试段的衰减惩罚要有推理段做参照，所以在算完之后补一次
    if train_score and test_score and test_score.get("score") is not None:
        rescored = scoring.score_segment(
            windows=test_score.get("windows") or [],
            events=int(test_score.get("events") or 0),
            days=int(test_score.get("days") or 0),
            year_excess=(),
            layer_excess=(),
            stress_excess=None,
            reference=train_score,
        )
        # 只补衰减这一项，门槛与其它分量保持第一次的结果
        delta = float(rescored.get("components", {}).get("decay") or 0.0) \
            - float(test_score.get("components", {}).get("decay") or 0.0)
        if delta:
            test_score["score"] = round(max(0.0, float(test_score["score"]) + delta), 1)
            test_score["components"] = {**test_score.get("components", {}),
                                        "decay": round(delta + float(
                                            test_score.get("components", {}).get("decay") or 0.0), 1)}
            test_score["grade"], test_score["grade_text"] = scoring.grade_of(test_score["score"])
            combined = scoring.combined(train_score, test_score)

    score_rows: list[dict[str, Any]] = []
    for key, label in (("train", "推理评分"), ("test", "验证评分")):
        item = scores.get(key)
        if not item:
            continue
        score_rows.append({
            "segment": label,
            "score": item.get("score"),
            "grade": item.get("grade"),
            "best_window": item.get("best_window"),
            "excess_pp": item.get("excess_pp"),
            "lower_pp": item.get("lower_pp"),
            "events": item.get("events"),
            "days": item.get("days"),
            "caps": "；".join(item.get("caps") or []),
        })
    score_table = Table(
        key="scores",
        title="评分",
        hint="50 = 和随机买入一样；60 = 及格（能拿去用）；85 以上 = 优秀。只用置信下界算分，样本少的条件拿不到高分。",
        columns=[
            Column("segment", "时间段", "text"),
            Column("score", "评分", "number", hint="0–100"),
            Column("grade", "等级", "text"),
            Column("best_window", "最优持有期", "int", hint="交易日"),
            Column("excess_pp", "超额", "pp"),
            Column("lower_pp", "超额下界", "pp", hint="评分用的就是这个数"),
            Column("events", "有效信号", "int"),
            Column("days", "有信号的天数", "int"),
            Column("caps", "封顶原因", "text"),
        ],
        rows=score_rows,
    )

    _train_text = (train_score or {}).get("score")
    _test_text = (test_score or {}).get("score")
    _train_text = "—" if _train_text is None else _train_text
    _test_text = "—" if _test_text is None else _test_text
    if combined.get("verdict") == "fail":
        headline.verdict = "worse"
        headline.title = f"不可用（{_train_text} 分）：" + headline.title
    elif combined.get("verdict") == "pass":
        headline.title = f"两段都及格（{_train_text} / {_test_text}）：" + headline.title
    else:
        headline.title = (f"评分 {_train_text}" + (f" / {_test_text}" if test_score else "")
                          + "：" + headline.title)
    headline.detail = (headline.detail + f" 综合判断：{combined.get('text')}。").strip()
    headline.metrics = [
        metric("score_train", "推理评分", (train_score or {}).get("score"), "分",
               str((train_score or {}).get("grade_text") or "")),
        *([
            metric("score_test", "验证评分", test_score.get("score"), "分",
                   str(test_score.get("grade_text") or ""))
        ] if test_score else []),
        metric("score_verdict", "结论", combined.get("verdict"), "", str(combined.get("text") or "")),
        *headline.metrics,
    ]

    # ---------------- 表格 ----------------
    tables = [score_table, *_tables(windows_rows, profile, stock_rows, tests, distribution, min_sample)]

    data_quality = {
        "events": len(events),
        "valid_events": len(valid),
        "signal_events": len(signal),
        "control_events": len(base),
        "excluded": sum(reasons.values()),
        "excluded_reasons": reasons,
        "duplicates": duplicates,
        "windows": list(WINDOWS),
        "horizon_days": FULL_DAYS,
        "min_sample": min_sample,
        "usable_segments": len(usable),
        "tests": len(tests),
        "scores": {key: {"score": value.get("score"), "grade": value.get("grade"),
                         "components": value.get("components"), "caps": value.get("caps")}
                   for key, value in scores.items()},
        "score_verdict": combined,
    }

    notes = [
        "盈利按收盘价结算：次日开盘买入、第 N 个交易日收盘卖出、扣往返成本后仍为正才算赚；"
        "「摸到高价又回落」不算盈利。",
        "「总盈利概率」= 30 个交易日内至少有一天收盘价高于成本价，代表「不贪就有机会走」。",
        "超额 = 条件组概率 − 同日随机对照组的概率，按日配对、Newey–West 处理后给出 t 值；"
        "同一天的多只股票不是独立样本。",
        "分层面结论做了 Benjamini–Hochberg 多重比较校正（q ≤ 0.1），"
        f"且要求样本 ≥ {min_sample}、超额 ≥ {MIN_EXCESS_PP:g}pp 才判「有效」。",
        "本方法的概率按**每一笔信号等权**（真实交易口径）。方法 1 的超额按**每一天等权**，"
        "两者不同：命中股票多的日子超额接近 0、命中少的日子更差，所以方法 1 会把整体说得更差。"
        "看「买了之后赚不赚」用本方法，看「随便挑一天买一篮子」用方法 1。",
        "退市股不在库里（数据源限制），历史概率存在幸存者偏差，方向是偏高。",
        "行业为当前快照（stock_info.industry），不是信号日的历史行业分类。",
    ]

    return StandardReport(
        method=METHOD,
        parameters={**params, "windows": list(WINDOWS), "horizon_days": FULL_DAYS},
        headline=headline,
        tables=tables,
        artifacts=_artifact_specs(),
        data_quality=data_quality,
        notes=notes,
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"),
    )


def _empty_report(meta: dict[str, Any], params: dict[str, Any], events: Sequence[tuple],
                  reasons: dict[str, int], duplicates: int) -> StandardReport:
    return StandardReport(
        method=METHOD,
        parameters={**params, "windows": list(WINDOWS), "horizon_days": FULL_DAYS},
        headline=Headline(
            verdict="insufficient",
            title="没有可用的信号",
            detail="这个条件在所选区间内没有产生可验证的样本（或任务还没跑完）。",
        ),
        tables=[],
        artifacts=_artifact_specs(),
        data_quality={"events": len(events), "excluded_reasons": reasons, "duplicates": duplicates},
        notes=["没有样本时不做任何概率推断。"],
        generated_at=datetime.now().astimezone().isoformat(timespec="seconds"),
    )


def _coverage(usable: Sequence[dict[str, Any]], total_n: int) -> float:
    """有效分类覆盖的信号比例（按单个维度去重，取最大的那一维）。"""
    if not total_n:
        return 0.0
    by_level: dict[str, int] = {}
    for item in usable:
        key = str(item.get("level") or "")
        by_level[key] = by_level.get(key, 0) + int(item.get("n") or 0)
    if not by_level:
        return 0.0
    return min(100.0, max(by_level.values()) / total_n * 100.0)


def _headline(signal: Sequence[tuple], windows_rows: Sequence[dict[str, Any]],
              best: dict[str, Any], p_any: Optional[float], base_any: Optional[float],
              usable: Sequence[dict[str, Any]], usable_n: int, total_n: int,
              min_sample: int) -> Headline:
    """结论卡：先回答「整体有没有用」，再回答「用在哪」。"""
    best_pp = best.get("excess_pp")
    t_value = best.get("t")
    significant = bool(best_pp is not None and t_value is not None and abs(t_value) >= 2.0)
    # 分类维度之间会重复计数（同一条信号既在一个行业、又在一个市值档……），
    # 把各分类样本数直接相加能超过 100%（线上真出现过「覆盖 521.1%」）。
    # 所以按维度分别求和、取最大的那一个：这是「至少覆盖」的下界。
    cover = _coverage(usable, total_n)

    metrics = [
        metric("p_any", "总盈利概率", round(p_any, 2) if p_any is not None else None, "%",
               "30 天内至少有一天收盘价高于成本价"),
        metric("base_any", "随机基准", round(base_any, 2) if base_any is not None else None, "%"),
    ]
    for item in windows_rows:
        metrics.append(metric(f"p{item['window']}", f"{item['window']}日盈利概率",
                              round(item["p_net"], 2) if item["p_net"] is not None else None, "%"))
    metrics.append(metric("best_window", "优势最大的周期", best["window"], "日"))
    metrics.append(metric("best_excess", "该周期超额", round(best_pp, 2) if best_pp is not None else None, "pp"))
    metrics.append(metric("usable_segments", "有效分类数", len(usable), "个"))
    metrics.append(metric("usable_cover", "有效分类覆盖样本", round(cover, 1), "%"))

    if not usable and not (significant and (best_pp or 0) >= MIN_EXCESS_PP):
        return Headline(
            verdict="no_edge",
            title="整体上没有可确认的盈利优势",
            detail=(
                f"五个周期里最好的是 {best['window']} 日：{_fmt(best['p_net'])}% 对随机 "
                f"{_fmt(best.get('base_p'))}%（{_signed(best_pp)}pp，t={_fmt(t_value, 2)}），"
                f"没有任何分类满足「样本≥{min_sample} + 校正后显著 + 超额≥{MIN_EXCESS_PP:g}pp」。"
            ),
            metrics=metrics,
        )

    # 覆盖太小的分类不能当结论：202 条信号、覆盖 0.1%，q 刚好压在 0.1 边缘，
    # 这种「有效」在统计上勉强、在用的时候挑不出来（那个行业全市场才十几只股票）。
    if usable and cover < MIN_COVER_PCT:
        top = usable[0]
        return Headline(
            verdict="no_edge",
            title="整体没有可确认的盈利优势",
            detail=(
                f"五个周期里最好的是 {best['window']} 日：{_fmt(best['p_net'])}% 对随机 "
                f"{_fmt(best.get('base_p'))}%（{_signed(best_pp)}pp，t={_fmt(t_value, 2)}）。"
                f"只有 {top['level_label']}「{top['value']}」勉强过线"
                f"（{_fmt(top['p_net'])}% 对 {_fmt(top['base_p'])}%，{_signed(top['excess_pp'])}pp，"
                f"q={_fmt(top['q'])}），但至少覆盖 {cover:.1f}% 的信号仍不足以支撑「这个条件能用」。"
            ),
            metrics=metrics,
        )

    if usable:
        top = usable[0]
        head = (
            f"只在 {len(usable)} 个分类里有效（至少覆盖 {cover:.1f}% 的信号）："
            f"{top['level_label']}「{top['value']}」{top['best_window']} 日 "
            f"{_fmt(top['p_net'])}%（基准 {_fmt(top['base_p'])}%，{_signed(top['excess_pp'])}pp）"
        )
        if best_pp is not None and best_pp >= MIN_EXCESS_PP and significant:
            verdict = "usable"
            detail = f"整体也有优势：{best['window']} 日 {_signed(best_pp)}pp（t={_fmt(t_value, 2)}）；{head}。"
        else:
            verdict = "segmented"
            detail = (
                f"整体最好只有 {_signed(best_pp)}pp（t={_fmt(t_value, 2)}），但 {head}。"
                "也就是说这个条件不是全市场通用，只能挑着用。"
            )
        return Headline(verdict=verdict, title=head, detail=detail, metrics=metrics)

    return Headline(
        verdict="mixed",
        title=f"整体 {best['window']} 日有 {_signed(best_pp)}pp 超额，但分层面没有站得住的分类",
        detail=(
            f"最好周期 {best['window']} 日：{_fmt(best['p_net'])}% 对随机 {_fmt(best.get('base_p'))}%"
            f"（t={_fmt(t_value, 2)}）。分层面切分后没有分类同时满足样本与显著性要求，"
            "说明优势不集中在某个可识别的类别上。"
        ),
        metrics=metrics,
    )


def _fmt(value: Optional[float], digits: int = 2) -> str:
    return "—" if value is None else f"{value:.{digits}f}"


def _signed(value: Optional[float]) -> str:
    return "—" if value is None else f"{value:+.2f}"


def _distribution(net: Sequence[Optional[float]], base: Sequence[Optional[float]]) -> list[dict[str, Any]]:
    edges = ((-10.0, "<−10%"), (-5.0, "−10%~−5%"), (-2.0, "−5%~−2%"), (0.0, "−2%~0%"),
             (2.0, "0%~2%"), (5.0, "2%~5%"), (10.0, "5%~10%"))
    labels = [label for _, label in edges] + ["≥10%"]
    signal_counts = [0] * len(labels)
    base_counts = [0] * len(labels)
    for values, counts in ((net, signal_counts), (base, base_counts)):
        for value in values:
            if value is None:
                continue
            pct = value * 100.0
            placed = False
            for position, (edge, _) in enumerate(edges):
                if pct < edge:
                    counts[position] += 1
                    placed = True
                    break
            if not placed:
                counts[-1] += 1
    signal_total = sum(signal_counts) or 1
    base_total = sum(base_counts) or 1
    return [{
        "range": label,
        "signal_n": signal_counts[position],
        "signal_pct": signal_counts[position] / signal_total * 100.0,
        "base_n": base_counts[position],
        "base_pct": base_counts[position] / base_total * 100.0,
    } for position, label in enumerate(labels)]


def _tables(windows_rows: Sequence[dict[str, Any]], profile: Sequence[dict[str, Any]],
            stock_rows: Sequence[dict[str, Any]], tests: Sequence[dict[str, Any]],
            distribution: Sequence[dict[str, Any]], min_sample: int) -> list[Table]:
    window_table = Table(
        key="windows",
        title="五个周期的盈利概率",
        hint="盈利 = 扣往返成本后仍为正；超额 = 减同一天随机买入的概率，按日配对算 t。",
        columns=[
            Column("window", "周期", "int", hint="持有多少个交易日"),
            Column("n", "样本", "int"),
            Column("p_net", "盈利概率", "percent"),
            Column("low", "95%下界", "percent"),
            Column("high", "95%上界", "percent"),
            Column("p_gross", "不扣成本", "percent"),
            Column("base_p", "随机基准", "percent"),
            Column("excess_pp", "超额", "pp"),
            Column("t", "t 值", "number"),
            Column("median", "中位收益", "percent"),
            Column("payoff", "盈亏比", "number"),
            Column("expectancy", "期望收益", "percent"),
        ],
        rows=[{**row, "window": row["window"]} for row in windows_rows],
        sort_key="window", sort_order="asc",
    )

    profile_rows = sorted(
        profile,
        key=lambda item: (0 if item["verdict"] == "有效" else 1,
                          -(item["excess_pp"] or -99.0)),
    )
    profile_table = Table(
        key="profile",
        title="适用说明书：哪些股票/行业/市值真正有效",
        hint="每个分类只取它自己最好的那个周期。判断口径：样本≥%d、q≤0.1、超额≥%gpp。" % (min_sample, MIN_EXCESS_PP),
        columns=[
            Column("level_label", "层面", "text"),
            Column("value", "取值", "text"),
            Column("n", "样本", "int"),
            Column("best_window", "最佳周期", "int"),
            Column("p_net", "盈利概率", "percent"),
            Column("base_p", "基准", "percent"),
            Column("excess_pp", "超额", "pp"),
            Column("q", "q 值", "number", hint="BH 校正后"),
            Column("verdict", "判断", "text"),
        ],
        rows=cap_rows(profile_rows, 60)[0],
        total_rows=len(profile_rows),
        sort_key="excess_pp",
    )

    stock_table = Table(
        key="stocks",
        title="个股：每只股票的盈利概率",
        hint="「最佳概率」已按样本量向全体均值收缩，避免命中 2 次全胜的股票排第一。",
        columns=[
            Column("code", "代码"),
            Column("name", "名称"),
            Column("industry", "行业"),
            Column("mcap_bucket", "市值"),
            Column("n", "命中", "int"),
            Column("p5", "5日", "percent"),
            Column("p10", "10日", "percent"),
            Column("p20", "20日", "percent"),
            Column("p25", "25日", "percent"),
            Column("p30", "30日", "percent"),
            Column("any", "总盈利", "percent"),
            Column("best_window", "最佳周期", "int"),
            Column("best_p", "最佳概率", "percent", hint="收缩后"),
            Column("verdict", "判断"),
        ],
        rows=cap_rows(stock_rows, 300)[0],
        total_rows=len(stock_rows),
        sort_key="best_p",
    )

    bucket_rows = [item for item in tests if item["level"] != "industry" and item["window"] == WINDOWS[0]]
    bucket_table = Table(
        key="buckets",
        title="市值/成交额/换手/板块/年份（5 日）",
        columns=[
            Column("level_label", "层面"),
            Column("value", "取值"),
            Column("n", "样本", "int"),
            Column("p_net", "5日盈利", "percent"),
            Column("base_p", "基准", "percent"),
            Column("excess_pp", "超额", "pp"),
            Column("verdict", "判断"),
        ],
        rows=cap_rows(bucket_rows, 80)[0],
        total_rows=len(bucket_rows),
        sort_key="excess_pp",
    )

    industry_rows = [item for item in tests if item["level"] == "industry" and item["window"] == WINDOWS[0]]
    industry_table = Table(
        key="industries",
        title="行业（5 日）",
        columns=[
            Column("value", "行业"),
            Column("n", "样本", "int"),
            Column("p_net", "5日盈利", "percent"),
            Column("base_p", "基准", "percent"),
            Column("excess_pp", "超额", "pp"),
            Column("verdict", "判断"),
        ],
        rows=cap_rows(industry_rows, 60)[0],
        total_rows=len(industry_rows),
        sort_key="excess_pp",
    )

    distribution_table = Table(
        key="distribution",
        title="10 日收益分布",
        hint="盈利概率只是一个数，这里看右尾够不够长、左尾有多重。",
        columns=[
            Column("range", "区间"),
            Column("signal_n", "条件组", "int"),
            Column("signal_pct", "占比", "percent"),
            Column("base_n", "随机组", "int"),
            Column("base_pct", "占比", "percent"),
        ],
        rows=list(distribution),
    )

    return [window_table, profile_table, stock_table, bucket_table, industry_table, distribution_table]


def _artifact_specs() -> list[Artifact]:
    return [Artifact(name=name, kind="md" if name.endswith(".md") else "csv") for name in METHOD.outputs]


# --------------------------------------------------------------------------- #
# 产物
# --------------------------------------------------------------------------- #
def write_artifacts(directory: Path, report: StandardReport) -> list[str]:
    """把报告里的表落成 CSV，再写一份中文 report.md。返回文件名列表。"""
    directory.mkdir(parents=True, exist_ok=True)
    mapping = {
        "windows": "window_summary.csv",
        "profile": "segment_tests.csv",
        "stocks": "stock_ranking.csv",
        "industries": "industry_summary.csv",
        "buckets": "bucket_summary.csv",
        "distribution": "distribution.csv",
    }
    written: list[str] = []
    for table in report.tables:
        name = mapping.get(table.key)
        if not name:
            continue
        with (directory / name).open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow([column.label for column in table.columns])
            for row in table.rows:
                writer.writerow([row.get(column.key) for column in table.columns])
        written.append(name)
    text = render_markdown(report)
    (directory / "report.md").write_text(text, encoding="utf-8")
    written.append("report.md")
    return written


def render_markdown(report: StandardReport) -> str:
    """给人看的中文报告（也是 report.md 的内容）。"""
    head = report.headline
    quality = report.data_quality
    lines = [
        "# 条件适用面评估报告（方法 3）",
        "",
        f"生成时间：{report.generated_at}",
        "",
        "## 结论",
        "",
        f"**{head.title}**",
        "",
        head.detail,
        "",
    ]
    if head.metrics:
        lines.append("| 指标 | 数值 |")
        lines.append("| --- | --- |")
        for item in head.metrics:
            value = item.get("value")
            lines.append(f"| {item['label']} | {'—' if value is None else value}{item.get('unit', '')} |")
        lines.append("")
    lines.append("## 数据")
    lines.append("")
    lines.append(f"- 事件总数：{quality.get('events')}，有效 {quality.get('valid_events')}")

    if report.tables:
        for table in report.tables:
            lines.append("")
            lines.append(f"## {table.title}")
            if table.hint:
                lines.append("")
                lines.append(f"_{table.hint}_")
            lines.append("")
            lines.append("| " + " | ".join(column.label for column in table.columns) + " |")
            lines.append("| " + " | ".join("---" for _ in table.columns) + " |")
            for row in table.rows[:30]:
                cells = []
                for column in table.columns:
                    value = row.get(column.key)
                    if value is None:
                        cells.append("—")
                    elif column.kind in {"percent", "pp"}:
                        cells.append(f"{value:.2f}")
                    elif isinstance(value, float):
                        cells.append(f"{value:.3f}")
                    else:
                        cells.append(str(value))
                lines.append("| " + " | ".join(cells) + " |")
            if len(table.rows) > 30:
                lines.append(f"| … 共 {table.total_rows} 行，完整数据见对应 CSV |" + " |" * (len(table.columns) - 1))
    if report.notes:
        lines.append("")
        lines.append("## 口径与局限")
        lines.append("")
        for note in report.notes:
            lines.append(f"- {note}")
    lines.append("")
    return "\n".join(lines)
