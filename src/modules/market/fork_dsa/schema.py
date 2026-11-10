"""报告解析与归一化：LLM 的 JSON → 五段结构（meta / summary / strategy / details）。

为什么要「宽松解析 + 二次兜底」
------------------------------
小模型经常：套 ```json 围栏、在 JSON 前后加一句「好的，以下是分析」、把
``sniper_points`` 写成字符串、把 ``sentiment_score`` 写成 "42分"。直接
``json.loads`` 会整份失败，而失败一次就白等两分钟。这里做三件事：

1. 剥围栏 / 截取第一个 ``{`` 到最后一个 ``}`` 再解析；
2. 字段级容错：数字能转就转、列表能拆就拆、缺失给 None（不用 0 冒充）；
3. 语义兜底：``sentiment_label`` 缺失时按分数推档（与页面文案一致），
   ``strategy`` 缺失时从 ``dashboard.battle_plan`` 回填。

字段名与 DSA 保持一致是刻意的：前端按 ``meta/summary/strategy/details`` 取数，
改名要两边一起改。
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional


class ReportParseError(ValueError):
    """模型没给出可解析的 JSON。"""


_SENTIMENT_BANDS = (
    (25, "极度恐惧"),
    (40, "恐惧"),
    (60, "中性"),
    (75, "贪婪"),
    (101, "极度贪婪"),
)


def sentiment_label(score: Optional[float]) -> Optional[str]:
    if score is None:
        return None
    for bound, label in _SENTIMENT_BANDS:
        if score < bound:
            return label
    return "极度贪婪"


def _as_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[^0-9.\-]", "", value)
        if cleaned in ("", "-", "."):
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _as_int(value: Any) -> Optional[int]:
    number = _as_float(value)
    if number is None:
        return None
    return max(0, min(100, int(round(number))))


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        for key in ("text", "value", "description", "reason"):
            if isinstance(value.get(key), str) and value[key].strip():
                return value[key].strip()
        return None
    if isinstance(value, list):
        joined = "；".join(x for x in (_as_str(v) for v in value) if x)
        return joined or None
    return None


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [p.strip() for p in re.split(r"[\n;；]+", value) if p.strip()]
        return parts
    if isinstance(value, list):
        out = []
        for item in value:
            text = _as_str(item)
            if text:
                out.append(text)
        return out
    return []


def _strip_fence(text: str) -> str:
    text = text.strip()
    # ```json ... ``` / ``` ... ```
    fence = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    return text


def parse_llm_json(text: str) -> dict[str, Any]:
    if not text or not text.strip():
        raise ReportParseError("模型返回为空")
    cleaned = _strip_fence(text)
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise ReportParseError(f"模型返回不是合法 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise ReportParseError("模型返回的 JSON 顶层不是对象")
    return data


def normalize(
    raw: dict[str, Any],
    *,
    meta: dict[str, Any],
    sectors: list[str],
    limitations: list[str],
    fallback_name: Optional[str] = None,
) -> dict[str, Any]:
    """把模型输出摊平成前端要用的五段结构。``meta`` 由服务层给（价格、时间、模型名）。"""
    dashboard = _as_dict(raw.get("dashboard"))
    core = _as_dict(dashboard.get("core_conclusion"))
    battle = _as_dict(dashboard.get("battle_plan"))
    sniper = _as_dict(battle.get("sniper_points"))
    position = _as_dict(battle.get("position_strategy"))
    intelligence = _as_dict(dashboard.get("intelligence"))
    position_advice_raw = core.get("position_advice")
    position_advice = (
        {k: _as_str(v) for k, v in position_advice_raw.items()}
        if isinstance(position_advice_raw, dict)
        else {}
    )

    score = _as_int(raw.get("sentiment_score"))
    operation = _as_str(raw.get("operation_advice"))
    action_label = _as_str(raw.get("action_label")) or operation

    summary = {
        "analysis_summary": _as_str(raw.get("analysis_summary"))
        or _as_str(core.get("one_sentence")),
        "operation_advice": operation,
        "action": _as_str(raw.get("action")),
        "action_label": action_label,
        "trend_prediction": _as_str(raw.get("trend_prediction")),
        "sentiment_score": score,
        "sentiment_label": _as_str(raw.get("sentiment_label")) or sentiment_label(score),
        "confidence_level": _as_str(raw.get("confidence_level")),
        "decision_type": _as_str(raw.get("decision_type")),
        "guardrail_reason": _as_str(raw.get("guardrail_reason")),
        "key_points": _as_str(raw.get("key_points")),
        "risk_warning": _as_str(raw.get("risk_warning")),
        "one_sentence": _as_str(core.get("one_sentence")),
        "signal_type": _as_str(core.get("signal_type")),
        "time_sensitivity": _as_str(core.get("time_sensitivity")),
        "position_advice": position_advice,
    }

    # 狙击点位：优先 battle_plan，缺失时退回 strategy 顶层（DSA 的历史报告两种都有）
    strategy = {
        "ideal_buy": _as_str(sniper.get("ideal_buy")) or _as_str(raw.get("ideal_buy")),
        "secondary_buy": _as_str(sniper.get("secondary_buy")) or _as_str(raw.get("secondary_buy")),
        "stop_loss": _as_str(sniper.get("stop_loss")) or _as_str(raw.get("stop_loss")),
        "take_profit": _as_str(sniper.get("take_profit")) or _as_str(raw.get("take_profit")),
        "suggested_position": _as_str(position.get("suggested_position")),
        "entry_plan": _as_str(position.get("entry_plan")),
        "risk_control": _as_str(position.get("risk_control")),
        "action_checklist": _as_list(battle.get("action_checklist")),
    }

    details = {
        "sectors": sectors,
        "sector_view": _as_str(raw.get("sector_view")),
        "latest_news": _as_str(intelligence.get("latest_news")),
        "risk_alerts": _as_list(intelligence.get("risk_alerts")),
        "positive_catalysts": _as_list(intelligence.get("positive_catalysts")),
        "sentiment_summary": _as_str(intelligence.get("sentiment_summary")),
        "limitations": limitations,
    }

    normalized_meta = dict(meta)
    normalized_meta["stock_name"] = (
        _as_str(raw.get("stock_name")) or normalized_meta.get("stock_name") or fallback_name
    )

    return {
        "meta": normalized_meta,
        "summary": summary,
        "strategy": strategy,
        "details": details,
        "structured_report": raw,
    }
