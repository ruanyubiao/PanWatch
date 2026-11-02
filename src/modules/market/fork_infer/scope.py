"""有效范围：这条条件算「通用」，还是只对某些「个股」有效？

用户 2026-11-03 的原文
----------------------
* 第 3 条：「只保存推理分 / 验证分至少一个 60 以上的，有效范围为通用。」
* 第 4 条：「有时候会对个股特别有效，推理分 / 验证分至少一个 80 以上，
  这时候有效范围为个股。」
* 第 5 条：「同时可以是通用，也可以是个股；详情里要能看到个股列表（id + 名字）。」

判定规则（写死在这里，报告里逐项列出）
--------------------------------------
* **通用**：两个整段评分里至少一个 ≥ 60（``scoring.PASS_SCORE``）。
* **个股**：存在一只股票，在推理段或测试段上的个股评分 ≥ 80。
* 两者都成立 → 有效范围「通用+个股」。

个股为什么单独一套门槛
----------------------
一只股票七年也就几十次信号，用整条条件的门槛（≥300 笔、≥30 个独立样本）会把
所有个股压到 55 分以下，「个股有效」这个结论根本不可能出现。所以个股档：
8 笔起评分、25 笔以下最高 88 分（见 ``scoring.STOCK_CAP_*``），并且用 Wilson
下界而不是正态近似 —— 8 次里赢 7 次用正态算出来的区间太窄，会虚高。

另一个必须说清的偏差：一条件 × 5000 只股票 = 5000 次比较，总会有几只「看起来
特别准」。所以个股分数只作为**线索**（去看这几只股票的信号明细），不能当成
「这个条件对 000001 有 92 分」这种确证。评分卡上标注了这一点。
"""

from __future__ import annotations

import math
from typing import Any, Optional

from ..fork_analysis import scoring

#: 有效范围的三个值
SCOPE_GENERAL = "general"
SCOPE_STOCK = "stock"

#: 个股进入名单的最低分（低于这个数不显示，免得一屏几千只）
STOCK_LIST_MIN = 60.0

#: 存进 finalists.json 的个股条数上限（前 N 名，够看就行，别把文件撑大）
STOCK_LIST_LIMIT = 30


def _wilson_lower(rate: float, n: int, z: float = 1.96) -> Optional[float]:
    """二项比例的 Wilson 置信下界（小数）。n=0 返回 None。"""
    if n <= 0:
        return None
    denom = 1.0 + z * z / n
    centre = rate + z * z / (2.0 * n)
    margin = z * math.sqrt(max(0.0, rate * (1.0 - rate) / n + z * z / (4.0 * n * n)))
    return max(0.0, (centre - margin) / denom)


