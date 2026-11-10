"""fork: DSA 风格报告（深度分析2）—— 解析、取数拼装、任务状态机。

这些测试钉住四件线上真会出错的事：

1. **北交所必须拒绝**（用户口径：不交易 bj），而不是默默分析；
2. **模型输出的容错**：代码块围栏、字符串数字、sniper_points 缺失要走兜底；
3. **数据缺口必须写进报告**，不能被当成「已确认无风险」；
4. **失败不能留 running**：线程里任何异常都要落成 failed，否则页面永远转圈。
"""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from src.modules.market.api import fork_dsa
from src.modules.market.fork_dsa import prompt as prompt_mod
from src.modules.market.fork_dsa import schema, service, store


# ── 代码归一化 ───────────────────────────────────────────────────────────


def test_symbol_accepts_three_spellings():
    """三种写法都归一成 6 位代码"""
    assert fork_dsa._normalize_symbol("002256") == "002256"
    assert fork_dsa._normalize_symbol("sz002256") == "002256"
    assert fork_dsa._normalize_symbol("002256.SZ") == "002256"
    assert fork_dsa._normalize_symbol(" 600519 ") == "600519"


def test_symbol_rejects_beijing_and_garbage():
    """北交所与非法代码要明确报错，不是照跑"""
    with pytest.raises(HTTPException) as bj:
        fork_dsa._normalize_symbol("920025")
    assert bj.value.status_code == 400
    assert bj.value.detail["code"] == "dsa_beijing_excluded"

    with pytest.raises(HTTPException) as bad:
        fork_dsa._normalize_symbol("60051")
    assert bad.value.detail["code"] == "dsa_bad_symbol"


# ── 解析与归一化 ─────────────────────────────────────────────────────────


def _raw_report(**over):
    base = {
        "stock_name": "浦发银行",
        "sentiment_score": "42分",
        "trend_prediction": "看空",
        "operation_advice": "观望",
        "action": "watch",
        "confidence_level": "中",
        "dashboard": {
            "core_conclusion": {
                "one_sentence": "空头排列，观望",
                "signal_type": "🟡持有观望",
                "position_advice": {"no_position": "不买", "has_position": "减仓"},
            },
            "intelligence": {
                "latest_news": "无可用新闻数据",
                "risk_alerts": ["风险点1：缩量"],
                "positive_catalysts": [],
            },
            "battle_plan": {
                "sniper_points": {
                    "ideal_buy": "9.10元（回踩MA20）",
                    "secondary_buy": "8.90元",
                    "stop_loss": "8.60元",
                    "take_profit": "10.20元",
                },
                "action_checklist": ["❌ 检查项1：均线空头"],
            },
        },
        "analysis_summary": "缩量下行，均线压制。",
    }
    base.update(over)
    return base


def _meta():
    return {
        "stock_code": "600000",
        "stock_name": "浦发银行",
        "current_price": 9.5,
        "change_pct": -0.8,
        "asof": "2026-11-10",
        "created_at": "2026-11-10T16:00:00",
        "market_phase": "postmarket",
        "report_type": "dsa2",
    }


def test_parse_strips_code_fence_and_chatter():
    """模型加了围栏和前后废话也要能解析"""
    text = "好的，分析如下：\n```json\n" + json.dumps(_raw_report(), ensure_ascii=False) + "\n```\n以上。"
    parsed = schema.parse_llm_json(text)
    assert parsed["stock_name"] == "浦发银行"


def test_parse_rejects_non_json():
    """没有 JSON 就报错，不猜"""
    with pytest.raises(schema.ReportParseError):
        schema.parse_llm_json("抱歉，我无法完成这次分析。")


def test_normalize_tolerates_string_score_and_fills_strategy():
    """\"42分\"→42，sentiment_label 按分数推档，狙击点位进 strategy"""
    report = schema.normalize(
        _raw_report(), meta=_meta(), sectors=["银行", "上海板块"], limitations=["新闻面未纳入"]
    )
    assert report["summary"]["sentiment_score"] == 42
    assert report["summary"]["sentiment_label"] == "中性"
    assert report["strategy"]["ideal_buy"].startswith("9.10元")
    assert report["strategy"]["stop_loss"] == "8.60元"
    assert report["details"]["sectors"] == ["银行", "上海板块"]
    assert report["details"]["limitations"] == ["新闻面未纳入"]
    assert report["summary"]["position_advice"]["no_position"] == "不买"


def test_normalize_survives_empty_dashboard():
    """dashboard 整段缺失时也要出结构完整的报告（页面不炸）"""
    report = schema.normalize(
        {"stock_name": "X", "operation_advice": "观望"},
        meta=_meta(),
        sectors=[],
        limitations=[],
    )
    assert report["summary"]["operation_advice"] == "观望"
    assert report["strategy"]["ideal_buy"] is None
    assert report["details"]["risk_alerts"] == []
    assert report["details"]["sectors"] == []


