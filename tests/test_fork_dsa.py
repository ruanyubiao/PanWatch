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
from src.modules.market.fork_dsa import calendar as calendar_mod
from src.modules.market.fork_dsa import data as dsa_data
from src.modules.market.fork_dsa import prompt as prompt_mod
from src.modules.market.fork_dsa import schema, service, sources, store


@pytest.fixture(autouse=True)
def _clean_queue():
    """每个用例前清空队列里的活跃行。

    ``store`` 落在同一个临时库里，上一个用例留下的 queued/running 会污染
    「队列顺序」「pending 计数」这类断言；已完成的历史报告不动。
    """
    store.init()
    with store._connect() as conn:
        conn.execute("DELETE FROM dsa_reports WHERE status IN ('queued','running')")
    yield




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
    """入队 → 认领 → 完成；started_at 在认领时写下，finish 不会改它"""
    row_id = store.create("600000", "浦发银行")
    queued = store.latest("600000")
    assert queued and queued["status"] == "queued"
    assert queued["started_at"] is None  # 还没开跑，「已用时间」的起点为空

    assert store.mark_running(row_id) is True
    running = store.get(row_id)
    assert running["status"] == "running" and running["started_at"]
    started_at = running["started_at"]

    store.finish(row_id, {"meta": {"stock_name": "浦发银行"}}, "test/model")
    done = store.latest("600000")
    assert done and done["status"] == "done"
    assert done["report"]["meta"]["stock_name"] == "浦发银行"
    assert done["model_used"] == "test/model"
    # 计时起点不能被完成时间覆盖（否则页面刷新后「已用」会跳）
    assert done["started_at"] == started_at

    failed_id = store.create("600001", "X")
    store.mark_running(failed_id)
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


def test_start_enqueues_and_reuses_active(monkeypatch):
    """同一只票连点两次不重复入队（不重复烧 token），返回带队列位次"""
    monkeypatch.setattr(service.queue, "ensure_started", lambda: None)
    first = service.start("600004", "Z")
    second = service.start("600004", "Z")
    assert first["id"] == second["id"]
    assert first["status"] == "queued"  # 单消费者队列：入队时还没开跑
    assert first["queue_position"] == 0


# ── 深度分析2 自有队列（串行 FIFO，与 PanWatch 分析队列无关）──────────────


def test_queue_is_fifo_with_running_first(monkeypatch):
    """队列列表：运行中的永远排第一，其余按入队先后（用户口径）"""
    monkeypatch.setattr(service.queue, "ensure_started", lambda: None)
    a = service.start("600010", "A")
    b = service.start("600011", "B")
    c = service.start("600012", "C")
    assert [row["symbol"] for row in service.queue_list()] == ["600010", "600011", "600012"]

    store.mark_running(b["id"])
    rows = service.queue_list()
    assert rows[0]["symbol"] == "600011" and rows[0]["queue_position"] == 0
    assert [row["symbol"] for row in rows[1:]] == ["600010", "600012"]
    # 位次含「正在跑的那个」：a 前面只有 b（1），c 前面有 b + a（2）
    assert rows[1]["queue_position"] == 1
    assert rows[2]["queue_position"] == 2


def test_queue_delete_removes_queued_and_cancels_running(monkeypatch):
    """排队中删除 = 删行；运行中删除 = 标 cancelled，迟到的结果必须丢弃"""
    monkeypatch.setattr(service.queue, "ensure_started", lambda: None)
    queued = service.start("600020", "D")
    running = service.start("600021", "E")

    assert service.cancel(queued["id"]) == "deleted"
    assert store.get(queued["id"]) is None

    store.mark_running(running["id"])
    assert service.cancel(running["id"]) == "cancelled"
    store.finish(running["id"], {"meta": {}}, "x")  # 线程回来时才发现被取消
    assert store.get(running["id"])["status"] == "cancelled"
    assert service.cancel(running["id"]) is None  # 已不在队列，接口据此报 404


