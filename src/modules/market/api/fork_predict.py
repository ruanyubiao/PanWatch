"""每日个股预测接口（分析页「模型预测」按钮 / 列表页 / 详情页的数据源）。

路径前缀 ``/api/stocks/predict``。三个页面各一个端点，全部只读 MySQL。

错误契约
--------
==============================  ====  ==========================================
code                            HTTP  触发
==============================  ====  ==========================================
predict_bad_symbol              400   代码不是 6 位数字
predict_beijing_excluded        400   北交所标的（股票池排除）
predict_not_found               404   这只票在预测表里没有任何记录
predict_market_data_unavailable 503   行情库未配置 / 连不上
==============================  ====  ==========================================

「还没有预测数据」不算错误：``/dates``、``/daily`` 返回 200 且 ``available=false``，
页面显示「预测尚未生成」而不是一个红色报错 —— 每天 17:00 同步之前就是这样。
"""

from __future__ import annotations

import logging
import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..fork_predict import data

logger = logging.getLogger(__name__)

router = APIRouter()

_SYMBOL_RE = re.compile(r"^(?:sh|sz|bj)?(\d{6})(?:\.(?:SH|SZ|BJ))?$", re.I)


def _bad(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _normalize(raw: str) -> str:
    match = _SYMBOL_RE.match((raw or "").strip())
    if not match:
        raise _bad(400, "predict_bad_symbol", f"股票代码不合法：{raw}")
    code = match.group(1)
    if code[0] in ("4", "8", "9"):
        raise _bad(400, "predict_beijing_excluded", "北交所标的（bj/8xx/920xxx）不在股票池内")
    return code


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        from ..fork_dsa.data import MarketDataUnavailable

        if isinstance(exc, MarketDataUnavailable):
            raise _bad(503, "predict_market_data_unavailable", str(exc)) from exc
        logger.exception("predict query failed: %s", exc)
        raise _bad(503, "predict_market_data_unavailable", f"读取预测数据失败：{exc}") from exc


@router.get("/predict/dates")
def predict_dates(limit: int = Query(60, ge=1, le=250)):
    """有预测的交易日（新→旧）+ 当前启用的模型版本。"""
    payload = _guard(data.available_dates, limit)
    payload["model"] = _guard(data.model_info)
    return payload


@router.get("/predict/daily")
def predict_daily(
    date: Optional[str] = Query(None, description="YYYY-MM-DD；不传 = 最新有预测的交易日"),
    limit: int = Query(data.DEFAULT_LIST_LIMIT, ge=1, le=data.MAX_LIST_LIMIT),
    offset: int = Query(0, ge=0),
):
    """某一天的横截面预测，按名次升序（1 = 最看好）。"""
    return _guard(data.load_daily, date, limit, offset)


@router.get("/predict/scores")
def predict_scores(date: Optional[str] = Query(None)):
    """全市场「代码 → 名次/分位」，给分析页表格那一列用。"""
    return _guard(data.load_scores, date)


@router.get("/predict/stock/{symbol}")
def predict_stock(symbol: str, days: int = Query(data.DEFAULT_HISTORY_DAYS, ge=1, le=250)):
    """个股预测详情：最新一条 + 近 N 个交易日的名次。"""
    code = _normalize(symbol)
    payload = _guard(data.load_stock, code, days)
    if not payload:
        raise _bad(404, "predict_not_found", f"{code} 在预测表里没有记录（可能未进入股票池）")
    return payload
