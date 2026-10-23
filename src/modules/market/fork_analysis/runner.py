"""分析任务的主循环：逐日跑条件选股 → 取前瞻行情 → 落库 → 出产物。

为什么逐日调 ``run_screen``
--------------------------
这样「历史准确率」用的判定逻辑与界面上「今天选出来的股票」**逐字相同**（同一条
SQL、同一个求值器、同一份市场/ST 口径）。另写一套向量化判定会快，但两边一旦
有偏差，报告的结论就不成立 —— 这个功能的价值全在「可信」。

两条流水线（2026-10-23 起）
--------------------------
* ``stat_v1``：30 个交易日、收盘/次开两个口径，落 ``signals`` 表，出 Excel。
* ``stat_v2``：35 个交易日、最高/最低价，落 ``m2_events`` 表，出 8 个 CSV + report.md。

两条线共用选股、交易日历、对照组抽样与进度/续跑机制，只有取数与落库不同 ——
共用的是「怎么选」，不同的是「怎么算」。方法 1 的字段被几十万行历史任务依赖，
所以方法 2 单独建表而不是往 ``signals`` 里塞 70 个新列。

开销（云端实测）
---------------
方法 1：单个交易日 ≈ 选股 1.9 s + 前瞻取数 0.3 s。1650 个交易日约 1.5–2 小时。
方法 2：多取一列 ``low``、多 5 个交易日，约 2.5–3 s/天。
跑在后台线程，页面可以关。
"""

from __future__ import annotations

import datetime as _dt
import logging
import threading
import time
from pathlib import Path
from typing import Any, Optional, Sequence

from ..api import fork_market
from ..fork_screen import presets
from ..fork_screen.models import ScreenRequest
from ..fork_screen.service import run_screen
from . import forward, methods, stats, store
from .methods import method2, method2_data
from .models import (
    DEFAULT_SAMPLE_SIZE,
    FORWARD_DAYS,
    HORIZONS,
    MAX_CALENDAR_DAYS,
    AnalysisCreate,
    horizons_for,
)

logger = logging.getLogger(__name__)

#: 同一进程里同时只允许一个分析任务在跑（单进程 uvicorn，机器只有 4 核）。
_RUNNING: dict[str, threading.Thread] = {}
_LOCK = threading.Lock()


class AnalysisBusy(RuntimeError):
    """已有分析任务在跑。"""


class AnalysisParamsInvalid(ValueError):
    """区间/条件不合法。"""


def is_running(run_id: str) -> bool:
    thread = _RUNNING.get(run_id)
    return bool(thread and thread.is_alive())


def any_running() -> Optional[str]:
    for run_id, thread in list(_RUNNING.items()):
        if thread.is_alive():
            return run_id
    return None


def _request_of(preset_name: str, markets: Optional[Sequence[str]], include_st: Optional[bool]) -> ScreenRequest:
    """已保存条件 → 本次要跑的请求（市场/ST 可由创建表单覆盖，条件树不动）。"""
    record = presets.load(preset_name)
    raw = record.get("request")
    if not isinstance(raw, dict):
        raise AnalysisParamsInvalid(f"条件「{preset_name}」文件里没有可用的请求")
    request = ScreenRequest.model_validate(raw)
    update: dict[str, Any] = {}
    if markets:
        update["markets"] = list(markets)
    if include_st is not None:
        update["include_st"] = bool(include_st)
    if update:
        request = request.model_copy(update=update)
    return request