def test_worker_skips_job_deleted_while_queued(monkeypatch):
    """排队期间被删掉的任务不能再偷偷开跑（不烧一次 token）"""
    calls = {"n": 0}

    def spy(*args, **kwargs):
        calls["n"] += 1
        return {}

    monkeypatch.setattr(service, "_collect", spy)
    row_id = store.create("600030", "F")
    store.cancel(row_id)
    service._worker("600030", "F", None, row_id)
    assert calls["n"] == 0


def test_recover_requeues_interrupted_running(monkeypatch):
    """进程重启后遗留的 running 退回 queued，队列接着跑（任务不丢）"""
    row_id = store.create("600040", "G")
    store.mark_running(row_id)
    assert store.recover_stale() >= 1
    row = store.get(row_id)
    assert row["status"] == "queued" and row["started_at"] is None


def test_queue_endpoint_lists_running_first_and_deletes(monkeypatch):
    """/dsa/queue 契约：running 单独给出、pending 计数；删除后再点删除报 404"""
    monkeypatch.setattr(service.queue, "ensure_started", lambda: None)
    a = service.start("600050", "H")
    b = service.start("600051", "I")
    store.mark_running(a["id"])

    body = fork_dsa.get_queue()
    assert body["items"][0]["id"] == a["id"]
    assert body["running"]["id"] == a["id"]
    assert body["pending"] == 1

    assert fork_dsa.delete_queue_item(b["id"])["outcome"] == "deleted"
    with pytest.raises(HTTPException) as exc:
        fork_dsa.delete_queue_item(b["id"])
    assert exc.value.status_code == 404


# ── 免 key 数据面（公告 / 两融 / 财联社） ────────────────────────────


def test_module_status_marks_unavailable_sources_without_key():
    """只有真接不到的模块才标 unconfigured；接了但本次没取到标 unavailable"""
    rows = {r["key"]: r for r in sources.module_status({"market": True, "news": True})}
    assert rows["market"]["status"] == "ok"
    assert rows["news"]["status"] == "ok"
    assert rows["boards"]["status"] == "unavailable"  # 接了但本次没取到
    # 研报 / 龙虎榜 / 人气：东财免费接口，接了，不需要 key
    for key in ("research", "billboard", "popularity"):
        assert rows[key]["status"] == "unavailable"
        assert rows[key]["requires_key"] is False
        assert rows[key]["source"]
    # 北向：改用仍每日公布的「十大成交活跃股」（免费、免 key），不再标「未配置」
    assert rows["northbound"]["status"] == "unavailable"  # 接了，但这只票本次没上榜
    assert rows["northbound"]["requires_key"] is False
    assert rows["northbound"]["source"]
    assert "不再披露" in (rows["northbound"]["note"] or "")


def test_module_status_distinguishes_empty_from_failure():
    """「没上榜 / 无覆盖」是 empty，不是「本次未取到」——两者含义完全不同"""
    rows = {r["key"]: r for r in sources.module_status({"research": "empty", "northbound": "empty"})}
    assert rows["research"]["status"] == "empty"
    assert rows["northbound"]["status"] == "empty"
    assert rows["northbound"]["empty_label"] == "未上榜"
    # 接口坏了仍然是 unavailable
    assert {r["key"]: r for r in sources.module_status({"research": False})}["research"]["status"] == "unavailable"



def test_module_status_covers_every_connected_module():
    """每个「有来源」的模块都能被 availability 打开成 ok，不会漏配 key"""
    connected = [r["key"] for r in sources.module_status({}) if r["status"] != "unconfigured"]
    rows = {r["key"]: r for r in sources.module_status({k: True for k in connected})}
    assert all(rows[k]["status"] == "ok" for k in connected)
    assert "margin" in connected and "announcements" in connected and "flash" in connected


