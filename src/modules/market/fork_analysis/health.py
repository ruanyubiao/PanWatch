"""数据体检：先证明「数据没坏」，再谈条件好不好。

为什么单列一层
--------------
一个条件算出来 55% 胜率，可能有两种原因：真的有效，或者库里某几天行情是错的
（漏复权、停牌没填、同步中断、退市当 0%）。原来的 ``stats.quality`` 只查了
「某天行情是不是同步不全」，这里补齐四项最会污染结论的检查：

1. **异常涨跌幅**：单日 |涨幅| > 21.5%（主板 10%、创业/科创 20% 的容错上限），
   除了上市首日 —— 这类行通常是漏复权（除权日被当成暴跌）或数据错位。
2. **停牌后跳空**：连续停牌 ≥ 5 个交易日后复牌，第一天就 > 21.5%，同样指向
   漏复权。这类行如果不剔除，会把「除权」记成「暴跌」，系统性压低胜率。
3. **有价无量**：成交额 ≤ 0 但有涨幅 —— 停牌日被当成交易日的典型症状。
4. **日历缺口**：相邻两个信号日之间超过 12 个自然日（长假最多 10 天），说明
   中间有交易日没跑（同步断了 / 任务区间被切），按日聚合会被这些缺口带偏。

输出一个 0–100 的健康分和逐项计数，结论卡上超过 1% 会显式提示「结论可能被
数据污染」。
"""

from __future__ import annotations

import datetime as _dt
import sqlite3
from typing import Any, Optional

#: 单日涨幅超过这个数就算可疑（创业/科创 20% 涨跌停 + 容错）
EXTREME_RETURN = 0.215
#: 停牌后复牌第一天的跳空阈值（与上面同一个数，单独命名便于解释）
RESUME_JUMP = 0.215
#: 停牌 ≥ 这个天数后复牌才算「停牌后跳空」
RESUME_STALE_DAYS = 5
#: 相邻信号日的自然日间隔上限（覆盖春节/国庆长假）
MAX_CALENDAR_GAP = 12


def _rate(count: int, total: int) -> float:
    return round(count / total * 100, 3) if total else 0.0


def snapshot(conn: sqlite3.Connection, cal: str = "r",
             quality: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """四项数据检查 + 健康分。``cal`` 只影响口径说明，不参与检查。"""
    prefix = {"exec": "x", "close": "r"}.get(cal, cal)
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(signals)")}
    has_stale = "stale_days" in columns
    has_adj = "adj_missing" in columns

    base = "SELECT COUNT(*) AS n FROM signals WHERE is_control = 0"
    total = int(conn.execute(base).fetchone()["n"] or 0)

    extreme = conn.execute(
        "SELECT COUNT(*) AS n FROM signals WHERE is_control = 0 AND r1 IS NOT NULL "
        "AND ABS(r1) > ? AND COALESCE(listed_days, 999) > 1",
        (EXTREME_RETURN,),
    ).fetchone()
    extreme_n = int(extreme["n"] or 0) if extreme else 0

    resume_n = 0
    if has_stale:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM signals WHERE is_control = 0 AND r1 IS NOT NULL "
            "AND COALESCE(stale_days, 0) >= ? AND ABS(r1) > ? AND COALESCE(listed_days, 999) > 1",
            (RESUME_STALE_DAYS, RESUME_JUMP),
        ).fetchone()
        resume_n = int(row["n"] or 0) if row else 0

    zero_amount = conn.execute(
        "SELECT COUNT(*) AS n FROM signals WHERE is_control = 0 AND amount IS NOT NULL AND amount <= 0"
    ).fetchone()
    zero_amount_n = int(zero_amount["n"] or 0) if zero_amount else 0

    adj_n = 0
    if has_adj:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM signals WHERE is_control = 0 AND COALESCE(adj_missing, 0) > 0"
        ).fetchone()
        adj_n = int(row["n"] or 0) if row else 0

    days = [str(row["d0"]) for row in conn.execute("SELECT d0 FROM days ORDER BY d0")]
    gaps: list[dict[str, Any]] = []
    for previous, current in zip(days, days[1:]):
        try:
            left = _dt.date.fromisoformat(previous)
            right = _dt.date.fromisoformat(current)
        except ValueError:
            continue
        span = (right - left).days
        if span > MAX_CALENDAR_GAP:
            gaps.append({"from": previous, "to": current, "days": span})

    samples = [
        {
            "d0": str(row["d0"]),
            "code": str(row["code"]),
            "r1": round(float(row["r1"]) * 100, 2),
            "stale_days": int(row["stale_days"] or 0) if has_stale else 0,
            "adj_missing": int(row["adj_missing"] or 0) if has_adj else 0,
        }
        for row in conn.execute(
            "SELECT d0, code, r1, "
            + ("stale_days, " if has_stale else "0 AS stale_days, ")
            + ("adj_missing" if has_adj else "0 AS adj_missing")
            + " FROM signals WHERE is_control = 0 AND r1 IS NOT NULL AND ABS(r1) > ? "
              "AND COALESCE(listed_days, 999) > 1 ORDER BY ABS(r1) DESC LIMIT 10",
            (EXTREME_RETURN,),
        )
    ]

    suspect_days = int((quality or {}).get("suspect_days_count") or 0)
    unverifiable = int((quality or {}).get("unverifiable") or 0)
    unfillable = int((quality or {}).get("unfillable") or 0)

    # 健康分：只扣「会让结论失真」的项，不扣「本来就是事实」的项
    score = 100.0
    extreme_rate = _rate(extreme_n, total)
    if extreme_rate > 1.0:
        score -= 30
    elif extreme_rate > 0.5:
        score -= 18
    elif extreme_rate > 0.1:
        score -= 8
    if adj_n:
        score -= min(15, 5 + int(adj_n / max(total, 1) * 1000))
    if zero_amount_n:
        score -= 5
    if suspect_days:
        score -= min(20, suspect_days * 2)
    if len(gaps) > 3:
        score -= min(15, (len(gaps) - 3) * 2)
    score = max(0.0, round(score, 1))
    level = "good" if score >= 85 else ("warn" if score >= 60 else "bad")
    polluted = bool(extreme_rate > 1.0 or (total and adj_n / total > 0.01))

    return {
        "score": score,
        "level": level,
        "polluted": polluted,
        "total_rows": total,
        "extreme_rows": extreme_n,
        "extreme_rate": extreme_rate,
        "resume_jump_rows": resume_n,
        "zero_amount_rows": zero_amount_n,
        "adj_missing_rows": adj_n,
        "unverifiable": unverifiable,
        "unfillable": unfillable,
        "suspect_days": suspect_days,
        "gaps": gaps[:10],
        "gap_count": len(gaps),
        "samples": samples,
        "thresholds": {
            "extreme_return": EXTREME_RETURN,
            "resume_stale_days": RESUME_STALE_DAYS,
            "max_calendar_gap": MAX_CALENDAR_GAP,
        },
    }
