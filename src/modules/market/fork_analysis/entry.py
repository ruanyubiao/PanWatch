"""入场假设敏感性：结论是不是只靠「买在次日开盘」这个乐观假设撑起来的。

四种入场
--------
==============  ==============================================  ==========
口径            含义                                            可执行
==============  ==============================================  ==========
``signal_close`` 信号日收盘买入                                   否（上界参考）
``next_open``    次日开盘买入（主口径）                            是
``next_close``   次日收盘买入（错过开盘的人）                      是
``next_vwap``    次日典型价 (开+高+收)/3 买入（更接近真实成交）      是
==============  ==============================================  ==========

如果超额只在前两种里成立、在 ``next_vwap`` 就消失，那么所谓优势其实是「开盘
瞬间的价差」——散户拿不到。这是判断「能不能真用」的一条硬指标。
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from . import significance

#: 依次比较的入场假设
BASES: tuple[tuple[str, str, bool], ...] = (
    ("signal_close", "信号日收盘（不可执行，仅作上界参考）", False),
    ("next_open", "次日开盘（主口径）", True),
    ("next_close", "次日收盘", True),
    ("next_vwap", "次日典型价 (开+高+收)/3", True),
)


def _available(conn: sqlite3.Connection) -> set[str]:
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(signals)")}
    found = {"signal_close"} if "r1" in columns else set()
    if "x1" in columns and int(conn.execute(
        "SELECT COUNT(x1) AS n FROM signals WHERE x1 IS NOT NULL LIMIT 1"
    ).fetchone()["n"] or 0) > 0:
        found.add("next_open")
    if "v1" in columns and int(conn.execute(
        "SELECT COUNT(v1) AS n FROM signals WHERE v1 IS NOT NULL LIMIT 1"
    ).fetchone()["n"] or 0) > 0:
        found.add("next_vwap")
    if "r1" in columns:
        found.add("next_close")
    return found


def _expression(base: str, horizon: int, cost: float) -> Optional[str]:
    """每个入场假设在 SQL 里的「第 N 天涨幅」表达式（已扣成本）。"""
    if base == "signal_close":
        return f"r{horizon}"
    if base == "next_open":
        return f"(x{horizon} - {cost})" if cost else f"x{horizon}"
    if base == "next_close":
        if horizon < 2:
            return None
        # 次日收盘买入：分子是第 N 天收盘，分母是第 1 天收盘
        return (f"(((1.0 + r{horizon}) / (1.0 + r1) - 1.0) - {cost})"
                if cost else f"((1.0 + r{horizon}) / (1.0 + r1) - 1.0)")
    if base == "next_vwap":
        return f"(v{horizon} - {cost})" if cost else f"v{horizon}"
    return None


def _guard(base: str, horizon: int) -> str:
    if base == "signal_close":
        return f"r{horizon} IS NOT NULL AND COALESCE(verif, 1) = 1"
    if base == "next_open":
        return (f"x{horizon} IS NOT NULL AND COALESCE(verif, 1) = 1 "
                "AND COALESCE(unfillable, 0) = 0")
    if base == "next_close":
        return (f"r{horizon} IS NOT NULL AND r1 IS NOT NULL AND r1 > -1 "
                "AND COALESCE(verif, 1) = 1")
    return (f"v{horizon} IS NOT NULL AND COALESCE(verif, 1) = 1 "
            "AND COALESCE(unfillable, 0) = 0")


def sensitivity(conn: sqlite3.Connection, horizon: int, cost: float = 0.0) -> list[dict[str, Any]]:
    """同一批信号、同一个周期，只换入场假设，看超额怎么变。"""
    available = _available(conn)
    rows: list[dict[str, Any]] = []
    for base, label, executable in BASES:
        if base not in available:
            rows.append({"base": base, "label": label, "executable": executable,
                         "available": False, "excess_pp": None})
            continue
        expression = _expression(base, horizon, cost)
        if expression is None:
            rows.append({"base": base, "label": label, "executable": executable,
                         "available": False, "excess_pp": None})
            continue
        guard = _guard(base, horizon)
        table: dict[int, dict[str, tuple[int, int]]] = {0: {}, 1: {}}
        for control in (0, 1):
            sql = (
                f"SELECT d0, COUNT(*) AS n, SUM(CASE WHEN ({expression}) > 0 THEN 1 ELSE 0 END) AS w "
                f"FROM signals WHERE is_control = {control} AND {guard} GROUP BY d0"
            )
            table[control] = {
                str(row["d0"]): (int(row["n"] or 0), int(row["w"] or 0))
                for row in conn.execute(sql)
            }
        diffs: list[float] = []
        signal_rates: list[tuple[int, int]] = []
        for day in sorted(set(table[0]) & set(table[1])):
            s_n, s_w = table[0][day]
            c_n, c_w = table[1][day]
            if s_n <= 0 or c_n <= 0:
                continue
            diffs.append(s_w / s_n - c_w / c_n)
            signal_rates.append((s_n, s_w))
        summary = significance.summarize_series(diffs, block=max(2, horizon))
        total_n = sum(n for n, _w in signal_rates)
        total_w = sum(w for _n, w in signal_rates)
        rows.append({
            "base": base,
            "label": label,
            "executable": executable,
            "available": True,
            "n": total_n,
            "win_rate": round(total_w / total_n * 100, 2) if total_n else None,
            "excess_pp": round(summary["mean"] * 100, 3) if summary["mean"] is not None else None,
            "ci_low_pp": round(summary["ci_low"] * 100, 3) if summary["ci_low"] is not None else None,
            "ci_high_pp": round(summary["ci_high"] * 100, 3) if summary["ci_high"] is not None else None,
            "days": summary["days"],
        })
    return rows