def test_announcements_classify_and_shape(monkeypatch):
    """公告：事件分类 + 标题为空的行被丢掉"""
    payload = {
        "data": {
            "list": [
                {"title": "兆新股份:2026年第三次临时股东大会决议公告", "notice_date": "2026-11-08 00:00:00", "art_code": "AN1"},
                {"title": "", "notice_date": "2026-11-07 00:00:00", "art_code": "AN2"},
                {"title": "兆新股份:关于股东减持计划的预披露公告", "notice_date": "2026-11-06 00:00:00", "art_code": "AN3"},
            ]
        }
    }
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    result = sources.load_announcements("002256")
    assert result["available"] is True
    assert [x["event"] for x in result["items"]] == ["公司治理", "减持"]
    assert result["items"][0]["date"] == "2026-11-08"


def test_announcements_failure_is_reported_not_raised(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("东财超时")

    monkeypatch.setattr(sources, "_get_json", boom)
    result = sources.load_announcements("002256")
    assert result["available"] is False
    assert "东财超时" in result["reason"]


def test_margin_not_a_target_is_normal_not_crash(monkeypatch):
    """不在两融标的里是正常情况，不能当异常抛出去"""
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: {"result": {"data": []}})
    result = sources.load_margin("002256")
    assert result["available"] is False
    assert "两融" in result["reason"]


def test_flash_news_prefers_items_mentioning_the_stock(monkeypatch):
    payload = {
        "data": {
            "roll_data": [
                {"title": "两市成交额萎缩", "level": "A", "ctime": 1762600000},
                {"title": "兆新股份中标光伏项目", "level": "C", "ctime": 1762600100, "stock_list": "002256"},
            ]
        }
    }
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    result = sources.load_flash_news("兆新股份")
    assert result["mode"] == "stock"
    assert [x["title"] for x in result["items"]] == ["兆新股份中标光伏项目"]


def test_flash_news_falls_back_to_market_context(monkeypatch):
    """提到不到这只票时只能给大盘背景（mode=market），提示词据此禁止写成个股消息"""
    payload = {"data": {"roll_data": [{"title": "央行开展逆回购", "level": "A", "ctime": 1762600000}]}}
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    result = sources.load_flash_news("兆新股份")
    assert result["mode"] == "market"
    assert result["items"][0]["title"] == "央行开展逆回购"


def test_prompt_carries_new_sections_and_marks_missing():
    text = prompt_mod.build_user_prompt(
        snapshot=_snapshot(),
        phase={"phase": "postmarket", "label": "盘后", "market_local_time": "x", "calendar": "db"},
        boards={"available": True, "tags": ["银行"]},
        flow={"available": True, "latest": {"main_net": -1.0e7, "main_net_pct": -0.8}},
        news={"available": True, "items": [{"date": "2026-11-10", "title": "新闻", "summary": "s"}]},
        limitations=[],
        announcements={"available": True, "items": [{"date": "2026-11-08", "event": "减持", "title": "股东减持"}]},
        margin={"available": True, "date": "2026-11-10", "financing_balance": 3.13e8, "lending_balance": 1000},
        flash={"available": True, "mode": "market", "items": [{"time": "11-10 09:30", "level": "A", "title": "央行逆回购"}]},
    )
    assert "## 公司公告" in text and "股东减持" in text
    assert "## 融资融券" in text and "3.13亿" in text
    assert "## 7×24 快讯" in text and "未提及本股" in text


def test_worker_records_source_panel(monkeypatch):
    """数据源清单要落进 details.sources，页面才有得渲染"""
    monkeypatch.setattr(
        service,
        "_collect",
        lambda symbol, name: {
            "snapshot": _snapshot(),
            "boards": {"available": True, "tags": ["银行"]},
            "flow": {"available": True, "latest": {"main_net": -1.0e7, "main_net_pct": -0.8}},
            "news": {"available": True, "items": []},
            "announcements": {"available": True, "items": []},
            "margin": {"available": False, "reason": "不是两融标的"},
            "flash": {"available": True, "mode": "market", "items": []},
            "phase": {"phase": "postmarket", "label": "盘后", "market_local_time": "x", "calendar": "db"},
            "limitations": [],
            "sources": sources.module_status({"market": True, "boards": True, "margin": False}),
        },
    )
    monkeypatch.setattr(service, "_run_model", lambda collected, *, db, model_id: (dict(_raw_report()), "fake/model"))
    row_id = store.create("600005", "浦发银行")
    service._worker("600005", "浦发银行", None, row_id)
    report = store.get(row_id)["report"]
    panel = {row["key"]: row for row in report["details"]["sources"]}
    assert panel["boards"]["status"] == "ok"
    assert panel["margin"]["status"] == "unavailable"
    assert panel["research"]["status"] == "unavailable"  # 接了、本次没取到
    assert report["details"]["announcements"]["available"] is True