def test_normalize_clamps_score_and_derives_label():
    """分数越界被夹到 0-100；档位文案与页面一致"""
    report = schema.normalize(
        _raw_report(sentiment_score=140), meta=_meta(), sectors=[], limitations=[]
    )
    assert report["summary"]["sentiment_score"] == 100
    assert report["summary"]["sentiment_label"] == "极度贪婪"
    assert schema.sentiment_label(12) == "极度恐惧"
    assert schema.sentiment_label(None) is None


# ── 提示词 ───────────────────────────────────────────────────────────────


def _snapshot():
    return {
        "available": True,
        "code": "600000",
        "name": "浦发银行",
        "asof": "2026-11-10",
        "price": 9.5,
        "open": 9.6,
        "high": 9.7,
        "low": 9.4,
        "pre_close": 9.58,
        "change_pct": -0.83,
        "amount": 1.2e9,
        "turnover_rate": 0.62,
        "volume_ratio": 0.73,
        "pe_ttm": 5.6,
        "pb": 0.5,
        "total_market_cap": 2.9e11,
        "circulating_market_cap": 2.9e11,
        "ma5": 9.61,
        "ma10": 9.7,
        "ma20": 9.82,
        "ma60": 10.1,
        "ma_alignment": "空头排列",
        "bias_ma5": -1.14,
        "high_20": 10.4,
        "low_20": 9.3,
        "ret_5d": -1.2,
        "ret_20d": -4.5,
        "ret_60d": -8.1,
        "tech": {"trend": "空头", "macd": "死叉", "rsi": 31, "support": 9.3, "resistance": 9.9},
    }


def test_prompt_marks_missing_sections_explicitly():
    """缺口必须写成「未纳入」，不能留空让模型自由发挥"""
    text = prompt_mod.build_user_prompt(
        snapshot=_snapshot(),
        phase={"phase": "postmarket", "label": "盘后", "market_local_time": "2026-11-10 16:00", "calendar": "db"},
        boards={"available": False, "reason": "板块数据不可用"},
        flow={"available": False, "reason": "资金流不可用"},
        news={"available": False, "reason": "没有搜到相关新闻"},
        limitations=["新闻面未纳入（东财新闻搜索无结果或不可用）"],
    )
    assert "未纳入" in text
    assert "新闻面未纳入" in text
    assert "9.50" in text  # 现价给到两位小数
    assert "空头排列" in text
    assert "日线口径近似" in text


# ── 任务状态机 ───────────────────────────────────────────────────────────


def test_store_lifecycle():
    """create → finish → latest 读得回来，失败落 failed"""
    row_id = store.create("600000", "浦发银行")
    running = store.latest("600000")
    assert running and running["status"] == "running"

    store.finish(row_id, {"meta": {"stock_name": "浦发银行"}}, "test/model")
    done = store.latest("600000")
    assert done and done["status"] == "done"
    assert done["report"]["meta"]["stock_name"] == "浦发银行"
    assert done["model_used"] == "test/model"

    failed_id = store.create("600001", "X")
    store.fail(failed_id, "boom")
    assert store.get(failed_id)["status"] == "failed"
    assert store.latest_done("600001") is None


def test_worker_failure_marks_failed_not_running(monkeypatch):
    """线程里取数失败 → failed，页面不会永远转圈"""

    def boom(*args, **kwargs):
        raise RuntimeError("行情库炸了")

    monkeypatch.setattr(service, "_collect", boom)
    row_id = store.create("600002", "Y")
    service._worker("600002", "Y", None, row_id)
    row = store.get(row_id)
    assert row and row["status"] == "failed"
    assert "行情库炸了" in (row["error"] or "")


def test_worker_success_writes_report(monkeypatch):
    """正常路径：模型输出落成五段结构，板块标签进 details.sectors"""

    monkeypatch.setattr(
        service,
        "_collect",
        lambda symbol, name: {
            "snapshot": _snapshot(),
            "boards": {"available": True, "tags": ["银行", "上海板块"]},
            "flow": {"available": True, "latest": {"main_net": -1.0e7, "main_net_pct": -0.8}},
            "news": {"available": False, "reason": "没有搜到相关新闻"},
            "phase": {"phase": "postmarket", "label": "盘后", "market_local_time": "x", "calendar": "db"},
            "limitations": ["新闻面未纳入"],
        },
    )
    monkeypatch.setattr(service, "_run_model", lambda collected, *, db, model_id: (dict(_raw_report()), "fake/model"))
    row_id = store.create("600003", "浦发银行")
    service._worker("600003", "浦发银行", None, row_id)
    row = store.get(row_id)
    assert row and row["status"] == "done"
    report = row["report"]
    assert report["meta"]["stock_code"] == "600003"
    assert report["details"]["sectors"] == ["银行", "上海板块"]
    assert report["details"]["limitations"] == ["新闻面未纳入"]
    assert report["summary"]["operation_advice"] == "观望"


def test_start_reuses_running_task(monkeypatch):
    """同一只票连点两次不重复起任务（不重复烧 token）"""
    monkeypatch.setattr(service.threading, "Thread", lambda **kw: type("T", (), {"start": lambda self: None})())
    first = service.start("600004", "Z")
    second = service.start("600004", "Z")
    assert first["id"] == second["id"]
    running = store.running("600004")
    assert running is not None and running["id"] == first["id"]
