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

from ..fork_dsa import data, service, store, technical as technical_mod

logger = logging.getLogger(__name__)

router = APIRouter()

_SYMBOL_RE = re.compile(r"^(?:sh|sz|bj)?(\d{6})(?:\.(?:SH|SZ|BJ))?$", re.I)
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
    """入队一次深度分析（单线程 FIFO 队列，与 PanWatch 分析队列无关）。

    立刻返回，``status`` 可能是 ``queued``（前面有任务）或 ``running``；
    ``queue_position`` 是等待位次（0 = 直接开跑）。
    """
    code = _normalize_symbol(req.symbol)
    try:
        row = service.start(code, req.name, req.model_id)
    except data.MarketDataUnavailable as exc:
        raise _bad(503, "dsa_market_data_unavailable", str(exc)) from exc
    return {
        "id": row["id"],
        "symbol": row["symbol"],
        "status": row["status"],
        "created_at": row.get("created_at"),
        "started_at": row.get("started_at"),
        "queue_position": row.get("queue_position", 0),
        "report": row.get("report"),
        "error": row.get("error"),
    }


@router.get("/dsa/queue")
def get_queue():
    """队列快照：第一个是正在运行的，后面是等待中的（页面「队列」按钮读这个）。"""
    items = service.queue_list()
    return {
        "items": items,
        "running": next((item for item in items if item["status"] == "running"), None),
        "pending": sum(1 for item in items if item["status"] == "queued"),
    }


@router.delete("/dsa/queue/{report_id}")
def delete_queue_item(report_id: int):
    """删除队列项。

    排队中 → 整行删掉；运行中 → 标 cancelled，**结果丢弃**。注意当前这一轮
    已经在跑的取数与模型调用无法中断，线程会跑完才轮到下一个（单消费者队列）。
    """
    outcome = service.cancel(report_id)
    if outcome is None:
        raise _bad(404, "dsa_queue_not_found", f"任务 {report_id} 不在队列里")
    return {"id": report_id, "outcome": outcome}


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


@router.get("/dsa/technical")
def get_technical(symbol: str = Query(...), asof: Optional[str] = Query(None)):
    """按「报告基准日」复原技术面 —— 只有旧报告（没存 technical 块）才调。

    为什么要有这个口子：技术面块是这一版才加进 payload 的，之前跑的报告没有。
    直接拿今天的技术面去补旧报告是错的（用户口径：报告 3 天前跑的，今天打开
    不能给今天的数据）。所以按报告自己的 ``bar_asof`` 只读到那一天为止的日线，
    读到的是**那一根已收盘日线**，与当时一致；并且不叠加实时快照。

    返回结构与会落进 ``details.technical`` 的块一致，另加 ``reconstructed=True``，
    页面据此标「按报告基准日复原」而不是「报告内保存」。
    """
    code = _normalize_symbol(symbol)
    asof = (asof or "").strip() or None
    if asof and not _DATE_RE.match(asof):
        raise _bad(400, "dsa_bad_asof", f"日期格式应为 YYYY-MM-DD：{asof}")
    try:
        snapshot = data.load_market_snapshot(code, as_of=asof)
    except data.MarketDataUnavailable as exc:
        raise _bad(503, "dsa_market_data_unavailable", str(exc)) from exc
    if not snapshot.get("available"):
        raise _bad(404, "dsa_technical_unavailable", snapshot.get("reason") or "技术面不可用")
    block = technical_mod.build(snapshot)
    block["reconstructed"] = True
    return block


@router.get("/dsa/history")
def get_history(symbol: str = Query(...), limit: int = Query(20, ge=1, le=100)):
    """这只票的历史报告（只列 ``done``，最新的在前）。

    只回**列表要用的那几个字段**，不回整份 payload —— 20 份报告正文几百 KB，
    历史弹层用不上。``name`` 顺带在这里解析（地址里不带 ``?name=`` 之后，页面
    在还没有报告时靠它显示股票名）。
    """
    code = _normalize_symbol(symbol)
    rows = store.history(code, limit)
    items = []
    for row in rows:
        report = row.get("report") or {}
        meta = report.get("meta") or {}
        summary = report.get("summary") or {}
        items.append(
            {
                "id": row["id"],
                "symbol": row["symbol"],
                "status": row["status"],
                "created_at": row.get("created_at"),
                "started_at": row.get("started_at"),
                "model_used": row.get("model_used"),
                "price": meta.get("current_price"),
                "change_pct": meta.get("change_pct"),
                "asof": meta.get("asof"),
                "advice": summary.get("action_label") or summary.get("operation_advice"),
                "trend": summary.get("trend_prediction"),
                "sentiment_score": summary.get("sentiment_score"),
            }
        )
    return {"symbol": code, "name": data.resolve_name(code), "count": len(items), "items": items}