def test_flash_news_tolerates_list_stock_list(monkeypatch):
    """线上财联社的 stock_list 是列表（不是逗号串）—— 曾经在这里抛过 AttributeError"""
    payload = {
        "data": {
            "roll_data": [
                {"title": "兆新股份中标", "level": "B", "ctime": 1762600000, "stock_list": [{"StockID": "002256"}]}
            ]
        }
    }
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    result = sources.load_flash_news("兆新股份")
    assert result["available"] is True
    assert result["items"][0]["stocks"] == ["002256"]


# ── 交易日历：行情库优先，指数快照兜底 ──────────────────────────────


class _FakeCursor:
    def __init__(self, conn):
        self._conn = conn
        self._sql = ""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._sql = sql

    def fetchone(self):
        if "MAX(trade_date)" in self._sql:
            return {"d": self._conn.last}
        return {"x": 1} if self._conn.has else None


class _FakeConn:
    """只回答日历要用的两条 SQL：MAX(trade_date) 与「这天有没有日线」。"""

    def __init__(self, last, has):
        self.last = last
        self.has = has

    def cursor(self):
        return _FakeCursor(self)

    def close(self):
        return None


def _patch_calendar(monkeypatch, *, conn=None, index_day=None, raise_db=False):
    calendar_mod._CACHE.clear()
    if raise_db:
        def boom():
            raise RuntimeError("行情库连不上")

        monkeypatch.setattr(calendar_mod, "_connect", boom)
    else:
        monkeypatch.setattr(calendar_mod, "_connect", lambda: conn)
    monkeypatch.setattr(calendar_mod, "_index_last_trade_date", lambda: index_day)


def test_calendar_reads_trading_days_from_stock_db(monkeypatch):
    """行情库里出现过的日期 = 真实开过市：长假那天没有日线，就该判成休市"""
    import datetime as dt

    _patch_calendar(monkeypatch, conn=_FakeConn(dt.date(2026, 11, 10), False))
    got = calendar_mod.resolve(dt.datetime(2026, 10, 1, 10, 0))
    assert got == {
        "is_trading_day": False,
        "source": "db",
        "last_trade_date": dt.date(2026, 11, 10),
    }

    calendar_mod._CACHE.clear()
    monkeypatch.setattr(calendar_mod, "_connect", lambda: _FakeConn(dt.date(2026, 11, 10), True))
    got = calendar_mod.resolve(dt.datetime(2026, 11, 9, 10, 0))
    assert got["is_trading_day"] is True and got["source"] == "db"


def test_calendar_uses_index_quote_before_eod_load(monkeypatch):
    """今天还没跑采集（库里没有今天）→ 用上证指数快照判定，而不是退回工作日近似"""
    import datetime as dt

    _patch_calendar(
        monkeypatch, conn=_FakeConn(dt.date(2026, 11, 10), False), index_day=dt.date(2026, 11, 11)
    )
    got = calendar_mod.resolve(dt.datetime(2026, 11, 11, 10, 0))
    assert got["is_trading_day"] is True and got["source"] == "live"


def test_calendar_detects_holiday_from_stale_index_quote(monkeypatch):
    """工作日但指数没交易 → 长假休市（这正是「按工作日近似」出错的地方）"""
    import datetime as dt

    _patch_calendar(
        monkeypatch, conn=_FakeConn(dt.date(2026, 9, 30), False), index_day=dt.date(2026, 9, 30)
    )
    got = calendar_mod.resolve(dt.datetime(2026, 10, 1, 10, 0))
    assert got["is_trading_day"] is False and got["source"] == "live"


