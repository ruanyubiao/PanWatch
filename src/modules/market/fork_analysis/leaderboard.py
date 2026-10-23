"""跨条件排行榜：把多个候选条件放在**同一把尺子**下比。

为什么需要
----------
用户最终的动作是「这个条件不行，换一个再试」。如果每个条件用不同区间、不同
成本、不同周期自己跟自己比，横向对比没有意义；而「20 个里挑最好的那个」本身
又会带来选择偏差 —— 全都没有优势时，最好看的那个也会显得有 2pp 超额。

所以这里做两件事：
1. 统一口径（同一成本、同一按日聚合方法、同一主周期）输出对比表；
2. 给出**选择偏差的期望值**：N 个候选在「全无优势」假设下，最大值的期望大约是
   ``sd × sqrt(2 ln N)``。比这个还小的「第一名」不能当真。
"""

from __future__ import annotations

import math
import os
from typing import Any, Optional

from . import significance, stats, store

#: 排行榜最多纳入多少个任务
MAX_RUNS = 60

#: run_id → (mtime, 摘要行)，避免每次请求都重扫几十万个信号
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def _primary(horizons: list[int]) -> int:
    if 10 in horizons:
        return 10
    if 5 in horizons:
        return 5
    return horizons[-1] if horizons else 30


def _summarise(preset_name: str, meta: dict[str, Any]) -> Optional[dict[str, Any]]:
    run_id = str(meta.get("run_id") or "")
    try:
        path = store.db_path(preset_name, run_id)
    except Exception:  # noqa: BLE001
        return None
    if not path.is_file():
        return None
    mtime = os.path.getmtime(path)
    cached = _CACHE.get(run_id)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        conn = store.open_db_readonly(preset_name, run_id)
    except Exception:  # noqa: BLE001
        return None
    try:
        counts = store.counts(conn)
        if counts["hits"] <= 0:
            return None
        prefix, caliber = significance.caliber_columns(conn)
        horizons = [int(h) for h in (meta.get("horizons") or [])] or [30]
        primary = _primary(horizons)
        row = significance.horizon_test(conn, primary, prefix, 0.0)
        weighted = significance.weighted_test(conn, primary, prefix, 0.0)
        quality = conn.execute(
            "SELECT COUNT(*) AS n, "
            "SUM(CASE WHEN COALESCE(verif, 1) = 0 THEN 1 ELSE 0 END) AS bad "
            "FROM signals WHERE is_control = 0"
        ).fetchone()
        total = int(quality["n"] or 0)
        bad = int(quality["bad"] or 0)
    finally:
        conn.close()
    summary = {
        "run_id": run_id,
        "preset": preset_name,
        "start_date": meta.get("start_date"),
        "end_date": meta.get("end_date"),
        "days": counts["days"],
        "hits": counts["hits"],
        "horizon": primary,
        "caliber": caliber,
        "win_rate": None,
        "excess_pp": row.get("mean_excess_pp"),
        "ci_low_pp": row.get("ci_low_pp"),
        "ci_high_pp": row.get("ci_high_pp"),
        "weighted_excess_pp": weighted.get("mean_excess_pp"),
        "nw_t": row.get("nw_t"),
        "n_eff": row.get("n_eff"),
        "significant_up": bool(row.get("significant_up")),
        "significant_down": bool(row.get("significant_down")),
        "unverifiable_rate": round(bad / total * 100, 2) if total else None,
        "status": meta.get("status"),
        "created_at": meta.get("created_at"),
        "sd_pp": round((row.get("ci_high_pp") or 0) - (row.get("mean_excess_pp") or 0), 3)
        if row.get("ci_high_pp") is not None else None,
    }
    _CACHE[run_id] = (mtime, summary)
    return summary


def board(limit: int = MAX_RUNS) -> dict[str, Any]:
    """全部已完成任务的统一口径对比，按超额从高到低排。"""
    items: list[dict[str, Any]] = []
    for meta in store.list_runs(None)[:limit]:
        preset_name = str(meta.get("preset") or "")
        if not preset_name:
            continue
        if str(meta.get("status")) not in (store.STATUS_DONE, store.STATUS_STOPPED):
            continue
        summary = _summarise(preset_name, meta)
        if summary is not None:
            items.append(summary)
    items.sort(key=lambda item: -(item.get("excess_pp") or -999))
    for index, item in enumerate(items, start=1):
        item["rank"] = index
    count = len(items)
    calibers = sorted({item["caliber"] for item in items})
    # 口径混着比会骗人：收盘价买入（老任务）没有成本、也没有「买不进」，
    # 它的超额天然比可执行口径好看。混着的时候不给「选择偏差」基准线。
    sd = (next((abs(float(item["sd_pp"])) for item in items if item.get("sd_pp")), None)
          if len(calibers) <= 1 else None)
    # sd_pp 存的是「均值到上界」的半宽 ≈ 1.96·SE，恢复成日度超额的标准差
    sd_abs = (sd / 1.96) if sd else None
    expected_max = round(sd_abs * math.sqrt(2 * math.log(count)), 3) if sd_abs and count > 2 else None
    return {
        "items": items,
        "count": count,
        "expected_max_pp": expected_max,
        "note": ("mixed_calibers" if len(calibers) > 1
                 else ("expected_max" if count > 1 else None)),
        "calibers": calibers,
        "mixed": len(calibers) > 1,
    }