def preview(payload: AnalysisCreate) -> dict[str, Any]:
    """创建前的预估：区间内有几个交易日、方法要多少前瞻行情、结束日上限。"""
    method_id = methods.normalize(payload.method)
    spec = methods.spec(method_id)
    request = _request_of(payload.preset, payload.markets, payload.include_st)
    conn = fork_market._connect()
    try:
        latest = forward.latest_trade_date(conn)
        if latest is None:
            raise AnalysisParamsInvalid("行情库里没有任何数据")
        # 结束日上限：再往后就没有 forward_days 个交易日的验证行情了
        max_end = forward.shift_back(conn, latest, spec.forward_days)
        end = payload.end_date or max_end
        if end > max_end:
            end = max_end
        if payload.start_date > end:
            raise AnalysisParamsInvalid(
                f"开始日期晚于可验证的结束日期（{max_end.isoformat()}）"
            )
        calendar = forward.trading_calendar(conn, payload.start_date, end)
        version = forward.data_version(conn)
    finally:
        conn.close()
    if not calendar:
        raise AnalysisParamsInvalid("该区间内没有任何交易日")
    if len(calendar) > MAX_CALENDAR_DAYS:
        raise AnalysisParamsInvalid(f"区间最多 {MAX_CALENDAR_DAYS} 个交易日")
    return {
        "days": len(calendar),
        "first_day": str(calendar[0]),
        "last_day": str(calendar[-1]),
        "latest_trade_date": str(latest),
        "max_end_date": str(max_end),
        "validate_days": int(payload.validate_days),
        "forward_days": int(spec.forward_days),
        "horizons": (list(spec.windows) if method_id != "stat_v1"
                     else list(horizons_for(payload.validate_days))),
        "trading_days": int(request.trading_days),
        "markets": list(request.markets),
        "include_st": bool(request.include_st),
        "sample_size": int(payload.sample_size),
        "data_version": version,
        "method": method_id,
        "method_name": spec.name,
        "method_version": spec.version,
        "windows": list(spec.windows),
    }


def create(payload: AnalysisCreate) -> dict[str, Any]:
    """建任务目录 + 起后台线程，返回 meta。"""
    info = preview(payload)
    busy = any_running()
    if busy:
        raise AnalysisBusy(f"已有分析任务在跑（{busy}），等它结束或先停止")
    preset_name = presets.normalize_name(payload.preset)
    run_id = store.new_run_id()
    method_id = info["method"]
    meta = {
        "run_id": run_id,
        "preset": preset_name,
        "created_at": store._now(),
        "status": store.STATUS_PENDING,
        # 统计方法（老任务没有这个键 → 一律按方法 1 读，见 methods.method_of）
        "method": method_id,
        "method_name": info["method_name"],
        "method_version": info["method_version"],
        "forward_days": info["forward_days"],
        "start_date": payload.start_date.isoformat(),
        "end_date": info["last_day"],
        "end_date_requested": (payload.end_date or None) and payload.end_date.isoformat(),
        "validate_days": info["validate_days"] if method_id == "stat_v1" else info["forward_days"],
        "horizons": info["horizons"],
        # 口径版本：v3 = 可执行口径（次日开盘+成本）+ 市值配比对照 + 数据质量分层（2026-10-23）
        "caliber": "v3" if method_id == "stat_v1" else "v2.1",
        "caliber_detail": {
            "exec_cost": forward.EXEC_COST if method_id == "stat_v1" else 0.0,
            "suspend_cap": forward.SUSPEND_CAP,
            "control_matched": True,
        },
        # 数据版本戳：两次结果不同时，能分清是条件变了还是数据变了
        "data_version": info.get("data_version") or {},
        "max_end_date": info["max_end_date"],
        "markets": info["markets"],
        "include_st": info["include_st"],
        "sample_size": int(payload.sample_size) if payload.sample_size >= 0 else DEFAULT_SAMPLE_SIZE,
        "trading_days": info["trading_days"],
        "days_total": info["days"],
        "days_done": 0,
        "hits": 0,
        "control": 0,
        "failures": 0,
        "unverifiable": 0,
        "progress": {
            "days_total": info["days"],
            "days_done": 0,
            "hits": 0,
            "control": 0,
            "failures": 0,
            "unverifiable": 0,
            "avg_ms": 0,
            "elapsed_s": 0,
            "eta_s": None,
            "current_d0": None,
            "recent_days": [],
        },
        "error": None,
    }
    store.run_dir(preset_name, run_id).mkdir(parents=True, exist_ok=True)
    store.open_db(preset_name, run_id).close()
    store.save_meta(preset_name, meta)
    start(preset_name, run_id)
    return store.load_meta(preset_name, run_id)