def _stock_windows(entry: dict[str, Any], horizons: list[int]) -> list[dict[str, Any]]:
    """一只股票在各持有期上的窗口行（口径：扣成本、可执行、对同日基准）。"""
    rows: list[dict[str, Any]] = []
    wins = entry.get("win") or []
    counts = entry.get("n") or []
    bases = entry.get("base") or []
    for index, horizon in enumerate(horizons):
        n = int(counts[index]) if index < len(counts) else 0
        if n <= 0:
            continue
        win = int(wins[index]) if index < len(wins) else 0
        rate = win / n
        base_sum = float(bases[index]) if index < len(bases) else 0.0
        base = (base_sum / n) if base_sum > 0 else None
        lower_rate = _wilson_lower(rate, n)
        row: dict[str, Any] = {
            "window": horizon,
            "n": n,
            "p_net": round(rate * 100.0, 2),
            "base_p": None if base is None else round(base * 100.0, 2),
            "excess_pp": None if base is None else round((rate - base) * 100.0, 2),
            "n_eff": max(1, n // max(1, horizon)),
            "expectancy": None,
            "win_rate": round(rate * 100.0, 2),
        }
        if base is not None and lower_rate is not None:
            # 显式下界：score_segment 的 lower_bound() 会优先用它
            row["lower_pp"] = round((lower_rate - base) * 100.0, 2)
            spread = (rate - base) * 100.0
            row["t"] = round(spread / max(1e-6, spread - row["lower_pp"]) * 1.96, 2) \
                if spread - row["lower_pp"] > 1e-9 else None
        rows.append(row)
    return rows


def stock_rows(metrics: Any) -> list[dict[str, Any]]:
    """把一次 ``collect_stocks=True`` 的评估拆成逐股评分（高到低）。"""
    by_stock: dict[str, dict[str, Any]] = getattr(metrics, "by_stock", {}) or {}
    horizons = list(getattr(metrics, "horizons", []) or [])
    rows: list[dict[str, Any]] = []
    for symbol, entry in by_stock.items():
        windows = _stock_windows(entry, horizons)
        if not windows:
            continue
        events = max(int(item["n"]) for item in windows)
        if events < scoring.STOCK_MIN_EVENTS:
            continue
        grade = scoring.score_segment(
            windows=windows, events=events, days=int(entry.get("days") or events),
            year_excess=(), layer_excess=(), profile="stock",
        )
        if grade.get("score") is None:
            continue
        best = scoring.best_horizon_by_lower(windows) or windows[0]
        rows.append({
            "symbol": symbol,
            "code": entry.get("code") or symbol,
            "name": entry.get("name") or "",
            "score": grade["score"],
            "grade": grade["grade"],
            "window": best.get("window"),
            "signals": best.get("n"),
            "win_rate": best.get("win_rate"),
            "base_rate": best.get("base_p"),
            "excess_pp": best.get("excess_pp"),
            "lower_pp": best.get("lower_pp"),
        })
    rows.sort(key=lambda item: float(item["score"]), reverse=True)
    return rows


def merge(train_rows: list[dict[str, Any]], valid_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """按股票代码合并两段：一只股票一行，带推理分与测试分。"""
    merged: dict[str, dict[str, Any]] = {}
    for row in train_rows:
        key = str(row.get("code") or row.get("symbol"))
        merged[key] = {
            "code": key,
            "name": row.get("name") or "",
            "train_score": row.get("score"),
            "test_score": None,
            "train_signals": row.get("signals"),
            "test_signals": None,
            "window": row.get("window"),
            "train_win_rate": row.get("win_rate"),
            "test_win_rate": None,
            "train_excess_pp": row.get("excess_pp"),
            "test_excess_pp": None,
        }
    for row in valid_rows:
        key = str(row.get("code") or row.get("symbol"))
        item = merged.setdefault(key, {
            "code": key, "name": row.get("name") or "",
            "train_score": None, "test_score": None,
            "train_signals": None, "test_signals": None,
            "window": row.get("window"),
            "train_win_rate": None, "test_win_rate": None,
            "train_excess_pp": None, "test_excess_pp": None,
        })
        item["test_score"] = row.get("score")
        item["test_signals"] = row.get("signals")
        item["test_win_rate"] = row.get("win_rate")
        item["test_excess_pp"] = row.get("excess_pp")
        if not item.get("name"):
            item["name"] = row.get("name") or ""
    rows = list(merged.values())
    for item in rows:
        scores = [value for value in (item.get("train_score"), item.get("test_score"))
                  if value is not None]
        item["best_score"] = round(max(scores), 1) if scores else None
    rows.sort(key=lambda item: float(item.get("best_score") or -1), reverse=True)
    return rows


def judge(train_metrics: Any, valid_metrics: Any,
          train_grade: dict[str, Any], valid_grade: dict[str, Any]) -> dict[str, Any]:
    """综合两段评估，给出有效范围 + 个股名单。"""
    general_scores = [value for value in (train_grade.get("score"), valid_grade.get("score"))
                      if value is not None]
    general = bool(general_scores) and max(general_scores) >= scoring.PASS_SCORE

    merged = merge(stock_rows(train_metrics), stock_rows(valid_metrics))
    qualified = [item for item in merged
                 if (item.get("best_score") or 0) >= 80.0]
    listed = [item for item in merged
              if (item.get("best_score") or 0) >= STOCK_LIST_MIN][:STOCK_LIST_LIMIT]

    scopes: list[str] = []
    if general:
        scopes.append(SCOPE_GENERAL)
    if qualified:
        scopes.append(SCOPE_STOCK)
    label = {(): "—", (SCOPE_GENERAL,): "通用", (SCOPE_STOCK,): "个股",
             (SCOPE_GENERAL, SCOPE_STOCK): "通用+个股"}[tuple(scopes)]
    return {
        "scopes": scopes,
        "scope_label": label,
        "general_score": round(max(general_scores), 1) if general_scores else None,
        "stock_best_score": qualified[0]["best_score"] if qualified else None,
        "stock_qualified": len(qualified),
        "stock_list": listed,
        "stock_universe": len(merged),
    }
