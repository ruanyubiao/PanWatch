"""条件选股接口 ``POST /api/stocks/screen``（需求规格 §8）。

只做四件事：校验 → 并发闸 → 取数 → 求值组装。业务规则全在
``fork_screen.evaluator`` / ``conditions`` 里，那里可以脱离数据库单测。

错误契约（前端 ``client.ts`` 的 ``API_ERROR_TEXT_EN`` 有对应英文）：

=================  =====  ==========================
error_code         HTTP   触发
=================  =====  ==========================
screen_invalid_params  400  统计窗口 / 市场 / 市值不合法
screen_invalid_rule    400  未知条件、空子组、超深、参数不合法
screen_busy            429  同时进行中的选股请求超过 2 个
screen_data_stale      503  日历最新日 ≠ asof（行情表没更新完）
screen_eval_failed     500  求值时出现非预期异常
=================  =====  ==========================

（``ForkDbUnavailable`` 沿用 ``market-table`` 的行为：503 + 字符串 detail。）
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..api import fork_market
from ..fork_screen import presets
from ..fork_screen.evaluator import (
    ScreenEvalError,
    ScreenRuleInvalid,
    compile_rule,
    evaluate_candidates,
    is_empty_rule,
    required_bars_of_group,
    validate_params,
    validate_rule,
)
from ..fork_screen.models import ScreenRequest
from ..fork_screen.repository import ScreenData, fetch_screen_data

logger = logging.getLogger(__name__)

router = APIRouter()

#: 规格 §8.3-2：模块级并发闸，最多 2 个选股任务同时在跑（单进程 uvicorn，
#: 所以模块级就够了；多 worker 时要换成跨进程的锁）。
_SCREEN_SLOTS = threading.BoundedSemaphore(2)


def _bad(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _screen_response(req: ScreenRequest, rule, data: ScreenData, k: int, elapsed_ms: int) -> dict[str, Any]:
    """求值 + 组装响应（``items`` 与 ``market-table`` 逐字段同形）。"""
    calendar = data.calendar
    trading_days = int(req.trading_days)
    outcome = evaluate_candidates(
        rule,
        data.candidates,
        data.series,
        calendar,
        trading_days,
        data.asof,
    )
    items = [fork_market.map_row(row) for row in outcome.hit_rows]
    items.sort(key=lambda item: str(item.get("code") or ""))
    return {
        "asof": str(data.asof) if data.asof is not None else None,
        "total": len(items),
        "items": items,
        "window": {
            "trading_days": trading_days,
            "fetched_bars": int(k),
            "start_date": str(calendar[-1]) if calendar else None,
        },
        "stats": {
            "candidates": outcome.candidates,
            "evaluated": outcome.evaluated,
            "insufficient": outcome.insufficient,
            "elapsed_ms": elapsed_ms,
        },
    }


@router.post("/screen")
def screen(payload: ScreenRequest) -> dict[str, Any]:
    """按基础范围 + 技术条件筛选 A 股。结果直接替换分析页的表格数据源。"""
    started = time.perf_counter()

    param_issues = validate_params(payload)
    if param_issues:
        raise _bad(
            status=400,
            code="screen_invalid_params",
            message="；".join(issue.describe() for issue in param_issues),
        )
    rule_issues = validate_rule(payload)
    if rule_issues:
        raise _bad(
            status=400,
            code="screen_invalid_rule",
            message="；".join(issue.describe() for issue in rule_issues),
        )
    try:
        rule = compile_rule(payload)
    except ScreenRuleInvalid as exc:  # 防御性：上面两步已经拦过
        raise _bad(status=400, code="screen_invalid_rule", message=str(exc)) from exc

    k = required_bars_of_group(rule, int(payload.trading_days))

    if not _SCREEN_SLOTS.acquire(blocking=False):
        raise _bad(status=429, code="screen_busy", message="选股任务繁忙，请稍后重试")
    try:
        try:
            data = fetch_screen_data(payload, k)
        except fork_market.ForkDbUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

        if data.stale_date is not None:
            raise _bad(
                status=503,
                code="screen_data_stale",
                message=f"近期行情表未更新到 {data.asof}（最新 {data.stale_date}），暂不能选股",
            )

        try:
            body = _screen_response(payload, rule, data, k, int((time.perf_counter() - started) * 1000))
        except ScreenEvalError as exc:
            logger.exception("条件选股求值失败：%s", exc)
            raise _bad(
                status=500,
                code="screen_eval_failed",
                message=f"条件计算失败（{exc.condition}），请联系管理员",
            ) from exc
    finally:
        _SCREEN_SLOTS.release()

    body["stats"]["elapsed_ms"] = int((time.perf_counter() - started) * 1000)
    logger.info(
        "条件选股：candidates=%s K=%s rows=%s 空树=%s 命中=%s 耗时=%sms",
        body["stats"]["candidates"],
        k,
        data.fetched_bars,
        is_empty_rule(rule),
        body["total"],
        body["stats"]["elapsed_ms"],
    )
    return body


# --------------------------------------------------------------------------
# 已保存条件（用户反馈 2026-10-20 第 1 / 2 条）
#
# 存在磁盘上、一个条件一个文件，文件名 = 用户输入的名字（见 presets.py）。
# 保存的是一个**完整的选股请求**，所以「编辑」时能把窗口 / 市场 / 市值 / 条件树
# 一并带回来，而不是只回填条件树。
# --------------------------------------------------------------------------


class PresetSaveBody(BaseModel):
    """保存条件的请求体。``extra="forbid"`` 与 ``ScreenRequest`` 保持一致。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=presets.NAME_MAX_LEN)
    request: ScreenRequest
    #: 同名时是否覆盖：前端先问一句，用户点了「覆盖」才带 true 重发
    overwrite: bool = False


