"""数据分析接口（需求：条件在历史上的准确率）。

错误契约
--------
================================  ====  ==================================
error_code                        HTTP  触发
================================  ====  ==================================
analysis_preset_not_found         404   已保存条件不存在
analysis_invalid_params           400   日期区间 / 条件自身不合法
analysis_busy                     409   已有分析任务在跑（单进程只跑一个）
analysis_run_not_found            404   任务 id 不存在
analysis_report_not_ready         409   还没有任何信号（0 天命中或刚创建）
analysis_excel_missing            404   Excel 还没生成（正在跑 / 生成失败）
================================  ====  ==================================
"""

from __future__ import annotations

import datetime as _dt
import logging
import shutil
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse

from ..api import fork_market
from ..fork_analysis import ablation, backfill, excel, leaderboard, runner, significance, stats, store
from ..fork_analysis.models import AnalysisCreate, horizons_for
from ..fork_screen import presets

logger = logging.getLogger(__name__)

router = APIRouter()


def _bad(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _stat_caliber(conn: Any) -> tuple[str, float]:
    """统计该用哪套口径：有可执行列就用 x + 扣成本，老任务退回收盘口径。"""
    prefix, caliber = significance.caliber_columns(conn)
    return prefix, (stats.EXEC_COST if caliber == "exec" else 0.0)


def _locate(run_id: str) -> tuple[str, dict[str, Any]]:
    try:
        return store.find_run(run_id)
    except store.RunNotFound as exc:
        raise _bad(404, "analysis_run_not_found", str(exc)) from exc


def _meta_view(preset_name: str, meta: dict[str, Any]) -> dict[str, Any]:
    """给前端的任务视图。

    ``status`` 有一处修正：进程重启后 meta 里仍是 ``running``，但线程已经没了 ——
    这时候显示 ``interrupted``（可续跑），不能让界面永远停在进度条上。
    """
    view = dict(meta)
    running = runner.is_running(meta.get("run_id", ""))
    view["running"] = running
    if str(view.get("status")) == store.STATUS_RUNNING and not running:
        view["status"] = "interrupted"
    try:
        conn = store.open_db_readonly(preset_name, meta["run_id"])
    except (store.RunNotFound, Exception):  # noqa: BLE001 - 只是加个计数，失败不影响
        return view
    try:
        view["counts"] = store.counts(conn)
        view["recent_days"] = store.day_rows(conn, 20)
    finally:
        conn.close()
    try:
        view["excel_ready"] = store.excel_path(preset_name, meta["run_id"]).is_file()
    except Exception:  # noqa: BLE001
        view["excel_ready"] = False
    return view


@router.post("/analysis/preview")
def analysis_preview(payload: AnalysisCreate) -> dict[str, Any]:
    """创建前的预估（交易日数 / 条件窗口 / 最新交易日）。"""
    try:
        return runner.preview(payload)
    except presets.PresetNotFound as exc:
        raise _bad(404, "analysis_preset_not_found", str(exc)) from exc
    except (presets.PresetNameInvalid, runner.AnalysisParamsInvalid) as exc:
        raise _bad(400, "analysis_invalid_params", str(exc)) from exc
    except fork_market.ForkDbUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/analysis/runs")
def create_analysis_run(payload: AnalysisCreate) -> dict[str, Any]:
    try:
        meta = runner.create(payload)
    except presets.PresetNotFound as exc:
        raise _bad(404, "analysis_preset_not_found", str(exc)) from exc
    except (presets.PresetNameInvalid, runner.AnalysisParamsInvalid) as exc:
        raise _bad(400, "analysis_invalid_params", str(exc)) from exc
    except runner.AnalysisBusy as exc:
        raise _bad(409, "analysis_busy", str(exc)) from exc
    except fork_market.ForkDbUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"item": _meta_view(meta["preset"], meta)}


