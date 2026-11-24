"""模型预测读取层（个股预测模型 → 分析页「模型预测」列 / 预测列表页）。

本包**只读**，不训练、不推理：预测由 A 股管道在每日同步后写入 MySQL 的
``stock_predict_daily``（模型在管道那边训练，见 stockcloud/pipeline 的
``lib/predict/``），PanWatch 这边只负责把结果读出来给页面看。

为什么不在这里再算一遍
----------------------
推理要用 73 列特征面板（约 1080 万行）与 lightgbm，云上是 4C4G 且常驻着
PanWatch，跑不动；更重要的是「两个地方各算一遍」必然漂移，页面上看到的分数
就不再是库里那一列。所以口径唯一：**库里有数就显示，没数就说没数**。
"""

from __future__ import annotations

import datetime as _dt
import logging
from typing import Any, Optional

# 复用「深度分析2」的只读连接（同一套 STOCK_DB_RO_* 凭据，systemd 注入）。
# 这两个是 fork_dsa.data 的私有函数，但同样是 fork 自有代码，不再复制一份环境
# 变量解析逻辑 —— 两份配置解析迟早会漂移。
from ..fork_dsa.data import MarketDataUnavailable, _connect  # noqa: PLC2701

logger = logging.getLogger(__name__)

DEFAULT_LIST_LIMIT = 200
MAX_LIST_LIMIT = 500
DEFAULT_HISTORY_DAYS = 60

#: 表不存在（1146）= 预测还没跑过 / 还没建表。对页面来说等同于「暂无预测」，
#: 不该报 500 —— 本地开发库就是这种情况。
_ER_NO_SUCH_TABLE = 1146


def _is_missing_table(exc: Exception) -> bool:
    args = getattr(exc, "args", ())
    return bool(args) and args[0] == _ER_NO_SUCH_TABLE


