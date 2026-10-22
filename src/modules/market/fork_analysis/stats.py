"""统计层：把 ``signals.db`` 里的逐条信号算成「这个条件到底有没有用」。

口径（用户 2026-10-22 定的）
--------------------------
- **胜率** = 第 N 天收盘涨幅 > 0 的比例（收盘口径，回答「持有到第 N 天赚没赚」）；
- **触及率** = N 天内最高价曾高于 d0 收盘的比例（回答「有没有机会」，N 越大概率越高）；
- **超额胜率** = 条件组胜率 − 对照组（同一天、同市场随机股票）胜率，单位百分点。
  这是唯一能回答「准确率高是不是因为它本来就会涨」的数字 —— 全市场随机买入的
  30 天胜率本来就在 50% 附近；
- **盈亏比** = 平均盈利幅度 / |平均亏损幅度|；**期望收益** = 平均涨幅。
  胜率高但期望为负的条件同样不能用，所以三个数必须一起看。

样本量
-----
每个概率旁边都带样本数；Wilson 95% 区间低于要求或样本过小的结论一律标
``insufficient``，不让「命中 3 次全胜」排到排行榜第一。
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Optional

from .models import HORIZONS

#: 排行/结论要求的最小样本（单股信号数）
MIN_STOCK_SAMPLES = 30
#: 结论要求的最小总样本
MIN_TOTAL_SAMPLES = 100
#: 低于这个超额（百分点）按「与随机买入没有区别」处理
EXCESS_THRESHOLD_PP = 2.0

#: 直方图分箱（百分数）：-50% 到 +100%，每 5% 一格
HIST_EDGES = tuple(range(-50, 101, 5))


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
    """两组比例差的 z 值（条件组 vs 对照组）。样本不足时返回 0。"""
    if n1 <= 0 or n2 <= 0:
        return 0.0
    p1, p2 = wins1 / n1, wins2 / n2
    pooled = (wins1 + wins2) / (n1 + n2)
    variance = pooled * (1 - pooled) * (1 / n1 + 1 / n2)
    if variance <= 0:
        return 0.0
    return round((p1 - p2) / math.sqrt(variance), 2)


def _agg_select(alias: str = "") -> str:
    """六个周期的聚合列（一条 SQL 一次算完，别每个周期扫一遍表）。"""
    prefix = f"{alias}." if alias else ""
    parts: list[str] = ["COUNT(*) AS total"]
    for horizon in HORIZONS:
        col = f"{prefix}r{horizon}"
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
    }


def _group_row(conn: sqlite3.Connection, where: str, params: tuple = ()) -> sqlite3.Row:
    sql = f"SELECT {_agg_select()} FROM signals WHERE {where}"
    return conn.execute(sql, params).fetchone()


def summary(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """条件组 / 对照组，六个周期一排（报告主体 + 结论卡的来源）。"""
    signal_row = _group_row(conn, "is_control = 0")
    control_row = _group_row(conn, "is_control = 1")
    rows: list[dict[str, Any]] = []
    for horizon in HORIZONS:
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


def verdict(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """结论：挑超额胜率最高的那个周期，并明确说「能不能用」。

    四种结论（前端各有一句人话）：
    - ``usable``            超额 ≥ 2pp 且统计显著 → 这个条件有用
    - ``worse``             **显著跑输**随机买入（z ≤ −1.96）→ 反着用都不行，得重新设计
    - ``not_significant``   看着有超额但样本不够（z 不显著）
    - ``no_edge``           超额小且不显著 → 与随机买入没区别
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
    best = max(candidates, key=lambda row: row["excess_pp"])
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
    return result


def by_stock(conn: sqlite3.Connection, control_rows: dict[int, float]) -> list[dict[str, Any]]:
    """按股票的准确率排行。``control_rows`` = {周期: 对照组胜率} 用来算超额。"""
    sql = (
        f"SELECT code, MAX(name) AS name, MAX(board) AS board, {_agg_select()} "
        "FROM signals WHERE is_control = 0 GROUP BY code"
    )
    items: list[dict[str, Any]] = []
    for row in conn.execute(sql):
        n = int(row["c10"] or row["total"] or 0)
        win: dict[str, float | None] = {}
        avg: dict[str, float | None] = {}
        excess: dict[str, float | None] = {}
        for horizon in HORIZONS:
            counted = int(row[f"c{horizon}"] or 0)
            wins = int(row[f"w{horizon}"] or 0)
            rate = round(wins / counted * 100, 2) if counted else None
            value = row[f"a{horizon}"]
            win[str(horizon)] = rate
            avg[str(horizon)] = round(float(value) * 100, 2) if value is not None else None
            base = control_rows.get(horizon)
            excess[str(horizon)] = round(rate - base, 2) if rate is not None and base is not None else None
        items.append({
            "code": str(row["code"]),
            "name": str(row["name"] or ""),
            "board": str(row["board"] or "other"),
            "n": int(row["total"] or 0),
            "win": win,
            "avg": avg,
            "excess": excess,
            "sufficient": n >= MIN_STOCK_SAMPLES,
        })
    items.sort(key=lambda item: (-(item["win"].get("10") or -1), -item["n"]))
    return items