@router.get("/analysis/runs")
def list_analysis_runs(preset: Optional[str] = Query(default=None)) -> dict[str, Any]:
    """任务列表（新的在前）。给「未开始」界面列历史任务用。"""
    try:
        items = store.list_runs(preset)
    except presets.PresetNameInvalid as exc:
        raise _bad(400, "analysis_invalid_params", str(exc)) from exc
    return {"items": [_meta_view(item.get("preset") or preset or "", item) for item in items]}


@router.get("/analysis/runs/{run_id}")
def get_analysis_run(run_id: str) -> dict[str, Any]:
    preset_name, meta = _locate(run_id)
    return {"item": _meta_view(preset_name, meta)}


@router.post("/analysis/runs/{run_id}/stop")
def stop_analysis_run(run_id: str) -> dict[str, Any]:
    preset_name, meta = _locate(run_id)
    if store.is_terminal(meta) and not runner.is_running(run_id):
        return {"item": _meta_view(preset_name, meta)}
    store.request_stop(preset_name, run_id)
    return {"item": _meta_view(preset_name, meta), "stopping": True}


@router.post("/analysis/runs/{run_id}/resume")
def resume_analysis_run(run_id: str) -> dict[str, Any]:
    """续跑：已完成的日期按 ``days`` 表跳过，所以可以反复点。"""
    preset_name, meta = _locate(run_id)
    if runner.is_running(run_id):
        return {"item": _meta_view(preset_name, meta)}
    if str(meta.get("status")) == store.STATUS_DONE:
        return {"item": _meta_view(preset_name, meta)}
    runner.start(preset_name, run_id)
    return {"item": _meta_view(preset_name, store.load_meta(preset_name, run_id))}


@router.get("/analysis/runs/{run_id}/report")
def analysis_report(run_id: str) -> dict[str, Any]:
    """统计主体：各周期胜率/超额/盈亏比 + 13 个维度的分组统计 + 到达天数 + 结论。"""
    preset_name, meta = _locate(run_id)
    try:
        # 读写连接：分组统计第一次要写缓存表（group_stats / arrival_stats）
        conn = store.open_db(preset_name, run_id)
    except store.RunNotFound as exc:
        raise _bad(409, "analysis_report_not_ready", "这个任务还没有产生任何信号") from exc
    try:
        counts = store.counts(conn)
        if counts["hits"] == 0 and counts["control"] == 0:
            raise _bad(409, "analysis_report_not_ready", "这个任务还没有产生任何信号")
        report = stats.build_report(conn, meta)
    finally:
        conn.close()
    return {"run": _meta_view(preset_name, meta), "counts": counts, **report}


@router.get("/analysis/runs/{run_id}/detail")
def analysis_detail(run_id: str) -> dict[str, Any]:
    """任务详情（历史任务点进来的那个窗口）：条件原文 + 评价 + 前几条命中。"""
    preset_name, meta = _locate(run_id)
    view = _meta_view(preset_name, meta)
    condition: dict[str, Any] = {"name": preset_name}
    try:
        record = presets.load(preset_name)
        condition.update({
            "saved_at": record.get("saved_at"),
            "request": record.get("request"),
        })
    except Exception as exc:  # noqa: BLE001 - 条件文件被删了也要能看结果
        condition["missing"] = str(exc)

    verdict: dict[str, Any] | None = None
    horizons = list(meta.get("horizons") or [])
    try:
        conn = store.open_db_readonly(preset_name, run_id)
    except store.RunNotFound:
        conn = None
    if conn is not None:
        try:
            prefix, cost = _stat_caliber(conn)
            rows = stats.summary(conn, tuple(horizons or [30]), prefix, cost)
            honest_rows, _ = significance.tests(conn, tuple(horizons or [30]), cost)
            verdict = stats.verdict(rows, significance.conclusion(honest_rows))
        except Exception:  # noqa: BLE001
            logger.exception("读取任务 %s 的结论失败", run_id)
        finally:
            conn.close()
    return {"run": view, "condition": condition, "verdict": verdict, "horizons": horizons}