def test_calendar_marks_approx_only_when_both_sources_fail(monkeypatch):
    import datetime as dt

    _patch_calendar(monkeypatch, raise_db=True, index_day=None)
    got = calendar_mod.resolve(dt.datetime(2026, 11, 11, 10, 0))
    assert got["source"] == "approx" and got["is_trading_day"] is True

    calendar_mod._CACHE.clear()
    got = calendar_mod.resolve(dt.datetime(2026, 11, 15, 10, 0))  # 周日
    assert got["is_trading_day"] is False


def test_market_phase_reports_calendar_source(monkeypatch):
    import datetime as dt

    _patch_calendar(monkeypatch, conn=_FakeConn(dt.date(2026, 11, 10), True))
    phase = dsa_data.market_phase(dt.datetime(2026, 11, 9, 10, 0))
    assert phase["calendar"] == "db"
    assert phase["label"] == "盘中"
    assert phase["last_trade_date"] == "2026-11-10"

    calendar_mod._CACHE.clear()
    monkeypatch.setattr(calendar_mod, "_connect", lambda: _FakeConn(dt.date(2026, 11, 10), False))
    phase = dsa_data.market_phase(dt.datetime(2026, 10, 1, 10, 0))
    assert phase["is_trading_day"] is False
    assert phase["label"] == "非交易日"


# ── 研报 / 龙虎榜 / 人气（全部免 key）───────────────────────────────


def test_research_parses_rating_and_target_price(monkeypatch):
    payload = {
        "hits": 2,
        "data": [
            {
                "publishDate": "2026-11-10 00:00:00.000",
                "orgSName": "西南证券",
                "title": "三季报点评",
                "emRatingName": "买入",
                "indvAimPriceT": "12.5",
                "predictThisYearPe": "20.3",
            },
            {
                "publishDate": "2026-10-01 00:00:00.000",
                "orgSName": "中信证券",
                "title": "首次覆盖",
                "emRatingName": "增持",
                "indvAimPriceT": "",
                "predictThisYearPe": None,
            },
        ],
    }
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    got = sources.load_research("600519")
    assert got["available"] is True and got["hits"] == 2
    assert got["items"][0]["rating"] == "买入" and got["items"][0]["target_price"] == 12.5
    assert got["items"][1]["target_price"] is None
    assert got["ratings"] == {"买入": 1, "增持": 1}


def test_research_without_coverage_is_explained_not_faked(monkeypatch):
    """小盘股零研报是常态：要明说「无覆盖」，不能说成接口故障，更不能编评级"""
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: {"hits": 0, "data": []})
    got = sources.load_research("002256")
    assert got["available"] is False
    assert got.get("empty") is True  # 面板据此显示「无覆盖」，而不是「本次未取到」
    assert "无机构研报覆盖" in got["reason"]


def test_research_marks_stale_coverage(monkeypatch):
    """三年窗口里只有一篇老研报：要带出「距今天数」，模型才不会当成最新观点"""
    monkeypatch.setattr(
        sources,
        "_get_json",
        lambda *a, **kw: {
            "hits": 1,
            "data": [
                {
                    "publishDate": "2024-10-30 00:00:00.000",
                    "orgSName": "中航证券",
                    "title": "2024年三季报点评",
                    "emRatingName": "增持",
                    "indvAimPriceT": "",
                }
            ],
        },
    )
    got = sources.load_research("600877")
    assert got["available"] is True
    assert got["newest_age_days"] and got["newest_age_days"] > 180


def test_northbound_uses_top10_active_list(monkeypatch):
    """北向改用「十大成交活跃股」：给出外资成交额与占比，并写明不推断净买方向"""
    payload = {
        "result": {
            "data": [
                {
                    "TRADE_DATE": "2026-11-10 00:00:00",
                    "RANK": 4,
                    "DEAL_AMT": 883196743,
                    "DEAL_AMOUNT": 3316078848.94,
                    "MUTUAL_RATIO": 26.63,
                    "CHANGE_RATE": -0.41,
                    "CLOSE_PRICE": 1439,
                }
            ]
        }
    }
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    got = sources.load_northbound("600519")
    assert got["available"] is True and got["appearances"] == 1
    assert got["latest"]["northbound_deal"] == 883196743
    assert got["latest"]["ratio"] == 26.63