def _f(value: Any) -> Optional[float]:
    """Decimal/str/None → float；非数字给 None（别给 0，0 会被当成真实值）。"""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _d(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.strftime("%Y-%m-%d")
    return str(value)[:10]


def _ts(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    return str(value)


def _rows(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return list(cur.fetchall() or [])
    finally:
        conn.close()


def _row(sql: str, params: tuple = ()) -> Optional[dict[str, Any]]:
    rows = _rows(sql, params)
    return rows[0] if rows else None


# ── 交易日 / 模型账本 ─────────────────────────────────────────────────────


def available_dates(limit: int = 60) -> dict[str, Any]:
    """有预测的交易日，新→旧。表不存在时 ``available=False``（页面显示暂无）。"""
    try:
        rows = _rows(
            "SELECT trade_date, COUNT(*) AS n, MAX(model_version) AS v, MAX(scored_at) AS t "
            "FROM stock_predict_daily GROUP BY trade_date ORDER BY trade_date DESC LIMIT %s",
            (max(1, min(int(limit), 250)),),
        )
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return {"available": False, "dates": [], "latest": None}
        raise
    dates = [
        {
            "trade_date": _d(r.get("trade_date")),
            "count": int(r.get("n") or 0),
            "model_version": r.get("v"),
            "scored_at": _ts(r.get("t")),
        }
        for r in rows
    ]
    return {"available": bool(dates), "dates": dates, "latest": dates[0]["trade_date"] if dates else None}


def latest_date() -> Optional[str]:
    return available_dates(1).get("latest")


def model_info() -> Optional[dict[str, Any]]:
    """当前启用的模型版本（账本表 ``stock_predict_model``）。"""
    try:
        row = _row(
            "SELECT version, trained_at, best_iter, n_features, label_def, metrics_json "
            "FROM stock_predict_model WHERE is_active = 1 ORDER BY trained_at DESC LIMIT 1"
        )
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return None
        raise
    if not row:
        return None
    metrics = row.get("metrics_json")
    if isinstance(metrics, (bytes, bytearray)):
        metrics = metrics.decode("utf-8", "ignore")
    return {
        "version": row.get("version"),
        "trained_at": _ts(row.get("trained_at")),
        "best_iter": row.get("best_iter"),
        "n_features": row.get("n_features"),
        "label_def": row.get("label_def"),
        "metrics": metrics,
    }


# ── 每日列表 ─────────────────────────────────────────────────────────────


def load_daily(
    trade_date: Optional[str] = None, limit: int = DEFAULT_LIST_LIMIT, offset: int = 0
) -> dict[str, Any]:
    """某一天的横截面预测，按名次升序（1 = 最看好）。"""
    date = (trade_date or "").strip() or latest_date()
    if not date:
        return {"available": False, "trade_date": None, "total": 0, "items": []}
    lim = max(1, min(int(limit), MAX_LIST_LIMIT))
    off = max(0, int(offset))
    try:
        rows = _rows(
            "SELECT p.rank_no, p.symbol, p.code, p.score, p.pct, p.amt_med20, "
            "p.model_version, p.scored_at, i.name AS name "
            "FROM stock_predict_daily p LEFT JOIN stock_info i ON i.code = p.code "
            "WHERE p.trade_date = %s ORDER BY p.rank_no ASC LIMIT %s OFFSET %s",
            (date, lim, off),
        )
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return {"available": False, "trade_date": date, "total": 0, "items": []}
        raise
    total = 0
    head: Optional[dict[str, Any]] = None
    try:
        head = _row(
            "SELECT COUNT(*) AS n, MAX(model_version) AS v, MAX(scored_at) AS t "
            "FROM stock_predict_daily WHERE trade_date = %s",
            (date,),
        )
        total = int((head or {}).get("n") or 0)
    except Exception:  # noqa: BLE001 - 计数失败不影响列表
        total = len(rows)
    items = [
        {
            "rank_no": int(r.get("rank_no") or 0),
            "symbol": r.get("symbol"),
            "code": r.get("code"),
            "name": r.get("name") or "",
            "score": _f(r.get("score")),
            "pct": _f(r.get("pct")),
            "amt_med20": _f(r.get("amt_med20")),
        }
        for r in rows
    ]
    return {
        "available": bool(items),
        "trade_date": date,
        "total": total,
        "offset": off,
        "model_version": (head or {}).get("v") if total else None,
        "scored_at": _ts((head or {}).get("t")),
        "items": items,
    }


def load_scores(trade_date: Optional[str] = None) -> dict[str, Any]:
    """全市场「代码 → 名次/分位」，给分析页表格那一列用（一次取完，不逐行请求）。"""
    date = (trade_date or "").strip() or latest_date()
    if not date:
        return {"available": False, "trade_date": None, "scores": {}}
    try:
        rows = _rows(
            "SELECT code, rank_no, pct FROM stock_predict_daily WHERE trade_date = %s",
            (date,),
        )
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return {"available": False, "trade_date": date, "scores": {}}
        raise
    scores: dict[str, dict[str, Any]] = {}
    for r in rows:
        code = r.get("code")
        if not code:
            continue
        scores[str(code)] = {"rank_no": int(r.get("rank_no") or 0), "pct": _f(r.get("pct"))}
    return {"available": bool(scores), "trade_date": date, "scores": scores}


# ── 个股详情 ─────────────────────────────────────────────────────────────


def load_stock(code: str, days: int = DEFAULT_HISTORY_DAYS) -> Optional[dict[str, Any]]:
    """个股：最新一条 + 近 N 个交易日的名次曲线。全无记录时 ``None``。"""
    n = max(1, min(int(days), 250))
    try:
        latest = _row(
            "SELECT p.trade_date, p.rank_no, p.score, p.pct, p.amt_med20, p.model_version, "
            "p.scored_at, i.name AS name, i.exchange AS exchange "
            "FROM stock_predict_daily p LEFT JOIN stock_info i ON i.code = p.code "
            "WHERE p.code = %s ORDER BY p.trade_date DESC LIMIT 1",
            (code,),
        )
        if not latest:
            return None
        history = _rows(
            "SELECT trade_date, rank_no, pct FROM stock_predict_daily "
            "WHERE code = %s ORDER BY trade_date DESC LIMIT %s",
            (code, n),
        )
        day_total = _row(
            "SELECT COUNT(*) AS n FROM stock_predict_daily WHERE trade_date = %s",
            (_d(latest.get("trade_date")),),
        )
    except Exception as exc:  # noqa: BLE001
        if _is_missing_table(exc):
            return None
        raise
    return {
        "code": code,
        "symbol": None,
        "name": latest.get("name") or "",
        "exchange": latest.get("exchange"),
        "trade_date": _d(latest.get("trade_date")),
        "rank_no": int(latest.get("rank_no") or 0),
        "universe": int((day_total or {}).get("n") or 0),
        "score": _f(latest.get("score")),
        "pct": _f(latest.get("pct")),
        "amt_med20": _f(latest.get("amt_med20")),
        "model_version": latest.get("model_version"),
        "scored_at": _ts(latest.get("scored_at")),
        "history": [
            {
                "trade_date": _d(h.get("trade_date")),
                "rank_no": int(h.get("rank_no") or 0),
                "pct": _f(h.get("pct")),
            }
            for h in reversed(history)  # 页面按时间从左到右画
        ],
        "model": model_info(),
    }