def start(preset_name: str, run_id: str) -> None:
    """起（或续跑）后台线程。已完成的日期会被跳过，所以续跑是幂等的。"""
    with _LOCK:
        if is_running(run_id):
            return
        stop_file = store.run_dir(preset_name, run_id) / "stop"
        if stop_file.exists():
            stop_file.unlink()
        thread = threading.Thread(
            target=_loop, args=(preset_name, run_id), name=f"analysis-{run_id}", daemon=True
        )
        _RUNNING[run_id] = thread
        thread.start()


def _forward_dates(calendar: list[_dt.date], index: dict[_dt.date, int], d0: _dt.date,
                   days: int = FORWARD_DAYS) -> list[_dt.date]:
    position = index.get(d0)
    if position is None:
        return []
    return calendar[position + 1: position + 1 + days]


def _rows_for(
    items: list[dict[str, Any]],
    bars: dict[str, list[tuple]],
    missing: dict[str, int],
    fwd_dates: list[_dt.date],
    d0: _dt.date,
    is_control: int,
) -> tuple[list[dict[str, Any]], int]:
    """把命中/对照清单 + 行情算成待入库的行；返回 ``(rows, 不可验证数)``。"""
    rows: list[dict[str, Any]] = []
    unverifiable = 0
    for item in items:
        code = str(item.get("code") or item.get("c") or "")
        symbol = str(item.get("symbol") or item.get("s") or "")
        series = bars.get(symbol) or []
        if not series or series[0][0] != d0:
            # d0 当天没有有效 K 线：没有基准价，这条不算（宁缺毋滥）
            continue
        result = forward.build_forward(series, fwd_dates, forward.limit_pct(code, d0))
        if result is None:
            continue
        adj_missing = int(missing.get(symbol, 0))
        if adj_missing or result.verif == 0:
            unverifiable += 1
        row: dict[str, Any] = {
            "d0": d0.isoformat(),
            "code": code,
            "symbol": symbol,
            "name": str(item.get("name") or item.get("n") or ""),
            "board": forward.board_of(code),
            "is_control": int(is_control),
            "d0_close": round(result.d0_close, 4),
            "avail": int(result.avail),
            "entry_open": result.entry_open,
            "entry_days": int(result.entry_days),
            "verif": 0 if adj_missing else int(result.verif),
            "stale_days": int(result.stale_days),
            "unfillable": 1 if result.unfillable else 0,
            "adj_missing": adj_missing,
        }
        for index, value in enumerate(result.returns, start=1):
            row[f"r{index}"] = value
        for index, value in enumerate(result.exec_returns, start=1):
            row[f"x{index}"] = value
        for index, value in enumerate(result.vwap_returns, start=1):
            row[f"v{index}"] = value
        for index, horizon in enumerate(HORIZONS):
            row[f"t{horizon}"] = result.touches[index] if index < len(result.touches) else None
        rows.append(row)
    return rows, unverifiable