def _check_request(payload: ScreenRequest) -> None:
    """保存前把请求按选股同一套规则校验一遍：坏的规则不该被存下来。"""
    param_issues = validate_params(payload)
    if param_issues:
        raise _bad(
            status=400,
            code="screen_invalid_params",
            message="；".join(issue.describe() for issue in param_issues),
        )
    rule_issues = validate_rule(payload)
    if rule_issues:
        raise _bad(
            status=400,
            code="screen_invalid_rule",
            message="；".join(issue.describe() for issue in rule_issues),
        )


@router.get("/screen/presets")
def list_screen_presets() -> dict[str, Any]:
    """全部已保存条件（新的在前）。没有目录时返回空列表，不是错误。"""
    return {"items": presets.list_all()}


@router.post("/screen/presets")
def save_screen_preset(payload: PresetSaveBody) -> dict[str, Any]:
    """保存（或覆盖）一个条件。名字非法 400，同名未确认覆盖 409。"""
    _check_request(payload.request)
    try:
        record = presets.save(
            payload.name,
            payload.request.model_dump(mode="json"),
            overwrite=payload.overwrite,
        )
    except presets.PresetNameInvalid as exc:
        raise _bad(status=400, code="screen_preset_name_invalid", message=str(exc)) from exc
    except presets.PresetExists as exc:
        raise _bad(status=409, code="screen_preset_exists", message=str(exc)) from exc
    except OSError as exc:
        logger.exception("保存选股条件失败：%s", exc)
        raise _bad(
            status=500, code="screen_preset_write_failed", message="保存条件失败，请检查服务器磁盘"
        ) from exc
    return {"item": record}


@router.delete("/screen/presets/{name}")
def delete_screen_preset(name: str) -> dict[str, Any]:
    """删除一个已保存条件。名字非法或不存在都按 404（不去猜用户的意图）。"""
    try:
        presets.delete(name)
    except presets.PresetError as exc:
        raise _bad(status=404, code="screen_preset_not_found", message=str(exc)) from exc
    except OSError as exc:
        logger.exception("删除选股条件失败：%s", exc)
        raise _bad(
            status=500, code="screen_preset_write_failed", message="删除条件失败，请检查服务器磁盘"
        ) from exc
    return {"deleted": name}
