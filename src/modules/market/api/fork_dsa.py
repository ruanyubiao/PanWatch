"""DSA 风格报告接口（「深度分析2」新窗口的数据源）。

路径前缀 ``/api/stocks/dsa``。交互照 DSA 的 ``async_mode``：``POST /analyze`` 立刻
返回 ``{id, status:"running"}``，页面按 ``GET /report/{id}`` 轮询。

错误契约
--------
============================  ====  ==========================================
code                          HTTP  触发
============================  ====  ==========================================
dsa_bad_symbol                400   代码不是 6 位数字 / 北交所标的
dsa_beijing_excluded          400   北交所股票不在股票池内（用户口径）
dsa_report_not_found          404   报告 id 不存在
dsa_market_data_unavailable   503   行情库未配置或连不上
============================  ====  ==========================================
"""

from __future__ import annotations

import logging
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..fork_dsa import data, service, store

logger = logging.getLogger(__name__)

router = APIRouter()

_SYMBOL_RE = re.compile(r"^(?:sh|sz|bj)?(\d{6})(?:\.(?:SH|SZ|BJ))?$", re.I)


def _bad(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _normalize_symbol(raw: str) -> str:
    """``sz002256`` / ``002256.SZ`` / ``002256`` 都收，统一成 6 位代码。"""
    match = _SYMBOL_RE.match((raw or "").strip())
    if not match:
        raise _bad(400, "dsa_bad_symbol", f"股票代码不合法：{raw}")
    code = match.group(1)
    # 北交所（8/9/4 开头，含 920xxx）不在用户股票池内 —— 明确拒绝而不是默默分析
    if code[0] in ("4", "8", "9"):
        raise _bad(400, "dsa_beijing_excluded", "北交所标的（bj/8xx/920xxx）不在股票池内")
    return code


class AnalyzeRequest(BaseModel):
    symbol: str = Field(..., description="6 位代码，支持 sz002256 / 002256.SZ")
    name: Optional[str] = None
    model_id: Optional[int] = None


@router.post("/dsa/analyze")
def analyze(req: AnalyzeRequest):
    """起一次分析（后台线程）。同一只票已有 running 时复用那一份，不重复烧 token。"""
    code = _normalize_symbol(req.symbol)
    try:
        row = service.start(code, req.name, req.model_id)
    except data.MarketDataUnavailable as exc:
        raise _bad(503, "dsa_market_data_unavailable", str(exc)) from exc
    return {
        "id": row["id"],
        "symbol": row["symbol"],
        "status": row["status"],
        "created_at": row["created_at"],
        "report": row.get("report"),
        "error": row.get("error"),
    }


@router.get("/dsa/report/{report_id}")
def get_report(report_id: int):
    row = store.get(report_id)
    if not row:
        raise _bad(404, "dsa_report_not_found", f"报告 {report_id} 不存在")
    return row


@router.get("/dsa/latest")
def get_latest(symbol: str = Query(...)):
    """该标的最新一份（包含 running/failed），页面进来先读它决定是否要起新任务。"""
    code = _normalize_symbol(symbol)
    row = store.latest(code)
    if not row:
        return {"id": None, "symbol": code, "status": "none", "report": None}
    return row


@router.get("/dsa/history")
def get_history(symbol: str = Query(...), limit: int = Query(20, ge=1, le=100)):
    code = _normalize_symbol(symbol)
    return {"symbol": code, "items": store.history(code, limit)}