# --------------------------------------------------------------------------- #
# 方法 1 的主循环
# --------------------------------------------------------------------------- #
def _loop(preset_name: str, run_id: str) -> None:
    meta = store.load_meta(preset_name, run_id)
    if methods.method_of(meta) == "stat_v2":
        return _loop_m2(preset_name, run_id)
    started = time.perf_counter()
    request = _request_of(preset_name, meta.get("markets"), meta.get("include_st"))
    db = store.open_db(preset_name, run_id)
    conn = None
    stopped = False
    consecutive_errors = 0
    try:
        done = set(store.done_days(db))
        conn = fork_market._connect()
        calendar = forward.trading_calendar(conn, _dt.date.fromisoformat(meta["start_date"]), None)
        index = {day: position for position, day in enumerate(calendar)}
        end = _dt.date.fromisoformat(meta["end_date"])
        days = [day for day in calendar if _dt.date.fromisoformat(meta["start_date"]) <= day <= end]
        store.patch_meta(preset_name, run_id, status=store.STATUS_RUNNING, days_total=len(days))
        hits_total = int(meta.get("hits") or 0)
        control_total = int(meta.get("control") or 0)
        failures = int(meta.get("failures") or 0)
        unverifiable_total = int(meta.get("unverifiable") or 0)
        done_count = len([day for day in days if day.isoformat() in done])
        sample_size = int(meta.get("sample_size") or 0)
        recent = list((meta.get("progress") or {}).get("recent_days") or [])

        for d0 in days:
            if store.stop_requested(preset_name, run_id):
                stopped = True
                break
            if d0.isoformat() in done:
                continue
            day_started = time.perf_counter()
            try:
                screen_started = time.perf_counter()
                response = run_screen(request, asof=d0)
                items = list(response.get("items") or [])
                screen_ms = int((time.perf_counter() - screen_started) * 1000)
                forward_started = time.perf_counter()
                fwd_dates = _forward_dates(calendar, index, d0)
                last_day = fwd_dates[-1] if fwd_dates else d0
                symbols = [str(item.get("s") or item.get("symbol") or "") for item in items]
                bars, missing = forward.fetch_bars(conn, d0, symbols, last_day) if symbols else ({}, {})
                rows, unverifiable = _rows_for(items, bars, missing, fwd_dates, d0, 0)
                # 信号当天的横截面（分组统计用）：一次查完当天命中的全部股票
                breadth = forward.market_breadth(conn, d0)
                crowd = len(rows)
                if rows:
                    snapshots = forward.fetch_snapshots(conn, d0, [row["code"] for row in rows])
                    for row in rows:
                        sample = snapshots.get(row["code"]) or {}
                        for name in store.SNAPSHOT_COLUMNS:
                            row[name] = sample.get(name)
                        row["breadth"] = breadth
                        row["crowd"] = crowd

                control_rows: list[dict[str, Any]] = []
                control_unverifiable = 0
                if sample_size > 0:
                    # 对照组按命中股票的市值档配比抽，并排除命中股票自己
                    controls = forward.control_sample_matched(
                        conn, d0, sample_size, request.markets, bool(request.include_st),
                        hit_mcaps=[row.get("mcap") for row in rows],
                        exclude=[row["code"] for row in rows],
                    )
                    control_symbols = [item["symbol"] for item in controls]
                    control_bars, control_missing = (
                        forward.fetch_bars(conn, d0, control_symbols, last_day) if control_symbols else ({}, {})
                    )
                    control_rows, control_unverifiable = _rows_for(
                        controls, control_bars, control_missing, fwd_dates, d0, 1
                    )
                    # 对照组也要有横截面：因子归因要靠它控制市值/行业/换手，
                    # 组合模拟要靠 amount 做「同一条流动性规则」。缺了这些，
                    # 归因里的 is_signal 会和「特征缺失」共线，结果没有意义。
                    if control_rows:
                        extra = forward.fetch_snapshots(
                            conn, d0, [row["code"] for row in control_rows]
                        )
                        for row in control_rows:
                            sample = extra.get(row["code"]) or {}
                            for name in store.SNAPSHOT_COLUMNS:
                                row[name] = sample.get(name)
                            row["breadth"] = breadth
                            row["crowd"] = crowd

                coverage = forward.day_coverage(conn, d0)
                store.insert_signals(db, rows + control_rows)
                elapsed_ms = int((time.perf_counter() - day_started) * 1000)
                forward_ms = int((time.perf_counter() - forward_started) * 1000)
                store.record_day(
                    db, d0.isoformat(), len(rows), len(control_rows), elapsed_ms,
                    coverage=coverage,
                    usable=len(rows) - unverifiable,
                    screen_ms=screen_ms,
                    forward_ms=forward_ms,
                )
                done.add(d0.isoformat())
                done_count += 1
                hits_total += len(rows)
                control_total += len(control_rows)
                unverifiable_total += unverifiable + control_unverifiable
                consecutive_errors = 0
                recent = ([{"d0": d0.isoformat(), "hits": len(rows), "control": len(control_rows),
                            "elapsed_ms": elapsed_ms}] + recent)[:20]
                elapsed_s = time.perf_counter() - started
                remaining = len(days) - done_count
                avg_ms = elapsed_ms if done_count <= 1 else (elapsed_s * 1000 / done_count)
                store.patch_meta(
                    preset_name,
                    run_id,
                    days_done=done_count,
                    hits=hits_total,
                    control=control_total,
                    failures=failures,
                    unverifiable=unverifiable_total,
                    progress={
                        "days_total": len(days),
                        "days_done": done_count,
                        "hits": hits_total,
                        "control": control_total,
                        "failures": failures,
                        "unverifiable": unverifiable_total,
                        "avg_ms": int(avg_ms),
                        "elapsed_s": int(elapsed_s),
                        "eta_s": int(avg_ms * remaining / 1000),
                        "current_d0": d0.isoformat(),
                        "recent_days": recent,
                    },
                )
            except Exception as exc:  # noqa: BLE001 - 单日失败不该毁掉整段
                consecutive_errors += 1
                failures += 1
                logger.exception("分析任务 %s 在 %s 失败：%s", run_id, d0, exc)
                if consecutive_errors >= 5:
                    raise RuntimeError(f"连续 5 个交易日失败，最后一次：{exc}") from exc
                continue

        status = store.STATUS_STOPPED if stopped else store.STATUS_DONE
        elapsed_s = time.perf_counter() - started
        store.patch_meta(
            preset_name,
            run_id,
            status=status,
            days_done=done_count,
            hits=hits_total,
            control=control_total,
            failures=failures,
            unverifiable=unverifiable_total,
            finished_at=store._now(),
            elapsed_s=int(elapsed_s),
        )
    except Exception as exc:  # noqa: BLE001 - 任何意外都落到 failed + 原因
        logger.exception("分析任务 %s 失败：%s", run_id, exc)
        try:
            store.patch_meta(
                preset_name, run_id, status=store.STATUS_FAILED, error=str(exc), finished_at=store._now()
            )
        except Exception:  # noqa: BLE001
            logger.exception("写失败状态时出错：%s", run_id)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            # 预热报告缓存：报告第一次现算要把成本/入场/组合/归因全跑一遍（大任务
            # 约 60 秒），放在这里跑完就顺手算掉，用户点开就是 0.2 秒。
            # 失败无所谓 —— 读报告时会再算一次。
            try:
                stats.build_report(db, store.load_meta(preset_name, run_id))
            except Exception:  # noqa: BLE001
                logger.exception("预热报告缓存失败：%s", run_id)
        finally:
            db.close()


