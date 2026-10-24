"""条件推理接口（自动搜索更优的选股条件）。

错误契约
--------
================================  ====  ==================================
error_code                        HTTP  触发
================================  ====  ==================================
infer_preset_not_found            404   已保存条件不存在
infer_invalid_params              400   日期区间 / 条件自身不合法
infer_busy                        409   已有推理任务在跑（单进程只跑一个）
infer_run_not_found               404   任务 id 不存在
infer_variant_not_found           404   要保存的变体编号不存在
infer_preset_exists               409   保存时同名条件已存在
================================  ====  ==================================
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query

from ..fork_screen import presets
from ..fork_infer import search, store
from ..fork_infer.models import InferCreate

logger = logging.getLogger(__name__)

router = APIRouter()


def _bad(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _meta(run_id: str) -> dict[str, Any]:
    try:
        return store.load_meta(run_id)
    except FileNotFoundError as exc:
        raise _bad(404, "infer_run_not_found", f"任务 {run_id} 不存在") from exc


def _view(meta: dict[str, Any]) -> dict[str, Any]:
    """给界面的任务视图：去掉逐日日期数组（几百个元素，界面不用）。"""
    view = dict(meta)
    view["train_day_count"] = len(meta.get("train_days") or [])
    view["valid_day_count"] = len(meta.get("valid_days") or [])
    view.pop("train_days", None)
    view.pop("valid_days", None)
    view["alive"] = search.is_running(str(meta.get("run_id") or ""))
    return view


@router.post("/infer/preview")
def infer_preview(payload: InferCreate) -> dict[str, Any]:
    """创建前预估：两段各多少交易日、跑多久、基础条件长什么样。"""
    try:
        return search.preview(payload)
    except presets.PresetNotFound as exc:
        raise _bad(404, "infer_preset_not_found", str(exc)) from exc
    except search.InferParamsInvalid as exc:
        raise _bad(400, "infer_invalid_params", str(exc)) from exc


@router.post("/infer/runs")
def create_infer_run(payload: InferCreate) -> dict[str, Any]:
    try:
        meta = search.create(payload)
    except presets.PresetNotFound as exc:
        raise _bad(404, "infer_preset_not_found", str(exc)) from exc
    except search.InferBusy as exc:
        raise _bad(409, "infer_busy", str(exc)) from exc
    except search.InferParamsInvalid as exc:
        raise _bad(400, "infer_invalid_params", str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise _bad(503, "infer_unavailable", f"创建失败：{exc}") from exc
    return {"item": _view(meta)}


@router.get("/infer/runs")
def list_infer_runs(limit: int = Query(default=20, ge=1, le=200)) -> dict[str, Any]:
    return {"items": [_view(meta) for meta in store.list_runs(limit)]}


@router.get("/infer/runs/{run_id}")
def get_infer_run(run_id: str) -> dict[str, Any]:
    return {"item": _view(_meta(run_id))}


@router.post("/infer/runs/{run_id}/pause")
def pause_infer_run(run_id: str) -> dict[str, Any]:
    _meta(run_id)
    return {"item": _view(search.pause(run_id))}


@router.post("/infer/runs/{run_id}/resume")
def resume_infer_run(run_id: str) -> dict[str, Any]:
    _meta(run_id)
    return {"item": _view(search.resume(run_id))}


@router.post("/infer/runs/{run_id}/stop")
def stop_infer_run(run_id: str) -> dict[str, Any]:
    _meta(run_id)
    return {"item": _view(search.stop(run_id))}


@router.get("/infer/runs/{run_id}/results")
def infer_results(run_id: str, limit: int = Query(default=30, ge=1, le=500)) -> dict[str, Any]:
    _meta(run_id)
    return search.results(run_id, limit)


@router.post("/infer/runs/{run_id}/save")
def save_infer_variant(run_id: str, index: int = Query(ge=1),
                      name: Optional[str] = Query(default=None, max_length=10)) -> dict[str, Any]:
    """把一个变体保存成「已保存条件」。"""
    _meta(run_id)
    try:
        return search.save_condition(run_id, index, name)
    except search.InferParamsInvalid as exc:
        raise _bad(404, "infer_variant_not_found", str(exc)) from exc
    except presets.PresetNameInvalid as exc:
        raise _bad(400, "infer_invalid_params", str(exc)) from exc
    except presets.PresetExists as exc:
        raise _bad(409, "infer_preset_exists", str(exc)) from exc


@router.delete("/infer/runs/{run_id}")
def delete_infer_run(run_id: str) -> dict[str, Any]:
    _meta(run_id)
    if search.is_running(run_id):
        raise _bad(409, "infer_busy", "任务正在运行，先停止再删除")
    store.delete_run(run_id)
    return {"deleted": run_id}