@router.delete("/analysis/runs/{run_id}")
def delete_analysis_run(run_id: str) -> dict[str, Any]:
    """删除任务及其产物（signals.db / Excel / meta）。跑着的时候不允许删。"""
    preset_name, meta = _locate(run_id)
    if runner.is_running(run_id):
        raise _bad(409, "analysis_busy", "任务还在跑，先停止再删除")
    directory = store.run_dir(preset_name, run_id)
    shutil.rmtree(directory, ignore_errors=True)
    return {"deleted": run_id}


@router.post("/analysis/runs/{run_id}/recompute")
def recompute_analysis_run(run_id: str) -> dict[str, Any]:
    """按新口径重算（补信号日快照 + 清分组缓存 + 重建 Excel）。

    老任务的涨幅列是几小时跑出来的，不重跑；缺的只是「信号日横截面」，
    按天回填一次即可（用户第 11 条上线时对已有任务做的就是这个）。
    """
    preset_name, meta = _locate(run_id)
    if runner.is_running(run_id):
        raise _bad(409, "analysis_busy", "任务还在跑，等它结束再重算")
    try:
        result = backfill.fill_snapshots(preset_name, run_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("重算任务 %s 失败", run_id)
        raise _bad(500, "analysis_recompute_failed", str(exc)) from exc
    try:
        backfill.rebuild_excel(preset_name, run_id)
    except Exception:  # noqa: BLE001 - Excel 失败不影响统计
        logger.exception("重建 Excel 失败：%s", run_id)
    return {"run": _meta_view(preset_name, store.load_meta(preset_name, run_id)), **result}


@router.get("/analysis/runs/{run_id}/stocks")
def analysis_stocks(
    run_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    sort: str = Query(default="win_10"),
    order: str = Query(default="desc"),
    board: Optional[str] = Query(default=None),
    min_samples: int = Query(default=0, ge=0),
    q: Optional[str] = Query(default=None),
    sufficient_only: bool = Query(default=False),
) -> dict[str, Any]:
    """个股准确率排行（服务端排序 + 分页，个股可能上千只）。"""
    preset_name, meta = _locate(run_id)
    horizons = tuple(meta.get("horizons") or horizons_for(int(meta.get("validate_days") or 30)))
    try:
        conn = store.open_db_readonly(preset_name, run_id)
    except store.RunNotFound as exc:
        raise _bad(409, "analysis_report_not_ready", "这个任务还没有产生任何信号") from exc
    try:
        prefix, cost = _stat_caliber(conn)
        control = stats.control_win_rates(stats.summary(conn, horizons, prefix, cost))
        items = stats.by_stock(conn, control, horizons, prefix, cost)
    finally:
        conn.close()

    if board:
        items = [item for item in items if item["board"] == board]
    if min_samples > 0:
        items = [item for item in items if item["n"] >= min_samples]
    if sufficient_only:
        items = [item for item in items if item["sufficient"]]
    if q:
        needle = q.strip()
        items = [item for item in items if needle in item["code"] or needle in item["name"]]

    # 兼容 win10（无下划线）与 win_10：前者曾被当成「按 30 日排序」的静默默认
    key, _, horizon = sort.partition("_")
    if not horizon and key[:3] in ("win", "avg") and key[3:].isdigit():
        key, horizon = key[:3], key[3:]
    if sort in ("n", "code", "name"):
        def sort_key(item: dict[str, Any]) -> Any:
            if sort == "n":
                return item["n"]
            return item[sort]
    elif key in ("win", "avg", "excess") and horizon:
        field = key

        def sort_key(item: dict[str, Any]) -> Any:  # type: ignore[misc]
            value = item[field].get(horizon)
            return -999.0 if value is None else float(value)
    else:
        fallback = str(horizons[-1])

        def sort_key(item: dict[str, Any]) -> Any:  # type: ignore[misc]
            value = item["win"].get(fallback)
            return -999.0 if value is None else float(value)

    items.sort(key=sort_key, reverse=(order != "asc"))
    total = len(items)
    return {"total": total, "offset": offset, "limit": limit, "items": items[offset: offset + limit]}


@router.get("/analysis/leaderboard")
def analysis_leaderboard(limit: int = Query(default=40, ge=2, le=200)) -> dict[str, Any]:
    """跨条件排行榜：同一口径比较所有已完成的任务（含选择偏差提示）。"""
    return leaderboard.board(limit)


@router.post("/analysis/runs/{run_id}/ablation")
def start_ablation(
    run_id: str,
    sample_days: int = Query(default=ablation.DEFAULT_SAMPLE_DAYS, ge=10, le=200),
    horizon: Optional[int] = Query(default=None, ge=1, le=30),
) -> dict[str, Any]:
    """消融 / 参数扰动（后台跑，几十分钟；结果写 ablation.json）。"""
    preset_name, meta = _locate(run_id)
    if not store.is_terminal(meta) and not runner.is_running(run_id):
        raise _bad(409, "analysis_report_not_ready", "任务还没跑完，先让它结束再做消融")
    try:
        return ablation.start(preset_name, run_id, sample_days, horizon)
    except Exception as exc:  # noqa: BLE001
        logger.exception("启动消融失败：%s", exc)
        raise _bad(500, "analysis_ablation_failed", str(exc)) from exc


@router.get("/analysis/runs/{run_id}/ablation")
def get_ablation(run_id: str) -> dict[str, Any]:
    preset_name, _meta = _locate(run_id)
    payload = ablation.status(preset_name, run_id)
    if payload is None:
        return {"status": "absent", "variants": [], "progress": {"done": 0, "total": 0}}
    payload["running"] = ablation.is_running(run_id)
    return payload


@router.get("/analysis/runs/{run_id}/signals")
def analysis_signals(
    run_id: str,
    code: str = Query(min_length=1),
    limit: int = Query(default=500, ge=1, le=2000),
) -> dict[str, Any]:
    """某只股票在这个条件下的全部信号（弹窗里的明细）。"""
    preset_name, meta = _locate(run_id)
    validate_days = int(meta.get("validate_days") or 30)
    try:
        conn = store.open_db_readonly(preset_name, run_id)
    except store.RunNotFound as exc:
        raise _bad(409, "analysis_report_not_ready", "这个任务还没有产生任何信号") from exc
    columns = ", ".join(["d0", "d0_close", "avail", *store.RETURN_COLUMNS[:validate_days]])
    try:
        rows = conn.execute(
            f"SELECT {columns} FROM signals WHERE is_control = 0 AND code = ? "
            "ORDER BY d0 DESC LIMIT ?",
            (code, int(limit)),
        ).fetchall()
    finally:
        conn.close()
    return {
        "code": code,
        "validate_days": validate_days,
        "items": [
            {
                "d0": str(row["d0"]),
                "d0_close": float(row["d0_close"]) if row["d0_close"] is not None else None,
                "avail": int(row["avail"] or 0),
                "returns": [row[f"r{i}"] for i in range(1, validate_days + 1)],
            }
            for row in rows
        ],
    }


@router.get("/analysis/runs/{run_id}/excel")
def analysis_excel(run_id: str) -> FileResponse:
    preset_name, meta = _locate(run_id)
    path = store.excel_path(preset_name, run_id)
    if not path.is_file():
        # 按需重建：主循环收尾时进程被杀、或用户第一次下载时文件还没写好，
        # 都靠这一步兜底（数据都在 signals.db 里，重算一次几秒钟）。
        try:
            conn = store.open_db(preset_name, run_id)
            try:
                excel.write_workbook(conn, preset_name, run_id)
            finally:
                conn.close()
        except Exception as exc:  # noqa: BLE001
            logger.exception("重建 Excel 失败：%s", exc)
            raise _bad(404, "analysis_excel_missing", "Excel 还没生成（任务可能仍在运行）") from exc
    name = f"{preset_name}-{run_id}.xlsx"
    return FileResponse(
        str(path),
        filename=name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
