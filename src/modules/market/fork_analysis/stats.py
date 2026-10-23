"""统计层：把 ``signals.db`` 里的逐条信号算成「这个条件到底有没有用、对谁最有效」。

口径（用户 2026-10-22 定的，v2）
-----------------------------
- **胜率** = 第 N 天收盘涨幅 > 0 的比例（点对点，回答「持有到第 N 天赚没赚」）；
- **触及率** = N 天内最高价曾高于信号日收盘的比例（用户确认保持原样：盘中 high，
  回答「有没有机会」）；
- **到达天数** = 第一次出现「收盘涨幅 > 0」的那个交易日（回答「多久内能走出来」，
  这是唯一不会随周期变长而单调变高的指标）；
- **超额胜率** = 条件组 − 同期同市场随机买入（**只在结论卡与 Excel 里用**，
  界面上不显示对照组，用户第 6 条）；
- **分组优势** = 某一类（行业/市值/年份…）的胜率 − 这个条件**自己**的整体胜率。
  这是「哪些类型特别有效」的答案，且不依赖对照组。

分组统计的可信度
---------------
几十个分组里按 p<0.05 挑「显著」，必然挑出假阳性。所以每一组都同时给样本数、
Wilson 95% 区间、z 值与 Benjamini–Hochberg 校正后的 q 值；结论只认
「样本 ≥ 100 + q < 0.1 + 优势为正」三条同时成立（用户第 9 条）。

缓存
----
分组统计要扫几十万行 × 十几个维度，接口每次现算会让弹窗卡住。所以第一次算完
写进 ``group_stats`` / ``arrival_stats`` 两张小表（``cache_meta.version`` 标记口径），
之后读表毫秒级返回。
"""

from __future__ import annotations

import json
import logging
import math
import sqlite3
from typing import Any, Iterable, Optional, Sequence

from . import attribution as attribution_module
from . import costs, entry, health, portfolio, significance
from .forward import EXEC_COST
from .models import HORIZONS, horizons_for

logger = logging.getLogger(__name__)

#: 排行/结论要求的最小样本（单股信号数）
MIN_STOCK_SAMPLES = 30
#: 结论要求的最小总样本
MIN_TOTAL_SAMPLES = 100
#: 低于这个超额（百分点）按「与随机买入没有区别」处理
EXCESS_THRESHOLD_PP = 2.0
#: 分组结论要求的最小样本
MIN_GROUP_SAMPLES = 100
#: BH 校正后的显著性阈值
Q_THRESHOLD = 0.10
#: 个股排行的收缩强度（Beta 先验等价样本数）：越小越相信原始胜率
SHRINK_PRIOR = 20.0

#: 直方图分箱（百分数）：-50% 到 +100%，每 5% 一格
HIST_EDGES = tuple(range(-50, 101, 5))

#: 缓存口径版本：改统计公式就得 +1，否则老任务会读到旧数字
#: v5 = 按日聚合的诚实区间（2026-10-23）
#: v6 = 分组缓存存平均涨幅（v5 之前误存成总和）+ 市值匹配对照
#: v7 = 分组增加「相对随机」超额
#: v8 = 双口径（按日/按笔）+ 成本敏感性 + 入场假设 + 组合模拟 + 因子归因 + 体检
CACHE_VERSION = 8


def forward_cost() -> float:
    """可执行口径的往返成本（0.2%），与 forward.EXEC_COST 同一个数。"""
    return EXEC_COST


def wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """二项比例的 Wilson 95% 区间（百分数）。n=0 时给 (0, 0)。"""
    if n <= 0:
        return (0.0, 0.0)
    p = wins / n
    denom = 1.0 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round((centre - margin) / denom * 100, 2), round((centre + margin) / denom * 100, 2))


def two_proportion_z(wins1: int, n1: int, wins2: int, n2: int) -> float:
    """两组比例差的 z 值。样本不足时返回 0。"""
    if n1 <= 0 or n2 <= 0:
        return 0.0
    p1, p2 = wins1 / n1, wins2 / n2
    pooled = (wins1 + wins2) / (n1 + n2)
    variance = pooled * (1 - pooled) * (1 / n1 + 1 / n2)
    if variance <= 0:
        return 0.0
    return round((p1 - p2) / math.sqrt(variance), 2)


def _two_sided_p(z: float) -> float:
    """正态近似下的双侧 p 值（|z| 越大越小）。"""
    return math.erfc(abs(float(z)) / math.sqrt(2.0))


def bh_qvalues(pvalues: Sequence[float]) -> list[float]:
    """Benjamini–Hochberg：返回与输入同序的 q 值（保持单调）。"""
    count = len(pvalues)
    if count == 0:
        return []
    order = sorted(range(count), key=lambda index: pvalues[index])
    qvalues = [1.0] * count
    running = 1.0
    for rank in range(count - 1, -1, -1):
        index = order[rank]
        value = pvalues[index] * count / (rank + 1)
        running = min(running, value)
        qvalues[index] = round(min(1.0, max(0.0, running)), 4)
    return qvalues


# ---------------------------------------------------------------- 周期聚合
#: 口径别名：``report["caliber"]`` 给的是 exec/close，列前缀是 x/r。两种都认，
#: 免得调用方拿 caliber 直接当列前缀用（踩过一次 ``no such column: exec30``）。
_CALIBER_PREFIX = {"exec": "x", "close": "r", "x": "x", "r": "r"}


def caliber_prefix(cal: str = "r") -> str:
    return _CALIBER_PREFIX.get(str(cal), str(cal))


def _expr(horizon: int, cal: str = "r", alias: str = "", cost: float = 0.0) -> str:
    """周期涨幅的 SQL 表达式；可执行口径要扣往返成本（0.2%）。"""
    prefix = caliber_prefix(cal)
    base = f"{alias}.{prefix}{horizon}" if alias else f"{prefix}{horizon}"
    return f"({base} - {cost})" if cost else base


def valid_where(cal: str = "r") -> str:
    """统计应排除的行：不可验证（长期停牌/退市/缺复权）与买不进（次日一字涨停）。

    老任务没有这些列（NULL），按「可用」处理，不会把历史任务清零。
    """
    base = "(verif IS NULL OR verif = 1)"
    if caliber_prefix(cal) == "x":
        return base + " AND (unfillable IS NULL OR unfillable = 0)"
    return base