def _breakdown(conn: sqlite3.Connection, key_sql: str, extra_where: str = "") -> list[dict[str, Any]]:
    sql = (
        f"SELECT {key_sql} AS key, is_control, {_agg_select()} FROM signals "
        f"WHERE 1 = 1{extra_where} GROUP BY key, is_control ORDER BY key"
    )
    buckets: dict[str, dict[str, Any]] = {}
    for row in conn.execute(sql):
        key = str(row["key"])
        slot = buckets.setdefault(key, {"key": key, "signal": None, "control": None})
        slot["control" if int(row["is_control"]) else "signal"] = {
            str(horizon): _metrics_of(row, horizon) for horizon in HORIZONS
        }
    items: list[dict[str, Any]] = []
    for key, slot in sorted(buckets.items()):
        row: dict[str, Any] = {"key": key, "signal": slot["signal"], "control": slot["control"]}
        excess: dict[str, float | None] = {}
        for horizon in HORIZONS:
            sig = (slot["signal"] or {}).get(str(horizon)) or {}
            ctl = (slot["control"] or {}).get(str(horizon)) or {}
            if sig.get("win_rate") is None or ctl.get("win_rate") is None:
                excess[str(horizon)] = None
            else:
                excess[str(horizon)] = round(sig["win_rate"] - ctl["win_rate"], 2)
        row["excess"] = excess
        items.append(row)
    return items


def by_board(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return _breakdown(conn, "board", " AND board <> 'other'")


def by_year(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    return _breakdown(conn, "SUBSTR(d0, 1, 4)")


def histograms(conn: sqlite3.Connection, max_points: int = 4) -> dict[str, Any]:
    """第 5/10/20/30 天涨幅分布（条件组）。看右尾够不够长、有没有明显左偏。"""
    horizons = list(HORIZONS[:max_points])
    buckets = {str(h): [0] * (len(HIST_EDGES) - 1) for h in horizons}
    below = {str(h): 0 for h in horizons}
    above = {str(h): 0 for h in horizons}
    columns = ", ".join(f"r{horizon}" for horizon in horizons)
    for row in conn.execute(f"SELECT {columns} FROM signals WHERE is_control = 0"):
        for index, horizon in enumerate(horizons, start=1):
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
            for horizon in horizons
        ],
    }


def density(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    """每日命中数（看条件是不是近年变稀疏 —— 稀疏通常意味着参数被市场消化了）。"""
    sql = (
        "SELECT d0, SUM(CASE WHEN is_control = 0 THEN 1 ELSE 0 END) AS hits, "
        "SUM(CASE WHEN is_control = 1 THEN 1 ELSE 0 END) AS control "
        "FROM signals GROUP BY d0 ORDER BY d0"
    )
    return [
        {"d0": str(row["d0"]), "hits": int(row["hits"] or 0), "control": int(row["control"] or 0)}
        for row in conn.execute(sql)
    ]


def control_win_rates(rows: list[dict[str, Any]]) -> dict[int, float]:
    """{周期: 对照组胜率} —— 按股票算超额时用同一把尺子。"""
    result: dict[int, float] = {}
    for row in rows:
        rate: Optional[float] = row["control"]["win_rate"]
        if rate is not None:
            result[int(row["horizon"])] = float(rate)
    return result


def build_report(conn: sqlite3.Connection) -> dict[str, Any]:
    """报告主体（弹窗与独立报告页共用这一个响应）。"""
    rows = summary(conn)
    return {
        "summary": rows,
        "verdict": verdict(rows),
        "by_board": by_board(conn),
        "by_year": by_year(conn),
        "histograms": histograms(conn),
        "density": density(conn),
        "horizons": list(HORIZONS),
    }