# --------------------------------------------------------------------------- #
# 方法 2 的主循环
# --------------------------------------------------------------------------- #
def _item_ids(item: dict[str, Any]) -> tuple[str, str, str]:
    """选股结果/对照样本里的 (code, symbol, name)，兼容长短两种键名。"""
    code = str(item.get("code") or item.get("c") or "")
    symbol = str(item.get("symbol") or item.get("s") or "")
    name = str(item.get("name") or item.get("n") or "")
    return code, symbol, name


def _m2_row(code: str, symbol: str, name: str, result: dict[str, Any], d0: _dt.date,
            is_control: int) -> dict[str, Any]:
    """``build_event`` 的结果 → 一行 ``m2_events``。"""
    row: dict[str, Any] = {
        "d0": d0.isoformat(),
        "code": code,
        "symbol": symbol,
        "name": name,
        "board": forward.board_of(code),
        "is_control": int(is_control),
        "buy_price": float(result["buy_price"]),
        "d0_close": float(result["d0_close"]),
        "avail": int(result["avail"]),
        "entry_days": int(result["entry_days"]),
        "valid": 1 if result["valid"] else 0,
        "reason": result["reason"] or "",
    }
    for window in store.M2_WINDOWS:
        row[f"mh{window}"] = result["mh"].get(window)
        row[f"ml{window}"] = result["ml"].get(window)
    return row