def _agg_select(horizons: Iterable[int], alias: str = "", cal: str = "r",
                cost: float = 0.0) -> str:
    """所有周期的聚合列（一条 SQL 一次算完，别每个周期扫一遍表）。"""
    prefix = f"{alias}." if alias else ""
    parts: list[str] = ["COUNT(*) AS total"]
    for horizon in horizons:
        col = _expr(horizon, cal, alias, cost)
        touch = f"{prefix}t{horizon}"
        parts.extend([
            f"COUNT({col}) AS c{horizon}",
            f"SUM(CASE WHEN {col} > 0 THEN 1 ELSE 0 END) AS w{horizon}",
            f"SUM(CASE WHEN {col} > 0 THEN {col} ELSE 0 END) AS gw{horizon}",
            f"SUM(CASE WHEN {col} <= 0 THEN {col} ELSE 0 END) AS gl{horizon}",
            f"AVG({col}) AS a{horizon}",
            f"COUNT({touch}) AS tc{horizon}",
            f"SUM(CASE WHEN {touch} > 0 THEN 1 ELSE 0 END) AS tw{horizon}",
        ])
    return ", ".join(parts)


def _metrics_of(row: sqlite3.Row | dict[str, Any], horizon: int) -> dict[str, Any]:
    counted = int(row[f"c{horizon}"] or 0)
    wins = int(row[f"w{horizon}"] or 0)
    gain = float(row[f"gw{horizon}"] or 0.0)
    loss = float(row[f"gl{horizon}"] or 0.0)
    avg = row[f"a{horizon}"]
    touch_counted = int(row[f"tc{horizon}"] or 0)
    touch_wins = int(row[f"tw{horizon}"] or 0)
    avg_win = gain / wins if wins else 0.0
    avg_loss = loss / (counted - wins) if counted - wins else 0.0
    low, high = wilson(wins, counted)
    return {
        "horizon": horizon,
        "n": counted,
        "wins": wins,
        "win_rate": round(wins / counted * 100, 2) if counted else None,
        "ci_low": low if counted else None,
        "ci_high": high if counted else None,
        "touch_rate": round(touch_wins / touch_counted * 100, 2) if touch_counted else None,
        "avg_return": round(float(avg) * 100, 2) if avg is not None else None,
        "avg_win": round(avg_win * 100, 2) if wins else None,
        "avg_loss": round(avg_loss * 100, 2) if counted - wins else None,
        "payoff": round(avg_win / abs(avg_loss), 2) if avg_loss else None,
        # 期望值：每笔的期望收益（= 平均涨幅），胜率高但期望为负同样不能用
        "expectancy": round(float(avg) * 100, 2) if avg is not None else None,
    }


def _group_row(conn: sqlite3.Connection, where: str, params: tuple = (),
               horizons: Sequence[int] = HORIZONS, cal: str = "r",
               cost: float = 0.0) -> sqlite3.Row:
    sql = f"SELECT {_agg_select(horizons, cal=cal, cost=cost)} FROM signals WHERE {where}"
    return conn.execute(sql, params).fetchone()


def summary(conn: sqlite3.Connection, horizons: Sequence[int] = HORIZONS,
            cal: str = "r", cost: float = 0.0) -> list[dict[str, Any]]:
    """条件组 / 对照组，各周期一排（报告主体 + 结论卡的来源）。"""
    valid = valid_where(cal)
    signal_row = _group_row(conn, f"is_control = 0 AND {valid}", (), horizons, cal, cost)
    control_row = _group_row(conn, f"is_control = 1 AND {valid}", (), horizons, cal, cost)
    rows: list[dict[str, Any]] = []
    for horizon in horizons:
        sig = _metrics_of(signal_row, horizon)
        ctl = _metrics_of(control_row, horizon)
        excess = (sig["win_rate"] - ctl["win_rate"]) if sig["win_rate"] is not None and ctl["win_rate"] is not None else None
        rows.append({
            "horizon": horizon,
            "signal": sig,
            "control": ctl,
            "excess_pp": round(excess, 2) if excess is not None else None,
            "z": two_proportion_z(sig["wins"], sig["n"], ctl["wins"], ctl["n"]),
        })
    return rows


