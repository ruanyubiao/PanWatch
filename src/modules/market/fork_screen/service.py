"""条件选股的**服务入口**：一个函数跑完一次选股（规格 §8）。

为什么单独一层
--------------
端点（``api/fork_screen.py``）只做「HTTP 语义 → 这个函数的异常」的翻译，业务
流程全在这里。好处是同一个入口可以被三类调用方复用，而且它们拿到的是**完全
一样的选中集合**：

1. HTTP：``POST /api/stocks/screen``；
2. 脚本 / 定时任务：``run_screen(request_dict, asof=date(2026, 9, 1))``；
3. 单元测试：直接构造请求，不需要起服务。

``asof`` 的语义（用户 2026-10-21 定的 A 方案）
---------------------------------------------
传进来的日期是**统计窗口的结束日**：30 个交易日从它往前数。非交易日（周末、
长假）自动落到 ≤ 它的最大交易日，响应里的 ``asof`` 永远是真正用的那一天，
``requested_asof`` 保留用户填的原值，方便前端把「9/1 → 实际 8/29」显示出来。

不传 ``asof`` 时行为与加这个参数之前完全一致：锚点 = 库里最新交易日。
"""

from __future__ import annotations

import datetime as _dt
import logging
import threading
import time
from typing import Any

from ..api import fork_market
from .conditions import has_volume_price
from .evaluator import (
    ScreenEvalError,
    ScreenIssue,
    ScreenRuleInvalid,
    compile_rule,
    evaluate_candidates,
    is_empty_rule,
    required_bars_of_group,
    validate_params,
    validate_rule,
)
from .models import ScreenRequest
from .repository import ScreenData, fetch_screen_data, resolve_asof

logger = logging.getLogger(__name__)

#: 规格 §8.3-2：模块级并发闸，最多 2 个选股任务同时在跑（单进程 uvicorn）。
_SLOTS = threading.BoundedSemaphore(2)


class ScreenParamsInvalid(ValueError):
    """基础筛选参数不合法 —— 端点转成 400 ``screen_invalid_params``。"""

    def __init__(self, issues: list[ScreenIssue]) -> None:
        self.issues = issues
        super().__init__("；".join(issue.describe() for issue in issues))


class ScreenNoData(LookupError):
    """指定的日期之前库里没有任何行情 —— 端点转成 400 ``screen_no_data``。"""

    def __init__(self, day: _dt.date) -> None:
        self.day = day
        super().__init__(f"行情库里没有 {day} 及更早的数据，换一个日期试试")


class ScreenDataStale(RuntimeError):
    """日历最新日 ≠ asof（行情表没更新完）—— 端点转成 503 ``screen_data_stale``。"""

    def __init__(self, asof: _dt.date | None, latest: _dt.date | None) -> None:
        self.asof = asof
        self.latest = latest
        super().__init__(f"近期行情表未更新到 {asof}（最新 {latest}），暂不能选股")


class ScreenBusy(RuntimeError):
    """同时进行的选股请求超过 2 个 —— 端点转成 429 ``screen_busy``。"""


def _assemble(
    req: ScreenRequest,
    rule: Any,
    data: ScreenData,
    elapsed_ms: int,
    requested: _dt.date | None = None,
) -> dict[str, Any]:
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
    items.sort(key=lambda item: str(item.get("c") or ""))
    return {
        "asof": str(data.asof) if data.asof is not None else None,
        "requested_asof": str(requested) if requested is not None else None,
        "total": len(items),
        "items": items,
        "window": {
            "trading_days": trading_days,
            "fetched_bars": 0,
            "start_date": str(calendar[-1]) if calendar else None,
        },
        "stats": {
            "candidates": outcome.candidates,
            "evaluated": outcome.evaluated,
            "insufficient": outcome.insufficient,
            "elapsed_ms": elapsed_ms,
        },
    }


def run_screen(payload: ScreenRequest, asof: _dt.date | None = None) -> dict[str, Any]:
    """跑一次条件选股，返回与 ``POST /api/stocks/screen`` 完全相同的响应体。

    ``asof`` 优先于 ``payload.asof``（方便脚本直接把「今天要跑哪一天」传进来）。
    抛出的异常见模块头的四个类 + ``fork_market.ForkDbUnavailable``。
    """
    started = time.perf_counter()

    param_issues = validate_params(payload)
    if param_issues:
        raise ScreenParamsInvalid(param_issues)
    rule_issues = validate_rule(payload)
    if rule_issues:
        raise ScreenRuleInvalid(rule_issues)

    requested = asof if asof is not None else payload.asof
    resolved: _dt.date | None = None
    if requested is not None:
        resolved = resolve_asof(requested)
        if resolved is None:
            raise ScreenNoData(requested)

    rule = compile_rule(payload)
    k = required_bars_of_group(rule, int(payload.trading_days))
    with_extras = has_volume_price(rule)

    if not _SLOTS.acquire(blocking=False):
        raise ScreenBusy("选股任务繁忙，请稍后重试")
    try:
        data = fetch_screen_data(payload, k, asof=resolved, with_extras=with_extras)
        if data.stale_date is not None:
            # 只在「锚点 = 最新交易日」时才有意义：指定历史日期时，
            # 日历最新日必然等于 asof（asof 本来就是从 ≤ 该日的最大交易日落出来的）
            raise ScreenDataStale(data.asof, data.stale_date)
        body = _assemble(payload, rule, data, int((time.perf_counter() - started) * 1000), requested)
    finally:
        _SLOTS.release()

    body["window"]["fetched_bars"] = int(k)
    body["stats"]["elapsed_ms"] = int((time.perf_counter() - started) * 1000)
    logger.info(
        "条件选股：asof=%s candidates=%s K=%s 量价=%s rows=%s 空树=%s 命中=%s 耗时=%sms",
        body["asof"],
        body["stats"]["candidates"],
        k,
        with_extras,
        data.fetched_bars,
        is_empty_rule(rule),
        body["total"],
        body["stats"]["elapsed_ms"],
    )
    return body


__all__ = [
    "ScreenBusy",
    "ScreenDataStale",
    "ScreenEvalError",
    "ScreenNoData",
    "ScreenParamsInvalid",
    "ScreenRuleInvalid",
    "run_screen",
]