def _loop_m2(preset_name: str, run_id: str) -> None:
    started = time.perf_counter()
    meta = store.load_meta(preset_name, run_id)
    request = _request_of(preset_name, meta.get("markets"), meta.get("include_st"))
    db = store.open_db(preset_name, run_id)
    conn = None
    stopped = False
    consecutive_errors = 0
    try:
        done = set(store.done_days(db))
        conn = fork_market._connect()
        calendar = forward.trading_calendar(conn, _dt.date.fromisoformat(meta["start_date"]), None)
        index = {day: position for position, day in enumerate(calendar)}
        end = _dt.date.fromisoformat(meta["end_date"])
        start = _dt.date.fromisoformat(meta["start_date"])
        days = [day for day in calendar if start <= day <= end]
        store.patch_meta(preset_name, run_id, status=store.STATUS_RUNNING, days_total=len(days))
        hits_total = int(meta.get("hits") or 0)
        control_total = int(meta.get("control") or 0)
        failures = int(meta.get("failures") or 0)
        unverifiable_total = int(meta.get("unverifiable") or 0)
        done_count = len([day for day in days if day.isoformat() in done])
        sample_size = int(meta.get("sample_size") or 0)
        recent = list((meta.get("progress") or {}).get("recent_days") or [])
        horizon = int(meta.get("forward_days") or method2.FULL_DAYS)

        for d0 in days:
            if store.stop_requested(preset_name, run_id):
                stopped = True
                break
            if d0.isoformat() in done:
                continue
            day_started = time.perf_counter()
            try:
                screen_started = time.perf_counter()
                response = run_screen(request, asof=d0)
                items = list(response.get("items") or [])
                screen_ms = int((time.perf_counter() - screen_started) * 1000)
                forward_started = time.perf_counter()
                fwd_dates = _forward_dates(calendar, index, d0, horizon)
                last_day = fwd_dates[-1] if fwd_dates else d0
                symbols = [_item_ids(item)[1] for item in items]
                bars, missing = (method2_data.fetch_bars(conn, d0, symbols, last_day)
                                 if symbols else ({}, {}))

                rows: list[dict[str, Any]] = []
                for item in items:
                    code, symbol, name = _item_ids(item)
                    result = method2_data.build_event(
                        bars.get(symbol) or [], fwd_dates, d0, code, store.M2_WINDOWS,
                        horizon=horizon, adj_missing=int(missing.get(symbol, 0)),
                    )
                    if result is None:
                        continue
                    if not result["valid"]:
                        unverifiable_total += 1
                    rows.append(_m2_row(code, symbol, name, result, d0, 0))

                # 命中股票的当天横截面（对照组要按它的市值档配比抽样）
                breadth = forward.market_breadth(conn, d0)
                hit_snapshots = (forward.fetch_snapshots(conn, d0, [row["code"] for row in rows])
                                 if rows else {})
                for row in rows:
                    sample = hit_snapshots.get(row["code"]) or {}
                    for name in store.SNAPSHOT_COLUMNS:
                        row[name] = sample.get(name)
                    row["breadth"] = breadth
                    row["crowd"] = len(rows)

                control_rows: list[dict[str, Any]] = []
                if sample_size > 0:
                    controls = forward.control_sample_matched(
                        conn, d0, sample_size, request.markets, bool(request.include_st),
                        hit_mcaps=[row.get("mcap") for row in rows],
                        exclude=[row["code"] for row in rows],
                    )
                    control_symbols = [item["symbol"] for item in controls]
                    control_bars, control_missing = (
                        method2_data.fetch_bars(conn, d0, control_symbols, last_day)
                        if control_symbols else ({}, {})
                    )
                    for item in controls:
                        code, symbol, name = _item_ids(item)
                        result = method2_data.build_event(
                            control_bars.get(symbol) or [], fwd_dates, d0, code,
                            store.M2_WINDOWS, horizon=horizon,
                            adj_missing=int(control_missing.get(symbol, 0)),
                        )
                        if result is None:
                            continue
                        control_rows.append(_m2_row(code, symbol, name, result, d0, 1))
                    if control_rows:
                        control_snapshots = forward.fetch_snapshots(
                            conn, d0, [row["code"] for row in control_rows]
                        )
                        for row in control_rows:
                            sample = control_snapshots.get(row["code"]) or {}
                            for name in store.SNAPSHOT_COLUMNS:
                                row[name] = sample.get(name)
                            row["breadth"] = breadth
                            row["crowd"] = len(rows)

                coverage = forward.day_coverage(conn, d0)
                store.insert_m2_events(db, rows + control_rows)
                elapsed_ms = int((time.perf_counter() - day_started) * 1000)
                forward_ms = int((time.perf_counter() - forward_started) * 1000)
                store.record_day(
                    db, d0.isoformat(), len(rows), len(control_rows), elapsed_ms,
                    coverage=coverage,
                    usable=sum(1 for row in rows if row.get("valid")),
                    screen_ms=screen_ms,
                    forward_ms=forward_ms,
                )
                done.add(d0.isoformat())
                done_count += 1
                hits_total += len(rows)
                control_total += len(control_rows)
                consecutive_errors = 0
                recent = ([{"d0": d0.isoformat(), "hits": len(rows), "control": len(control_rows),
                            "elapsed_ms": elapsed_ms}] + recent)[:20]
                elapsed_s = time.perf_counter() - started
                remaining = len(days) - done_count
                avg_ms = elapsed_ms if done_count <= 1 else (elapsed_s * 1000 / done_count)
                store.patch_meta(
                    preset_name,
                    run_id,
                    days_done=done_count,
                    hits=hits_total,
                    control=control_total,
                    failures=failures,
                    unverifiable=unverifiable_total,
                    progress={
                        "days_total": len(days),
                        "days_done": done_count,
                        "hits": hits_total,
                        "control": control_total,
                        "failures": failures,
                        "unverifiable": unverifiable_total,
                        "avg_ms": int(avg_ms),
                        "elapsed_s": int(elapsed_s),
                        "eta_s": int(avg_ms * remaining / 1000),
                        "current_d0": d0.isoformat(),
                        "recent_days": recent,
                    },
                )
            except Exception as exc:  # noqa: BLE001 - 单日失败不该毁掉整段
                consecutive_errors += 1
                failures += 1
                logger.exception("分析方法 2 任务 %s 在 %s 失败：%s", run_id, d0, exc)
                if consecutive_errors >= 5:
                    raise RuntimeError(f"连续 5 个交易日失败，最后一次：{exc}") from exc
                continue

        status = store.STATUS_STOPPED if stopped else store.STATUS_DONE
        elapsed_s = time.perf_counter() - started
        store.patch_meta(
            preset_name,
            run_id,
            status=status,
            days_done=done_count,
            hits=hits_total,
            control=control_total,
            failures=failures,
            unverifiable=unverifiable_total,
            finished_at=store._now(),
            elapsed_s=int(elapsed_s),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("分析方法 2 任务 %s 失败：%s", run_id, exc)
        try:
            store.patch_meta(preset_name, run_id, status=store.STATUS_FAILED,
                             error=str(exc), finished_at=store._now())
        except Exception:  # noqa: BLE001
            logger.exception("写失败状态时出错：%s", run_id)
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            write_method2_artifacts(preset_name, run_id)
        except Exception as exc:  # noqa: BLE001 - 产物失败不影响数据
            logger.exception("生成方法 2 产物失败：%s", run_id)
            try:
                store.patch_meta(preset_name, run_id, artifacts_error=str(exc))
            except Exception:  # noqa: BLE001
                pass
        db.close()


def write_method2_artifacts(preset_name: str, run_id: str) -> list[str]:
    """按规格生成 8 个 CSV + report.md（跑完时一次，也可由接口按需重建）。"""
    meta = store.load_meta(preset_name, run_id)
    conn = store.open_db(preset_name, run_id)
    try:
        signal_events, duplicates = method2.load_events(conn, is_control=False)
        control_aggregates = method2.load_control_aggregates(conn)
        report, payload = method2.build_from_events(
            {**meta, "days_done": meta.get("days_done")}, signal_events, control_aggregates, duplicates
        )
        directory = store.artifacts_dir(preset_name, run_id)
        names = method2.write_artifacts(directory, payload)
    finally:
        conn.close()
    store.patch_meta(
        preset_name, run_id,
        artifacts=names,
        report_headline=report.headline.as_dict(),
        valid_events=report.data_quality.get("valid_events"),
        invariant_problems=report.data_quality.get("invariant_problems") or [],
    )
    return names
