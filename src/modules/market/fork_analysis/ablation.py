"""消融 / 参数扰动：把「这个条件」拆成「到底哪一条在起作用」。

为什么这是「重新设计条件」最直接的依据
--------------------------------------
胜率低只能说明整体不行，不能说明该删哪一条。逐条拿掉子条件、把数值参数上下
扰动一格，看超额怎么变，才能回答：

- 哪条子条件是**正贡献**（拿掉之后超额下降）；
- 哪条是**拖累**（拿掉之后超额上升）——这就是该删的那条；
- 参数是不是处在**平台**上（±1 都差不多）还是**尖峰**（±1 就崩，典型的过拟合）。

实现取舍
--------
- 只在**抽样交易日**上跑（默认 40 天，等距取），每个变体都是同样那些天，
  所以变体之间是配对比较，噪声大部分被抵消；
- 选股仍然调 ``run_screen``（逐字同一条 SQL），前瞻涨幅用同一套 ``build_forward``；
- 结果写 ``ablation.json``，跑在后台线程，界面轮询进度。
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import threading
from pathlib import Path
from typing import Any, Optional

from ..api import fork_market
from ..fork_screen import presets
from ..fork_screen.models import ScreenRequest
from ..fork_screen.service import run_screen
from . import forward, significance, store
from .forward import EXEC_COST

logger = logging.getLogger(__name__)

#: 最多跑多少个变体（每个变体 × 每个抽样日 = 一次完整选股）
MAX_VARIANTS = 14
#: 默认抽样交易日数
DEFAULT_SAMPLE_DAYS = 40
#: 同时只跑一个消融任务
_LOCK = threading.Lock()
_RUNNING: dict[str, threading.Thread] = {}

#: 不适合扰动的参数（枚举 / 方向 / 指标名）
_SKIP_PARAMS = {
    "direction", "mode", "metric", "indicator", "operator", "side", "type",
    "compare", "target", "field", "column", "unit",
}


def _label(node: dict[str, Any]) -> str:
    name = str(node.get("name") or "")
    params = node.get("params") or {}
    if not params:
        return name
    parts = []
    for key, value in params.items():
        if isinstance(value, float):
            parts.append(f"{key}={value:g}")
        else:
            parts.append(f"{key}={value}")
    return f"{name}({', '.join(parts)})"


def _walk(node: dict[str, Any], path: tuple[int, ...] = ()) -> list[tuple[tuple[int, ...], dict[str, Any]]]:
    found: list[tuple[tuple[int, ...], dict[str, Any]]] = []
    if node.get("type") == "condition":
        found.append((path, node))
        return found
    for index, child in enumerate(node.get("children") or []):
        found.extend(_walk(child, path + (index,)))
    return found


def _set_child(rule: dict[str, Any], path: tuple[int, ...], replacement: Optional[dict[str, Any]]) -> dict[str, Any]:
    """按路径替换/删除子节点，返回新的 rule（不改原对象）。"""
    import copy

    cloned = copy.deepcopy(rule)
    if not path:
        return replacement or cloned
    parent = cloned
    for index in path[:-1]:
        parent = parent["children"][index]
    position = path[-1]
    if replacement is None:
        parent["children"].pop(position)
    else:
        parent["children"][position] = replacement
    return cloned


def build_variants(request: ScreenRequest) -> list[dict[str, Any]]:
    """原条件 + 逐条删除 + 数值参数 ±1。"""
    base = request.model_dump(mode="json")
    rule = base.get("rule") or {}
    variants: list[dict[str, Any]] = [{"key": "base", "label": "原条件", "rule": rule, "kind": "base"}]

    # 1) 逐条删除（只在 AND 组里删；OR 组删一条会扩大条件，没有可比性）
    def collect_drops(node: dict[str, Any], path: tuple[int, ...] = ()) -> None:
        if node.get("type") != "group":
            return
        children = node.get("children") or []
        if node.get("operator") == "AND" and len(children) > 1:
            for index, child in enumerate(children):
                if len(variants) >= MAX_VARIANTS:
                    return
                new_rule = _set_child(rule, path + (index,), None)
                variants.append({
                    "key": f"drop:{'.'.join(map(str, path + (index,)))}",
                    "label": f"去掉 {_label(child) if child.get('type') == 'condition' else '一组'}",
                    "rule": new_rule,
                    "kind": "drop",
                    "target": _label(child) if child.get("type") == "condition" else "",
                })
        for index, child in enumerate(children):
            collect_drops(child, path + (index,))

    collect_drops(rule)

    # 2) 数值参数 ±1（整数才能安全扰动；枚举类参数跳过）
    for path, node in _walk(rule):
        params = node.get("params") or {}
        for key, value in list(params.items()):
            if key in _SKIP_PARAMS or isinstance(value, bool) or not isinstance(value, int):
                continue
            for step in (1, -1):
                if len(variants) >= MAX_VARIANTS:
                    break
                changed = {**node, "params": {**params, key: value + step}}
                if changed["params"][key] < 1:
                    continue
                new_rule = _set_child(rule, path, changed)
                variants.append({
                    "key": f"param:{'.'.join(map(str, path))}:{key}:{step:+d}",
                    "label": f"{key} {value}→{value + step}",
                    "rule": new_rule,
                    "kind": "param",
                    "target": key,
                })
    return variants[:MAX_VARIANTS]


def _ablation_path(preset_name: str, run_id: str) -> Path:
    return store.run_dir(preset_name, run_id) / "ablation.json"


def _write(preset_name: str, run_id: str, payload: dict[str, Any]) -> None:
    path = _ablation_path(preset_name, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def status(preset_name: str, run_id: str) -> Optional[dict[str, Any]]:
    path = _ablation_path(preset_name, run_id)
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    thread = _RUNNING.get(run_id)
    if payload.get("status") == "running" and not (thread and thread.is_alive()):
        payload["status"] = "interrupted"
    return payload


def is_running(run_id: str) -> bool:
    thread = _RUNNING.get(run_id)
    return bool(thread and thread.is_alive())


def _sampled_days(conn, count: int) -> list[str]:
    days = [str(row["d0"]) for row in conn.execute("SELECT d0 FROM days ORDER BY d0")]
    if len(days) <= count:
        return days
    step = len(days) / count
    picked = [days[int(index * step)] for index in range(count)]
    return sorted(set(picked))


def _control_rates(conn, horizon: int, prefix: str, cost: float) -> dict[str, float]:
    col = f"({prefix}{horizon} - {cost})"
    valid = "(verif IS NULL OR verif = 1)"
    if prefix == "x":
        valid += " AND (unfillable IS NULL OR unfillable = 0)"
    sql = (
        f"SELECT d0, AVG(CASE WHEN {col} > 0 THEN 1.0 ELSE 0.0 END) AS rate "
        f"FROM signals WHERE is_control = 1 AND {prefix}{horizon} IS NOT NULL AND {valid} GROUP BY d0"
    )
    return {str(row["d0"]): float(row["rate"]) for row in conn.execute(sql)}


def start(preset_name: str, run_id: str, sample_days: int = DEFAULT_SAMPLE_DAYS,
          horizon: Optional[int] = None) -> dict[str, Any]:
    """起后台线程；已在跑就直接返回当前状态。"""
    existing = status(preset_name, run_id)
    if is_running(run_id):
        return existing or {"status": "running"}
    with _LOCK:
        if is_running(run_id):
            return status(preset_name, run_id) or {"status": "running"}
        payload = {
            "status": "running",
            "started_at": store._now(),
            "finished_at": None,
            "error": None,
            "config": {"sample_days": int(sample_days), "horizon": horizon},
            "progress": {"done": 0, "total": 0, "current": None},
            "variants": [],
        }
        _write(preset_name, run_id, payload)
        thread = threading.Thread(
            target=_run, args=(preset_name, run_id, sample_days, horizon),
            name=f"ablation-{run_id}", daemon=True,
        )
        _RUNNING[run_id] = thread
        thread.start()
    return payload


def _run(preset_name: str, run_id: str, sample_days: int, horizon: Optional[int]) -> None:
    started = _dt.datetime.now()
    try:
        record = presets.load(preset_name)
        meta = store.load_meta(preset_name, run_id)
        request = ScreenRequest.model_validate(record.get("request") or {})
        base_db = store.open_db_readonly(preset_name, run_id)
        try:
            prefix, caliber = significance.caliber_columns(base_db)
            days = _sampled_days(base_db, sample_days)
            horizons = [int(h) for h in (meta.get("horizons") or [])]
            target_horizon = int(horizon or (10 if 10 in horizons else (horizons[-1] if horizons else 30)))
            control = _control_rates(base_db, target_horizon, prefix, EXEC_COST)
            base_daily = {}
            col = f"{prefix}{target_horizon}"
            for row in base_db.execute(
                f"SELECT d0, AVG(CASE WHEN {col} > 0 THEN 1.0 ELSE 0.0 END) AS rate, COUNT(*) AS n "
                f"FROM signals WHERE is_control = 0 AND {col} IS NOT NULL "
                "AND (verif IS NULL OR verif = 1) "
                + ("AND (unfillable IS NULL OR unfillable = 0) " if prefix == "x" else "")
                + "GROUP BY d0"
            ):
                base_daily[str(row["d0"])] = (float(row["rate"]), int(row["n"]))
        finally:
            base_db.close()

        variants = build_variants(request)
        sampled = [day for day in days if day in control]
        payload = {
            "status": "running",
            "started_at": started.isoformat(timespec="seconds"),
            "finished_at": None,
            "error": None,
            "config": {
                "sample_days": len(sampled),
                "horizon": target_horizon,
                "caliber": caliber,
                "cost": 0.0,
            },
            "progress": {"done": 0, "total": len(variants), "current": None},
            "variants": [],
        }
        _write(preset_name, run_id, payload)

        market = fork_market._connect()
        results: list[dict[str, Any]] = []
        try:
            calendar = forward.trading_calendar(
                market, _dt.date.fromisoformat(sampled[0]) if sampled else _dt.date.today(), None
            )
            index = {day: position for position, day in enumerate(calendar)}
            for position, variant in enumerate(variants):
                payload["progress"] = {"done": position, "total": len(variants), "current": variant["label"]}
                _write(preset_name, run_id, payload)
                trial = ScreenRequest.model_validate({**request.model_dump(mode="json"), "rule": variant["rule"]})
                rates: dict[str, float] = {}
                counts: dict[str, int] = {}
                for day_text in sampled:
                    d0 = _dt.date.fromisoformat(day_text)
                    forward_days = calendar[index[d0] + 1: index[d0] + 31] if d0 in index else []
                    try:
                        response = run_screen(trial, asof=d0)
                    except Exception as exc:  # noqa: BLE001 - 单个变体失败不该毁掉整轮
                        logger.warning("消融变体 %s 在 %s 选股失败：%s", variant["key"], day_text, exc)
                        continue
                    items = list(response.get("items") or [])
                    if not items:
                        # 这一天没有命中 = 没有观测，不要写成「0% 胜率」——
                        # 那会把「条件更严」的变体直接判死。
                        continue
                    symbols = [str(item.get("s") or item.get("symbol") or "") for item in items]
                    bars, _missing = forward.fetch_bars(market, d0, symbols, forward_days[-1] if forward_days else d0)
                    wins = 0
                    counted = 0
                    for item in items:
                        symbol = str(item.get("s") or item.get("symbol") or "")
                        series = bars.get(symbol) or []
                        if not series or series[0][0] != d0:
                            continue
                        result = forward.build_forward(series, forward_days, forward.limit_pct(str(item.get("code") or ""), d0))
                        if result is None or result.verif == 0:
                            continue
                        value = result.exec_returns[target_horizon - 1] if target_horizon - 1 < len(result.exec_returns) else None
                        if value is None:
                            continue
                        counted += 1
                        wins += 1 if (value - EXEC_COST) > 0 else 0
                    rates[day_text] = wins / counted if counted else 0.0
                    counts[day_text] = counted

                paired = [rates[day] - control[day] for day in sampled if day in rates]
                paired_base = [
                    rates[day] - base_daily[day][0] for day in sampled
                    if day in rates and day in base_daily
                ]
                summary = significance.summarize_series(paired, block=target_horizon)
                delta = significance.summarize_series(paired_base, block=target_horizon) if paired_base else None
                win_rate = sum(rates.values()) / len(rates) if rates else None
                results.append({
                    "key": variant["key"],
                    "label": variant["label"],
                    "kind": variant["kind"],
                    "n": sum(counts.values()),
                    "days": len(rates),
                    "win_rate": round(win_rate * 100, 2) if win_rate is not None else None,
                    "excess_pp": round(summary["mean"] * 100, 3) if summary["mean"] is not None else None,
                    "ci_low_pp": round(summary["ci_low"] * 100, 3) if summary["ci_low"] is not None else None,
                    "ci_high_pp": round(summary["ci_high"] * 100, 3) if summary["ci_high"] is not None else None,
                    "delta_pp": round(delta["mean"] * 100, 3) if delta and delta["mean"] is not None else None,
                    "delta_ci_low_pp": round(delta["ci_low"] * 100, 3) if delta and delta["ci_low"] is not None else None,
                    "delta_ci_high_pp": round(delta["ci_high"] * 100, 3) if delta and delta["ci_high"] is not None else None,
                })
                payload["variants"] = list(results)
                _write(preset_name, run_id, payload)
        finally:
            market.close()

        # 结论：按 delta（相对原条件）排序，正的是「拿掉它更好」
        baseline = next((item for item in results if item["kind"] == "base"), None)
        for item in results:
            if item["kind"] == "base":
                item["advice"] = "baseline"
            elif item["delta_pp"] is None:
                item["advice"] = "unknown"
            elif item["delta_pp"] >= 1.0 and (item["delta_ci_low_pp"] or 0) > 0:
                item["advice"] = "drop"
            elif item["delta_pp"] <= -1.0 and (item["delta_ci_high_pp"] or 0) < 0:
                item["advice"] = "keep"
            else:
                item["advice"] = "neutral"
        payload.update({
            "status": "done",
            "finished_at": _dt.datetime.now().isoformat(timespec="seconds"),
            "progress": {"done": len(variants), "total": len(variants), "current": None},
            "variants": results,
            "baseline_win_rate": baseline["win_rate"] if baseline else None,
        })
        _write(preset_name, run_id, payload)
    except Exception as exc:  # noqa: BLE001
        logger.exception("消融分析失败：%s", exc)
        try:
            current = status(preset_name, run_id) or {}
            current.update({"status": "failed", "error": str(exc),
                            "finished_at": _dt.datetime.now().isoformat(timespec="seconds")})
            _write(preset_name, run_id, current)
        except Exception:  # noqa: BLE001
            pass
    finally:
        _RUNNING.pop(run_id, None)
