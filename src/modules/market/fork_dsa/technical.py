"""技术面快照：把「报告生成那一刻」的技术指标原样存进 payload。

为什么必须落库，而不是打开页面时现算
----------------------------------
技术指标每天在变。报告可能是一周前跑的，如果页面打开时才去读行情库，看到的
就是「最新一根日线」—— 用户会以为那就是报告依据的技术面，两者对不上，而且
过几天再打开又是另一套数，无法复现。所以这里把当时读到的 ``tech_*`` 原样存进
``details.technical``：旧报告永远显示旧数据，页面上明确标「数据截至 X」。

口径（三条，别改）
----------------
1. 全部取自 ``snapshot['tech']``，也就是库里 ``stock_daily.tech_*`` 那一行 ——
   与全市场表的技术面徽章同源，不是另算一套。
2. ``asof`` 是**日线基准日**（已收盘的那根），不是报告生成时间。``captured_at``
   才是报告生成时间。两者不同时前端要分别显示。
3. 评分永远基于 ``bar_close``（收盘价）：库里的 ``tech_score`` 就是用那根收盘算的。
   盘中时 ``price`` 会与 ``bar_close`` 不同，但**不拿现价重算评分** —— 重算会与库
   里的分数不一致，同一只票在两个页面显示两个分。

``support`` / ``resistance`` 在 ``data.load_market_snapshot`` 里已经按当日
``adj_factor`` 还原到不复权空间，这里直接用，不再除一次。
"""

from __future__ import annotations

import datetime as _dt
import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# 与 ``stock_daily.tech_*`` 的状态字符串一一对应；缺一项就当该项没有数据
_TECH_STATUS_KEYS = ("trend", "macd", "rsi", "kdj", "boll", "volume")


def _f(value: Any) -> Optional[float]:
    """Decimal/str/None → float；非数字给 None（给 0 会被读成真实值）。"""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _i(value: Any) -> Optional[int]:
    f = _f(value)
    return None if f is None else int(round(f))


def build(snapshot: dict[str, Any]) -> dict[str, Any]:
    """行情快照 → 可落库的技术面块。

    ``available=False`` 只表示「这只票没有技术指标」（新股 / 日线不足 120 根），
    不是取数失败 —— 页面据此显示「数据不足」，而不是把 0 分当成「观望」。
    """
    tech = snapshot.get("tech") or {}
    score = _i(tech.get("score"))
    statuses = {key: tech.get(key) for key in _TECH_STATUS_KEYS}
    if score is None and not any(statuses.values()):
        return {
            "available": False,
            "code": snapshot.get("code"),
            "asof": snapshot.get("asof"),
            "reason": "这只票没有技术指标（新股或日线不足 120 根）",
            "captured_at": _now(),
        }

    ma = {key: _f(snapshot.get(key)) for key in ("ma5", "ma10", "ma20", "ma60")}
    return {
        "available": True,
        "code": snapshot.get("code"),
        # 日线基准日 vs 报告生成时间：页面上必须分开标，别混成一个「数据截至」
        "asof": snapshot.get("asof"),
        "captured_at": _now(),
        "bar_close": _f(snapshot.get("bar_close")),
        "price": _f(snapshot.get("price")),
        "intraday": bool(snapshot.get("intraday")),
        "quote_time": snapshot.get("quote_time"),
        "score": score,
        **statuses,
        "support": _f(tech.get("support")),
        "resistance": _f(tech.get("resistance")),
        "ma": ma,
        "volume_ratio": _f(snapshot.get("volume_ratio")),
        "high_20": _f(snapshot.get("high_20")),
        "low_20": _f(snapshot.get("low_20")),
        "ret_5d": _f(snapshot.get("ret_5d")),
        "ret_20d": _f(snapshot.get("ret_20d")),
        "ret_60d": _f(snapshot.get("ret_60d")),
        "source": "stock_daily.tech_*",
    }


def _now() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