def test_northbound_absent_is_empty_not_configured(monkeypatch):
    """没进前十是正常结果：标 empty，不能写成「外资在卖出」"""
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: {"result": {"data": []}})
    got = sources.load_northbound("002256")
    assert got["available"] is False and got["empty"] is True
    assert "没有进入北向十大成交活跃股" in got["reason"]


def test_billboard_keeps_net_buy_and_reason(monkeypatch):
    payload = {
        "result": {
            "data": [
                {
                    "TRADE_DATE": "2026-11-02 00:00:00",
                    "EXPLANATION": "日跌幅偏离值达到7%的前5只证券",
                    "EXPLAIN": "4家机构卖出",
                    "BILLBOARD_NET_AMT": -1.2e7,
                    "BILLBOARD_BUY_AMT": 3.4e8,
                    "BILLBOARD_SELL_AMT": 3.5e8,
                    "CHANGE_RATE": -6.42,
                    "D5_CLOSE_ADJCHRATE": 23.4,
                }
            ]
        }
    }
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: payload)
    got = sources.load_billboard("000975")
    assert got["available"] is True
    item = got["items"][0]
    assert item["date"] == "2026-11-02" and item["net_buy"] == -1.2e7
    assert item["d5_return"] == 23.4


def test_billboard_no_record_is_not_failure(monkeypatch):
    monkeypatch.setattr(sources, "_get_json", lambda *a, **kw: {"result": {"data": []}})
    got = sources.load_billboard("002256")
    assert got["available"] is False
    assert "没有上过龙虎榜" in got["reason"]


def test_popularity_returns_rank_or_explicitly_absent(monkeypatch):
    monkeypatch.setattr(sources, "_post_json", lambda *a, **kw: {"data": [{"sc": "SZ002256", "rk": 37}]})
    got = sources.load_popularity("002256")
    assert got["available"] is True and got["rank"] == 37

    monkeypatch.setattr(sources, "_post_json", lambda *a, **kw: {"data": [{"sc": "SH600000", "rk": 1}]})
    got = sources.load_popularity("002256")
    assert got["available"] is True and got["rank"] is None
    assert got["scope"] == 100  # 榜单只公开前 100 名（pageNo=2 实测返回空）


def test_prompt_carries_new_evidence_sections():
    text = prompt_mod.build_user_prompt(
        snapshot=_snapshot(),
        phase={"phase": "intraday", "label": "盘中", "market_local_time": "2026-11-11 10:00"},
        boards={"available": True, "industry": "银行", "region": "上海", "concepts": []},
        flow={"available": True, "latest": {"main_net": -1.0e7}},
        news={"available": True, "items": []},
        limitations=[],
        research={
            "available": True,
            "hits": 1,
            "items": [{"date": "2026-11-10", "org": "西南证券", "title": "三季报点评", "rating": "买入"}],
            "ratings": {"买入": 1},
        },
        billboard={
            "available": True,
            "items": [{"date": "2026-11-02", "reason": "跌幅偏离", "net_buy": -1.2e7}],
        },
        popularity={"available": True, "rank": None, "scope": 100},
    )
    assert "机构研报与评级" in text
    assert "评级分布：买入 1 篇" in text
    assert "龙虎榜" in text and "跌幅偏离" in text
    assert "不在当日人气榜前 100 名" in text


def test_billboard_query_limits_to_recent_year(monkeypatch):
    """不加日期会翻出 2007 年的上榜记录，模型会当成近期异动（实测 600519 踩过）"""
    captured = {}

    def fake_get(url, params, **kwargs):
        captured.update(params)
        return {"result": {"data": []}}

    monkeypatch.setattr(sources, "_get_json", fake_get)
    sources.load_billboard("600519")
    assert "TRADE_DATE>=" in captured["filter"]
    assert "SECURITY_CODE=" in captured["filter"]