def verdict(rows: list[dict[str, Any]], honest: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """结论：能不能用。四种结论（前端各有一句人话）。

    - ``usable``            超额 ≥ 2pp 且统计显著 → 这个条件有用
    - ``worse``             **显著跑输**随机买入 → 得重新设计
    - ``not_significant``   看着有超额但样本不够
    - ``no_edge``           超额小且不显著 → 与随机买入没区别

    ``honest`` 给了就**以它为准**，而且「最优周期」也只从它里面挑 —— 旧实现
    用合并口径挑周期、用诚实口径下结论，会出现「卡片说显著跑输、旁边写着
    +2.1pp」的自相矛盾。合并口径的数字降级为 ``pooled_*`` 留档，不上卡片。
    """
    candidates = [
        row for row in rows
        if row["excess_pp"] is not None and row["signal"]["n"] >= MIN_TOTAL_SAMPLES
    ]
    if not candidates:
        return {
            "usable": False,
            "reason": "insufficient",
            "best_horizon": None,
            "best_excess_pp": None,
            "sample": 0,
        }
    by_horizon = {int(row["horizon"]): row for row in rows}
    pooled_best = max(candidates, key=lambda row: row["excess_pp"])

    if honest and str(honest.get("verdict")) != "insufficient" and honest.get("best_horizon"):
        best_horizon = int(honest["best_horizon"])
        focus = by_horizon.get(best_horizon, pooled_best)
        mapping = {"usable": "usable", "worse": "worse", "mixed": "not_significant",
                   "no_edge": "no_edge", "insufficient": "insufficient"}
        reason = mapping.get(str(honest.get("verdict")), "no_edge")
        result: dict[str, Any] = {
            "usable": reason == "usable",
            "reason": reason,
            "best_horizon": best_horizon,
            "best_excess_pp": honest.get("best_excess_pp"),
            "best_ci_low_pp": honest.get("best_ci_low_pp"),
            "best_ci_high_pp": honest.get("best_ci_high_pp"),
            "best_win_rate": focus["signal"]["win_rate"],
            "baseline_win_rate": focus["control"]["win_rate"],
            "best_avg_return": focus["signal"]["avg_return"],
            "best_payoff": focus["signal"]["payoff"],
            "sample": focus["signal"]["n"],
            "z": focus["z"],
            "significant": bool(honest.get("up_count") or honest.get("down_count")),
            # 主周期（默认 10 日）的诚实区间：结论卡上「执行」那句话用它
            "primary_horizon": honest.get("primary_horizon"),
            "primary_excess_pp": honest.get("primary_excess_pp"),
            "primary_ci_low_pp": honest.get("primary_ci_low_pp"),
            "primary_ci_high_pp": honest.get("primary_ci_high_pp"),
            "up_horizons": honest.get("up_horizons"),
            "down_horizons": honest.get("down_horizons"),
            # 合并口径（旧算法）：保留数字供追溯，不再参与结论
            "pooled_best_horizon": pooled_best["horizon"],
            "pooled_best_excess_pp": pooled_best["excess_pp"],
            "honest": honest,
            "honest_verdict": honest.get("verdict"),
        }
        worst_horizon = honest.get("worst_horizon")
        if worst_horizon is not None:
            worst_row = by_horizon.get(int(worst_horizon))
            result["worst_horizon"] = int(worst_horizon)
            result["worst_excess_pp"] = honest.get("worst_excess_pp")
            if worst_row is not None:
                result["worst_win_rate"] = worst_row["signal"]["win_rate"]
                result["worst_baseline"] = worst_row["control"]["win_rate"]
        return result

    best = pooled_best
    significant = abs(float(best["z"] or 0)) >= 1.96
    usable = bool(
        best["excess_pp"] >= EXCESS_THRESHOLD_PP
        and significant
        and best["signal"]["n"] >= MIN_TOTAL_SAMPLES
    )
    worst_significant = min(
        (row for row in candidates if float(row["z"] or 0) <= -1.96),
        key=lambda row: row["excess_pp"],
        default=None,
    )
    if usable:
        reason = "usable"
    elif worst_significant is not None:
        reason = "worse"
    elif best["excess_pp"] >= EXCESS_THRESHOLD_PP:
        reason = "not_significant"
    else:
        reason = "no_edge"
    result: dict[str, Any] = {
        "usable": usable,
        "reason": reason,
        "best_horizon": best["horizon"],
        "best_excess_pp": best["excess_pp"],
        "best_win_rate": best["signal"]["win_rate"],
        "baseline_win_rate": best["control"]["win_rate"],
        "best_avg_return": best["signal"]["avg_return"],
        "best_payoff": best["signal"]["payoff"],
        "sample": best["signal"]["n"],
        "z": best["z"],
        "significant": significant,
    }
    if worst_significant is not None:
        result["worst_horizon"] = worst_significant["horizon"]
        result["worst_excess_pp"] = worst_significant["excess_pp"]
        result["worst_win_rate"] = worst_significant["signal"]["win_rate"]
        result["worst_baseline"] = worst_significant["control"]["win_rate"]
    if honest is not None:
        result["honest"] = honest
        result["honest_verdict"] = honest.get("verdict")
        mapping = {"usable": "usable", "worse": "worse", "mixed": "not_significant",
                   "no_edge": "no_edge", "insufficient": "insufficient"}
        result["reason"] = mapping.get(str(honest.get("verdict")), result["reason"])
        result["usable"] = result["reason"] == "usable"
        result["significant"] = bool(honest.get("up_count") or honest.get("down_count"))
    return result


# ---------------------------------------------------------------- 分组维度
class Dimension:
    """一个分组维度：``expr`` 是 SQL 表达式，``order`` 决定展示顺序。"""

    def __init__(self, key: str, label: str, expr: str, order: Optional[list[str]] = None,
                 hint: str = "") -> None:
        self.key = key
        self.label = label
        self.expr = expr
        self.order = order
        self.hint = hint


def _case(default: str, buckets: list[tuple[str, str]]) -> str:
    """``CASE WHEN cond THEN label … ELSE default END``（buckets 顺序 = 展示顺序）。"""
    when = " ".join(f"WHEN {cond} THEN '{label}'" for label, cond in buckets)
    return f"CASE {when} ELSE '{default}' END"


def _tiers(column: str, edges: list[float], labels: list[str]) -> str:
    """数值列按升序切档：``edges`` 是下界（不含），``labels`` 比 edges 多一个。"""
    buckets: list[tuple[str, str]] = []
    for index, edge in enumerate(edges):
        buckets.append((labels[index], f"{column} IS NOT NULL AND {column} < {edge}"))
    buckets.append((labels[-1], f"{column} >= {edges[-1]}"))
    return _case("未知", buckets)


def dimensions() -> list[Dimension]:
    """13 个分类维度（用户第 11 条：市场、市值、板块、行业…）。"""
    return [
        Dimension("board", "市场", "board", ["sh", "sz", "cyb", "kcb", "other"]),
        Dimension("industry", "行业", "COALESCE(NULLIF(industry, ''), '未知')"),
        Dimension("industry_l1", "行业门类", "COALESCE(NULLIF(industry_l1, ''), '未知')"),
        Dimension("mcap", "总市值", _tiers("mcap", [30, 100, 300, 1000],
                                          ["小于30亿", "30-100亿", "100-300亿", "300-1000亿", "1000亿以上"])),
        Dimension("price", "股价", _tiers("d0_close", [5, 10, 30, 100],
                                          ["5元以下", "5-10元", "10-30元", "30-100元", "100元以上"])),
        Dimension("amount", "成交额", _tiers("amount", [0.5, 2, 5, 20],
                                             ["0.5亿以下", "0.5-2亿", "2-5亿", "5-20亿", "20亿以上"])),
        Dimension("turnover", "换手率", _tiers("turnover", [1, 3, 7, 15],
                                                ["1%以下", "1-3%", "3-7%", "7-15%", "15%以上"])),
        Dimension("pe", "市盈率", _case("未知", [
            ("亏损", "pe IS NOT NULL AND pe < 0"),
            ("0-20", "pe >= 0 AND pe < 20"),
            ("20-40", "pe >= 20 AND pe < 40"),
            ("40-80", "pe >= 40 AND pe < 80"),
            ("80以上", "pe >= 80"),
        ])),
        Dimension("pb", "市净率", _tiers("pb", [1, 3, 6], ["1以下", "1-3", "3-6", "6以上"])),
        Dimension("listed", "上市年限", _tiers("listed_days", [250, 750, 2500],
                                                ["次新(1年内)", "1-3年", "3-10年", "10年以上"])),
        Dimension("amplitude", "振幅", _tiers("amplitude", [2, 5, 9],
                                               ["2%以下", "2-5%", "5-9%", "9%以上"])),
        Dimension("breadth", "大盘环境", _tiers("breadth", [0.35, 0.5, 0.65],
                                                 ["弱(阳线<35%)", "偏弱(35-50%)", "偏强(50-65%)", "强(65%以上)"])),
        Dimension("crowd", "拥挤度", _tiers("crowd", [11, 51, 201],
                                             ["1-10只", "11-50只", "51-200只", "200只以上"])),
        Dimension("year", "年份", "SUBSTR(d0, 1, 4)"),
    ]


def _cache_ready(conn: sqlite3.Connection, horizons: Sequence[int], cal: str = "r") -> bool:
    try:
        row = conn.execute("SELECT value FROM cache_meta WHERE key = 'version'").fetchone()
    except sqlite3.OperationalError:
        return False
    if row is None or int(row[0]) != CACHE_VERSION:
        return False
    cached = conn.execute("SELECT value FROM cache_meta WHERE key = 'horizons'").fetchone()
    if not (cached and str(cached[0]) == ",".join(str(h) for h in horizons)):
        return False
    caliber = conn.execute("SELECT value FROM cache_meta WHERE key = 'caliber'").fetchone()
    return bool(caliber and str(caliber[0]) == cal)


#: 只读连接（例如老的调用方）写不了缓存表时的内存兜底：{horizons: (group_rows, arrival_rows)}
_MEM_CACHE: dict[tuple[int, ...], tuple[list[tuple], list[tuple]]] = {}


def _write_cache(conn: sqlite3.Connection, group_rows: list[tuple], arrival_rows: list[tuple],
                 horizons: Sequence[int], cal: str = "r") -> None:
    conn.executescript(
        "CREATE TABLE IF NOT EXISTS group_stats ("
        "dim TEXT, key TEXT, horizon INTEGER, n INTEGER, wins INTEGER, avg REAL, "
        "PRIMARY KEY (dim, key, horizon));"
        "CREATE TABLE IF NOT EXISTS arrival_stats (day INTEGER PRIMARY KEY, n INTEGER);"
        "CREATE TABLE IF NOT EXISTS cache_meta (key TEXT PRIMARY KEY, value TEXT);"
    )
    conn.execute("DELETE FROM group_stats")
    conn.execute("DELETE FROM arrival_stats")
    conn.executemany("INSERT INTO group_stats (dim, key, horizon, n, wins, avg) VALUES (?,?,?,?,?,?)",
                     group_rows)
    conn.executemany("INSERT INTO arrival_stats (day, n) VALUES (?,?)", arrival_rows)
    conn.execute("INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('version', ?)",
                 (str(CACHE_VERSION),))
    conn.execute("INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('horizons', ?)",
                 (",".join(str(h) for h in horizons),))
    conn.execute("INSERT OR REPLACE INTO cache_meta (key, value) VALUES ('caliber', ?)", (cal,))
    conn.commit()


def compute_cache(conn: sqlite3.Connection, horizons: Sequence[int],
                  cal: str = "r", cost: float = 0.0) -> tuple[list[tuple], list[tuple]]:
    """一次性把分组统计与到达天数算进缓存表（扫一遍 signals）。"""
    last = int(horizons[-1])            # 逐日取到最长周期：到达天数要按「第几天」算
    columns = ", ".join(f"{_expr(day, cal, cost=cost)} AS r{day}" for day in range(1, last + 1))
    key_exprs = {dim.key: dim.expr for dim in dimensions()}
    # 每条 SQL 只取「分组键 + 该周期涨幅」，Python 侧累加（比 36 个 SUM(CASE) 快）
    group_counts: dict[tuple[str, str, int], list[int]] = {}
    group_sums: dict[tuple[str, str, int], float] = {}
    arrival: dict[int, int] = {}
    select_keys = ", ".join(f"({expr}) AS d{index}" for index, expr in enumerate(key_exprs.values()))
    sql = f"SELECT {select_keys}, {columns} FROM signals WHERE is_control = 0 AND avail > 0 AND {valid_where(cal)}"
    keys = list(key_exprs.keys())
    scanned = 0
    never_positive = 0
    for row in conn.execute(sql):
        scanned += 1
        daily = list(row[len(keys):])
        first_positive: Optional[int] = next(
            (offset + 1 for offset, value in enumerate(daily) if value is not None and value > 0),
            None,
        )
        for offset, horizon in enumerate(horizons):
            value = daily[horizon - 1] if horizon - 1 < len(daily) else None
            if value is None:
                continue
            for index, dim_key in enumerate(keys):
                slot = (dim_key, str(row[index]), horizon)
                counts = group_counts.get(slot)
                if counts is None:
                    group_counts[slot] = [1, 1 if value > 0 else 0]
                    group_sums[slot] = float(value)
                else:
                    counts[0] += 1
                    if value > 0:
                        counts[1] += 1
                    group_sums[slot] += float(value)
        if first_positive is not None:
            arrival[first_positive] = arrival.get(first_positive, 0) + 1
        else:
            never_positive += 1
    group_rows = [
        # 存**平均**涨幅，不是 Σ 涨幅：分组表里显示的是「这一类平均赚多少」，
        # 存总和会让「样本 5000 条」的那一格显示成 2500%。
        (dim_key, key, horizon, counts[0], counts[1],
         group_sums[(dim_key, key, horizon)] / counts[0] if counts[0] else 0.0)
        for (dim_key, key, horizon), counts in group_counts.items()
    ]
    arrival_rows = sorted(arrival.items())
    # -1 = 整个验证期内一次都没收涨：分母必须包含它们，否则「5 天内到达率」会虚高
    arrival_rows.append((-1, never_positive))
    _MEM_CACHE[tuple(horizons)] = (group_rows, arrival_rows)
    try:
        _write_cache(conn, group_rows, arrival_rows, horizons, cal)
    except sqlite3.OperationalError:
        # 只读连接（老的调用方 / 单测）写不了缓存表：退回内存，结果一样
        logger.warning("缓存表写入失败（只读连接？），本次用内存统计")
    return group_rows, arrival_rows


def _ensure_cache(conn: sqlite3.Connection, horizons: Sequence[int],
                  cal: str = "r", cost: float = 0.0) -> tuple[list[tuple], list[tuple]] | None:
    """确保缓存可用；返回 None 表示可直接读表，返回数据表示用内存结果。"""
    if _cache_ready(conn, horizons, cal):
        return None
    return compute_cache(conn, horizons, cal, cost)


def invalidate_cache(conn: sqlite3.Connection) -> None:
    """口径/数据变了以后清掉缓存（下次读报告时重算）。"""
    for sql in ("DELETE FROM cache_meta WHERE key = 'version'", "DELETE FROM report_cache"):
        try:
            conn.execute(sql)
        except sqlite3.OperationalError:
            continue
    conn.commit()


def _report_key(conn: sqlite3.Connection, horizons: Sequence[int], cal: str = "r") -> str:
    """报告缓存的键：口径版本 + 口径 + 周期 + 信号行数（续跑后行数会变，自动失效）。"""
    total = conn.execute("SELECT COUNT(*) AS n FROM signals").fetchone()["n"]
    return f"{CACHE_VERSION}:{cal}:{','.join(str(h) for h in horizons)}:{int(total)}"


def _read_report_cache(conn: sqlite3.Connection, key: str) -> Optional[dict[str, Any]]:
    try:
        row = conn.execute("SELECT payload FROM report_cache WHERE key = ?", (key,)).fetchone()
    except sqlite3.OperationalError:
        return None
    if row is None:
        return None
    try:
        return json.loads(row["payload"])
    except ValueError:
        return None


def _write_report_cache(conn: sqlite3.Connection, key: str, payload: dict[str, Any]) -> None:
    try:
        conn.executescript(
            "CREATE TABLE IF NOT EXISTS report_cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL);"
        )
        conn.execute(
            "INSERT OR REPLACE INTO report_cache (key, payload) VALUES (?, ?)",
            (key, json.dumps(payload, ensure_ascii=False)),
        )
        conn.commit()
    except sqlite3.OperationalError:
        logger.warning("报告缓存写入失败（只读连接？）")


def overall_win(rows: list[dict[str, Any]]) -> dict[int, float]:
    return {
        int(row["horizon"]): float(row["signal"]["win_rate"])
        for row in rows
        if row["signal"]["win_rate"] is not None
    }


def groups(conn: sqlite3.Connection, horizons: Sequence[int],
           baseline: dict[int, float], cal: str = "r", cost: float = 0.0,
           control_baseline: Optional[dict[int, float]] = None) -> list[dict[str, Any]]:
    """每个维度的分组统计：n / 胜率 / 区间 / 优势 / z / BH 校正后的 q。"""
    memory = _ensure_cache(conn, horizons, cal, cost)
    focus = horizons[-1] if horizons else 0
    totals: dict[int, tuple[int, int]] = {}
    for horizon in horizons:
        row = conn.execute(
            f"SELECT COUNT({_expr(horizon, cal, cost=cost)}) AS n, "
            f"SUM(CASE WHEN {_expr(horizon, cal, cost=cost)} > 0 THEN 1 ELSE 0 END) AS w "
            f"FROM signals WHERE is_control = 0 AND {valid_where(cal)}"
        ).fetchone()
        totals[horizon] = (int(row["n"] or 0), int(row["w"] or 0))
    output: list[dict[str, Any]] = []
    for dim in dimensions():
        if memory is None:
            rows = conn.execute(
                "SELECT key, horizon, n, wins, avg FROM group_stats WHERE dim = ?", (dim.key,)
            ).fetchall()
        else:
            rows = [
                {"key": key, "horizon": horizon, "n": n, "wins": wins, "avg": avg}
                for (dim_key, key, horizon, n, wins, avg) in memory[0]
                if dim_key == dim.key
            ]
        buckets: dict[str, dict[str, Any]] = {}
        for row in rows:
            slot = buckets.setdefault(str(row["key"]), {"key": str(row["key"]), "horizons": {}})
            slot["horizons"][int(row["horizon"])] = row
        items: list[dict[str, Any]] = []
        pvalues: list[float] = []
        for key, slot in buckets.items():
            metrics: dict[str, Any] = {}
            for horizon in horizons:
                row = slot["horizons"].get(horizon)
                if row is None or int(row["n"]) == 0:
                    metrics[str(horizon)] = {"n": 0, "win_rate": None}
                    continue
                n, wins = int(row["n"]), int(row["wins"])
                low, high = wilson(wins, n)
                rate = wins / n * 100
                base = baseline.get(horizon)
                metrics[str(horizon)] = {
                    "n": n,
                    # 原始计数留一份：z 检验要用整数，不能拿四舍五入后的胜率反算
                    "wins": wins,
                    "win_rate": round(rate, 2),
                    "ci_low": low,
                    "ci_high": high,
                    "avg_return": round(float(row["avg"]) * 100, 2) if row["avg"] is not None else None,
                    "edge_pp": round(rate - base, 2) if base is not None else None,
                }
            focus_cell = metrics.get(str(focus)) or {}
            n_focus = int(focus_cell.get("n") or 0)
            wins_focus = int(focus_cell.get("wins") or 0)
            # 该分组 vs 其余信号（同周期）的两比例 z 检验 —— 不依赖对照组
            total_n, total_wins = totals.get(focus, (0, 0))
            other_n = max(0, total_n - n_focus)
            other_wins = max(0, total_wins - wins_focus)
            z = two_proportion_z(wins_focus, n_focus, other_wins, other_n) if n_focus else 0.0
            pvalues.append(_two_sided_p(z) if n_focus else 1.0)
            items.append({
                "key": key,
                "n": n_focus,
                "sample_total": sum(int((cell or {}).get("n") or 0) for cell in metrics.values()),
                "horizons": metrics,
                "z": z,
            })
        qvalues = bh_qvalues(pvalues)
        for item, q in zip(items, qvalues):
            cell = item["horizons"].get(str(focus)) or {}
            edge = cell.get("edge_pp")
            item["q"] = q
            item["significant"] = bool(
                item["n"] >= MIN_GROUP_SAMPLES
                and q < Q_THRESHOLD
                and edge is not None
                and edge > 0
            )
            item["verdict"] = (
                "insufficient" if item["n"] < MIN_GROUP_SAMPLES
                else "edge" if item["significant"]
                else "no_edge"
            )
            item["win_rate"] = cell.get("win_rate")
            item["edge_pp"] = edge
            # 相对同期随机买入的超额：分组优势只是「比这个条件平均水平好」，
            # 一个分类完全可能「在自己条件里最强」却仍然跑输随机买入。
            base_rate = (control_baseline or {}).get(focus)
            item["excess_vs_random_pp"] = (
                round(float(item["win_rate"]) - base_rate, 2)
                if item["win_rate"] is not None and base_rate is not None else None
            )
            item["avg_return"] = cell.get("avg_return")
        if dim.order:
            position = {key: index for index, key in enumerate(dim.order)}
            items.sort(key=lambda item: (position.get(item["key"], 99), -item["n"]))
        else:
            items.sort(key=lambda item: -item["n"])
        output.append({
            "dim": dim.key,
            "label": dim.label,
            "hint": dim.hint,
            "focus_horizon": focus,
            "items": items,
        })
    return output


def arrival(conn: sqlite3.Connection, horizons: Sequence[int], cal: str = "r",
            cost: float = 0.0) -> dict[str, Any]:
    """第一次收涨的到达天数分布（回答「几天内能走出来」，不随周期单调上升）。"""
    memory = _ensure_cache(conn, horizons, cal, cost)
    if memory is None:
        rows = conn.execute("SELECT day, n FROM arrival_stats ORDER BY day").fetchall()
    else:
        rows = [{"day": day, "n": n} for day, n in memory[1]]
    horizon = horizons[-1] if horizons else 0
    counts = {int(row["day"]): int(row["n"]) for row in rows}
    never = counts.pop(-1, 0)
    total = sum(counts.values()) + never
    within = {span: sum(value for day, value in counts.items() if day <= span)
              for span in horizons}
    median = None
    running = 0
    for day in sorted(counts):
        running += counts[day]
        if total and running >= total / 2:
            median = day
            break
    return {
        "buckets": [{"day": day, "n": counts[day]} for day in sorted(counts)],
        "never_positive": never,
        "median_days": median,
        "total": total,
        "within": {str(span): round(within[span] / total * 100, 2) if total else None
                   for span in horizons},
        "horizon": horizon,
    }


# ---------------------------------------------------------------- 个股
def by_stock(conn: sqlite3.Connection, control_rows: dict[int, float],
             horizons: Sequence[int] = HORIZONS, cal: str = "r",
             cost: float = 0.0) -> list[dict[str, Any]]:
    """按股票的准确率排行。``control_rows`` = {周期: 对照组胜率}（只用来算超额）。

    排行按**收缩后**的胜率（``win_shrunk``）排，不按原始胜率：命中 3 次全胜的
    股票原始胜率 100%，会排在命中 300 次 65% 的股票前面，纯噪声。经验贝叶斯
    （Beta-二项，先验强度 ``SHRINK_PRIOR``）把样本少的往总体均值拉。
    """
    sql = (
        f"SELECT code, MAX(name) AS name, MAX(board) AS board, MAX(industry) AS industry, "
        f"MAX(mcap) AS mcap, {_agg_select(horizons, cal=cal, cost=cost)} "
        f"FROM signals WHERE is_control = 0 AND {valid_where(cal)} GROUP BY code"
    )
    focus_h = horizons[-1] if horizons else 0
    prior_rate = None
    overall = conn.execute(
        f"SELECT SUM(CASE WHEN {_expr(focus_h, cal, cost=cost)} > 0 THEN 1 ELSE 0 END) AS w, "
        f"COUNT({_expr(focus_h, cal, cost=cost)}) AS n "
        f"FROM signals WHERE is_control = 0 AND {valid_where(cal)}"
    ).fetchone()
    if overall and int(overall["n"] or 0) > 0:
        prior_rate = float(overall["w"] or 0) / int(overall["n"])
    items: list[dict[str, Any]] = []
    for row in conn.execute(sql):
        n = int(row[f"c{focus_h}"] or row["total"] or 0)
        win: dict[str, float | None] = {}
        avg: dict[str, float | None] = {}
        excess: dict[str, float | None] = {}
        shrunk: dict[str, float | None] = {}
        for horizon in horizons:
            counted = int(row[f"c{horizon}"] or 0)
            wins = int(row[f"w{horizon}"] or 0)
            rate = round(wins / counted * 100, 2) if counted else None
            value = row[f"a{horizon}"]
            win[str(horizon)] = rate
            avg[str(horizon)] = round(float(value) * 100, 2) if value is not None else None
            base = control_rows.get(horizon)
            excess[str(horizon)] = round(rate - base, 2) if rate is not None and base is not None else None
            # Beta-二项收缩：prior_rate 用条件整体胜率，强度 20 次
            if counted and prior_rate is not None:
                adjusted = (wins + SHRINK_PRIOR * prior_rate) / (counted + SHRINK_PRIOR)
                shrunk[str(horizon)] = round(adjusted * 100, 2)
            else:
                shrunk[str(horizon)] = None
        items.append({
            "code": str(row["code"]),
            "name": str(row["name"] or ""),
            "board": str(row["board"] or "other"),
            "industry": str(row["industry"] or "") or None,
            "mcap": row["mcap"],
            "n": int(row["total"] or 0),
            "win": win,
            "avg": avg,
            "excess": excess,
            "win_shrunk": shrunk,
            "sufficient": n >= MIN_STOCK_SAMPLES,
        })
    focus = str(focus_h)
    items.sort(key=lambda item: (-(item["win_shrunk"].get(focus) or -1), -item["n"]))
    return items


def _breakdown(conn: sqlite3.Connection, key_sql: str, horizons: Sequence[int],
               baseline: dict[int, float], control_rates: dict[int, float],
               cal: str = "r", cost: float = 0.0) -> list[dict[str, Any]]:
    sql = (
        f"SELECT {key_sql} AS key, is_control, {_agg_select(horizons, cal=cal, cost=cost)} FROM signals "
        f"WHERE {valid_where(cal)} GROUP BY key, is_control ORDER BY key"
    )
    buckets: dict[str, dict[str, Any]] = {}
    for row in conn.execute(sql):
        key = str(row["key"])
        slot = buckets.setdefault(key, {"key": key, "signal": None, "control": None})
        slot["control" if int(row["is_control"]) else "signal"] = {
            str(horizon): _metrics_of(row, horizon) for horizon in horizons
        }
    items: list[dict[str, Any]] = []
    for key, slot in sorted(buckets.items()):
        item: dict[str, Any] = {"key": key, "signal": slot["signal"], "control": slot["control"]}
        excess: dict[str, float | None] = {}
        for horizon in horizons:
            sig = (slot["signal"] or {}).get(str(horizon)) or {}
            base = baseline.get(horizon)
            # 界面上不显示对照组（用户第 6 条）：这里的 excess 是「相对条件整体」，
            # 对照组胜率另存 baseline 供结论卡使用。
            excess[str(horizon)] = (
                round(sig["win_rate"] - base, 2)
                if sig.get("win_rate") is not None and base is not None else None
            )
        item["excess"] = excess
        items.append(item)
    return items


def by_board(conn: sqlite3.Connection, horizons: Sequence[int],
             baseline: dict[int, float], control_rates: dict[int, float],
             cal: str = "r", cost: float = 0.0) -> list[dict[str, Any]]:
    return _breakdown(conn, "board", horizons, baseline, control_rates, cal, cost)


def by_year(conn: sqlite3.Connection, horizons: Sequence[int],
            baseline: dict[int, float], control_rates: dict[int, float],
            cal: str = "r", cost: float = 0.0) -> list[dict[str, Any]]:
    return _breakdown(conn, "SUBSTR(d0, 1, 4)", horizons, baseline, control_rates, cal, cost)


# ---------------------------------------------------------------- 分布
def histograms(conn: sqlite3.Connection, horizons: Sequence[int], max_points: int = 4,
               cal: str = "r", cost: float = 0.0) -> dict[str, Any]:
    """前几个周期的涨幅分布（条件组）。看右尾够不够长、有没有明显左偏。"""
    picked = list(horizons[:max_points])
    buckets = {str(h): [0] * (len(HIST_EDGES) - 1) for h in picked}
    below = {str(h): 0 for h in picked}
    above = {str(h): 0 for h in picked}
    columns = ", ".join(f"{_expr(horizon, cal, cost=cost)} AS r{horizon}" for horizon in picked)
    for row in conn.execute(
        f"SELECT {columns} FROM signals WHERE is_control = 0 AND {valid_where(cal)}"
    ):
        for index, horizon in enumerate(picked, start=1):
            value = row[index - 1]
            if value is None:
                continue
            pct = float(value) * 100
            if pct < HIST_EDGES[0]:
                below[str(horizon)] += 1
                continue
            if pct >= HIST_EDGES[-1]:
                above[str(horizon)] += 1
                continue
            position = int((pct - HIST_EDGES[0]) // 5)
            buckets[str(horizon)][min(position, len(HIST_EDGES) - 2)] += 1
    return {
        "edges": list(HIST_EDGES),
        "series": [
            {"horizon": horizon, "counts": buckets[str(horizon)],
             "below": below[str(horizon)], "above": above[str(horizon)]}
            for horizon in picked
        ],
    }


def density(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """每日命中数（逐年变少通常意味着参数被市场消化了）。"""
    sql = (
        "SELECT d0, SUM(CASE WHEN is_control = 0 THEN 1 ELSE 0 END) AS hits "
        "FROM signals GROUP BY d0 ORDER BY d0"
    )
    return [{"d0": str(row["d0"]), "hits": int(row["hits"] or 0)} for row in conn.execute(sql)]


def control_win_rates(rows: list[dict[str, Any]]) -> dict[int, float]:
    """{周期: 对照组胜率} —— 按股票算超额时用同一把尺子。"""
    result: dict[int, float] = {}
    for row in rows:
        rate: Optional[float] = row["control"]["win_rate"]
        if rate is not None:
            result[int(row["horizon"])] = float(rate)
    return result


def quality(conn: sqlite3.Connection, cal: str = "r") -> dict[str, Any]:
    """数据质量：哪几天的数据不完整、多少行不可验证、多少行买不进。

    「某天只同步了一半」与「这天真的没有信号」在结果上长得一样（都是命中很少），
    不查的话会被当成真实信号，污染按日聚合与命中密度。判据：当天有成交的股票数
    低于全期中位数的 90% → 标记为可疑日，统计时可以剔除。
    """
    rows = conn.execute(
        "SELECT d0, hits, control, coverage FROM days ORDER BY d0"
    ).fetchall()
    # 逐日「本地中位数」：股票池七年里从 3800 只长到 5570 只，用全期中位数当阈值
    # 会把 2020 年整年误判成「行情不全」。改成前后各 10 个交易日的中位数。
    series = [(str(row["d0"]), int(row["hits"]),
               int(row["coverage"]) if row["coverage"] is not None else None) for row in rows]
    window = 10
    flags: list[tuple[str, int, int, int]] = []
    local_medians: list[int] = []
    for index, (day, hits, coverage) in enumerate(series):
        if coverage is None:
            continue
        neighbours = [value for _d, _h, value in
                      series[max(0, index - window): index + window + 1] if value is not None]
        if not neighbours:
            continue
        local = sorted(neighbours)[len(neighbours) // 2]
        local_medians.append(local)
        if local > 0 and coverage < local * 0.9:
            flags.append((day, coverage, local, hits))
    median = sorted(local_medians)[len(local_medians) // 2] if local_medians else None
    threshold = int(median * 0.9) if median else None
    suspect = [{"d0": day, "coverage": coverage, "hits": hits, "local_median": local}
               for day, coverage, local, hits in flags]
    stats_row = conn.execute(
        "SELECT COUNT(*) AS n, "
        "SUM(CASE WHEN COALESCE(verif, 1) = 0 THEN 1 ELSE 0 END) AS unverifiable, "
        "SUM(CASE WHEN COALESCE(unfillable, 0) = 1 THEN 1 ELSE 0 END) AS unfillable, "
        "SUM(CASE WHEN COALESCE(stale_days, 0) >= 5 THEN 1 ELSE 0 END) AS stale5, "
        "SUM(CASE WHEN COALESCE(adj_missing, 0) > 0 THEN 1 ELSE 0 END) AS adj_missing, "
        "MAX(COALESCE(stale_days, 0)) AS max_stale "
        "FROM signals WHERE is_control = 0"
    ).fetchone()
    total = int(stats_row["n"] or 0)
    return {
        "days": len(rows),
        "coverage_median": median,
        "coverage_threshold": threshold,
        "suspect_days": suspect[:20],
        "suspect_days_count": len(suspect),
        "rows": total,
        "unverifiable": int(stats_row["unverifiable"] or 0),
        "unfillable": int(stats_row["unfillable"] or 0),
        "stale_over_5d": int(stats_row["stale5"] or 0),
        "adj_missing_rows": int(stats_row["adj_missing"] or 0),
        "max_stale_days": int(stats_row["max_stale"] or 0),
        "usable_rate": round((total - int(stats_row["unverifiable"] or 0)) / total * 100, 2) if total else None,
        "caliber": cal,
    }


def stability(conn: sqlite3.Connection, horizons: Sequence[int], cal: str = "r",
              cost: float = 0.0, split: str = "2024-01-01") -> dict[str, Any]:
    """样本内/样本外：设计期（split 之前）与验证期（split 之后）各自的日度超额。

    在 2020–2023 调出来的条件，2024 之后大概率失效 —— 只给一个「全期平均」会
    把这种失效藏起来。
    """
    design = [significance.horizon_test(conn, int(h), cal, cost, None, split) for h in horizons]
    validate = [significance.horizon_test(conn, int(h), cal, cost, split, None) for h in horizons]
    return {
        "split": split,
        "design": design,
        "validate": validate,
        "design_excess_pp": {str(row["horizon"]): row["mean_excess_pp"] for row in design},
        "validate_excess_pp": {str(row["horizon"]): row["mean_excess_pp"] for row in validate},
        "decay_pp": {
            str(row["horizon"]): (
                round(row["mean_excess_pp"] - other["mean_excess_pp"], 3)
                if row["mean_excess_pp"] is not None and other["mean_excess_pp"] is not None else None
            )
            for row, other in zip(validate, design)
        },
    }


def pick_primary(horizons: Sequence[int]) -> int:
    """主周期：优先 10 日，其次 5 日，再退到最后一个（结论卡与成本/入场/组合都用它）。"""
    if 10 in horizons:
        return 10
    if 5 in horizons:
        return 5
    return int(horizons[-1]) if horizons else 30


def cost_sensitivity(conn: sqlite3.Connection, horizons: Sequence[int],
                     cal: str = "r") -> dict[str, Any]:
    """同一个条件在四档成本假设下的超额（按日聚合，口径与主报告一致）。

    只有可执行口径（``x``）有意义：收盘口径本来就没有成本这回事。
    """
    prefix = caliber_prefix(cal)
    if prefix != "x":
        return {"available": False, "levels": [], "note": "close_caliber"}
    levels: list[dict[str, Any]] = []
    for key, value in costs.LEVELS:
        expression: Any = costs.cost_sql() if value is None else float(value)
        day_rates: dict[int, dict[str, dict[int, tuple[int, int]]]] = {0: {}, 1: {}}
        for control in (0, 1):
            parts: list[str] = []
            for horizon in horizons:
                parts.append(f"COUNT({prefix}{horizon}) AS n{horizon}")
                parts.append(
                    f"SUM(CASE WHEN ({prefix}{horizon} - {expression}) > 0 THEN 1 ELSE 0 END) AS w{horizon}"
                )
            sql = (
                f"SELECT d0, {', '.join(parts)} FROM signals WHERE is_control = {control} "
                f"AND {valid_where(cal)} GROUP BY d0"
            )
            for row in conn.execute(sql):
                day_rates[control][str(row["d0"])] = {
                    int(horizon): (int(row[f"n{horizon}"] or 0), int(row[f"w{horizon}"] or 0))
                    for horizon in horizons
                }
        per_horizon: dict[str, Any] = {}
        for horizon in horizons:
            diffs: list[float] = []
            for day in set(day_rates[0]) & set(day_rates[1]):
                signal_n, signal_w = day_rates[0][day][int(horizon)]
                control_n, control_w = day_rates[1][day][int(horizon)]
                if signal_n <= 0 or control_n <= 0:
                    continue
                diffs.append(signal_w / signal_n - control_w / control_n)
            per_horizon[str(horizon)] = (
                round(sum(diffs) / len(diffs) * 100, 3) if diffs else None
            )
        levels.append({
            "key": key,
            "label": next(item["label"] for item in costs.describe() if item["key"] == key),
            "cost": value,
            "horizons": per_horizon,
        })
    return {"available": True, "levels": levels, "note": None}


def heterogeneity(conn: sqlite3.Connection, horizon: int, cal: str = "r",
                  cost: float = 0.0) -> dict[str, Any]:
    """逐年超额 + Cochran's Q：优势是不是只在某一年存在。"""
    prefix = caliber_prefix(cal)
    years = [str(row[0]) for row in conn.execute(
        "SELECT DISTINCT SUBSTR(d0, 1, 4) AS year FROM signals ORDER BY year"
    )]
    rows: list[dict[str, Any]] = []
    for year in years:
        if not year.isdigit():
            continue
        test = significance.horizon_test(
            conn, horizon, prefix, cost, f"{year}-01-01", f"{int(year) + 1}-01-01"
        )
        if test.get("mean_excess_pp") is None or test.get("ci_high_pp") is None:
            continue
        half_width = (float(test["ci_high_pp"]) - float(test["ci_low_pp"])) / 2.0
        se = half_width / 1.96
        rows.append({
            "year": year,
            "effect_pp": test["mean_excess_pp"],
            "se_pp": round(se, 4),
            "days": test["days"],
            "significant_down": bool(test.get("significant_down")),
            "significant_up": bool(test.get("significant_up")),
        })
    return {"horizon": horizon, "rows": rows, **significance.cochran_q(rows)}


def power_of(honest_row: Optional[dict[str, Any]]) -> dict[str, Any]:
    """这个样本量能检出多大的超额（80% 功效）。"""
    if not honest_row:
        return {"mde_pp": None, "n_eff": 0, "days_for_2pp": None}
    days = int(honest_row.get("days") or 0)
    low, high = honest_row.get("ci_low_pp"), honest_row.get("ci_high_pp")
    n_eff = int(honest_row.get("n_eff") or 0)
    if low is None or high is None or days <= 0:
        return {"mde_pp": None, "n_eff": n_eff, "days_for_2pp": None}
    se = (float(high) - float(low)) / (2.0 * 1.96)
    sd = se * math.sqrt(days)
    return significance.power_table(sd, n_eff)


def build_report(conn: sqlite3.Connection, meta: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """报告主体（弹窗与独立报告页共用这一个响应）。"""
    validate_days = int((meta or {}).get("validate_days") or HORIZONS[-1])
    horizons = tuple((meta or {}).get("horizons") or horizons_for(validate_days))
    prefix, caliber = significance.caliber_columns(conn)
    # 可执行口径扣 0.2% 往返成本；老任务没有 x 列时退回收盘口径、不扣成本
    cost = forward_cost() if caliber == "exec" else 0.0
    cache_key = _report_key(conn, horizons, caliber)
    cached = _read_report_cache(conn, cache_key)
    if cached is not None:
        return cached
    rows = summary(conn, horizons, prefix, cost)
    honest_rows, _ = significance.tests(conn, horizons, cost)
    conclusion = significance.conclusion(honest_rows)
    decision = verdict(rows, conclusion)
    baseline = overall_win(rows)
    control = control_win_rates(rows)
    primary = pick_primary(horizons)
    primary_row = next((row for row in honest_rows if int(row["horizon"]) == primary), None)
    quality_block = quality(conn, prefix)

    def _safe(builder: Any, fallback: Any) -> Any:
        """任何一块新统计失败都不能让整份报告 500（任务本身是好的）。"""
        try:
            return builder()
        except Exception:  # noqa: BLE001
            logger.exception("报告分段计算失败，用空值兜底")
            return fallback

    report = {
        "summary": rows,
        "verdict": decision,
        "conclusion": conclusion,
        "significance": honest_rows,
        "signal_weighted": _safe(lambda: significance.weighted_tests(conn, horizons, cost), []),
        "power": _safe(lambda: power_of(primary_row), {}),
        "cost_sensitivity": _safe(lambda: cost_sensitivity(conn, horizons, prefix),
                                  {"available": False, "levels": [], "note": "failed"}),
        "entry": _safe(lambda: entry.sensitivity(conn, primary, cost), []),
        "portfolio": _safe(lambda: portfolio.simulate(
            conn, primary, 10, None if caliber == "exec" else 0.0), {}),
        "attribution": _safe(lambda: attribution_module.fit(conn, primary, prefix, cost), {}),
        "heterogeneity": _safe(lambda: heterogeneity(conn, primary, prefix, cost),
                               {"horizon": primary, "rows": []}),
        "caliber": caliber,
        "cost": cost,
        "primary_horizon": primary,
        "stability": stability(conn, horizons, prefix, cost),
        "quality": {**quality_block,
                    "health": _safe(lambda: health.snapshot(conn, caliber, quality_block), {})},
        "data_version": (meta or {}).get("data_version") or {},
        "groups": groups(conn, horizons, baseline, prefix, cost, control),
        "arrival": arrival(conn, horizons, prefix, cost),
        "by_board": by_board(conn, horizons, baseline, control, prefix, cost),
        "by_year": by_year(conn, horizons, baseline, control, prefix, cost),
        "histograms": histograms(conn, horizons, cal=prefix, cost=cost),
        "density": density(conn),
        "horizons": list(horizons),
        "validate_days": validate_days,
        # 界面不展示对照组（用户第 6 条）；这个标记让前端不必猜
        "control_hidden": True,
        "evaluation_version": "v4",
    }
    _write_report_cache(conn, cache_key, report)
    return report
