"""``POST /api/stocks/screen`` 端点与取数 SQL（需求规格 §12.4 A1–A11）。

取数层整体被替换成 ``ScreenData`` 夹具 —— 这里要验的是**端点的编排**（校验 →
并发闸 → 取数 → 求值 → 组装）和 SQL 的形状，不是 MySQL 本身。真实库的性能
另在服务器上实测（§11）。
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from src.modules.market.api import fork_market, fork_screen
from src.modules.market.fork_screen.evaluator import build_series
from src.modules.market.fork_screen.models import ScreenRequest
from src.modules.market.fork_screen.repository import (
    ScreenData,
    bars_sql,
    calendar_params,
    calendar_sql,
    calendar_sql_unbounded,
    candidate_params,
    candidate_sql,
)

ASOF = dt.date(2026, 10, 16)


def day(offset: int) -> dt.date:
    return ASOF - dt.timedelta(days=offset)


def condition(name: str, **params) -> dict:
    return {"type": "condition", "id": f"c-{name}", "name": name, "params": params}


def group(*children, operator: str = "AND") -> dict:
    return {"type": "group", "id": "g-root", "operator": operator, "children": list(children)}


def make_request(rule: dict | None = None, **over) -> ScreenRequest:
    base = {
        "trading_days": 30,
        "markets": ["sh", "sz", "cyb", "kcb"],
        "include_st": False,
        "market_cap": {"min_yi": 1, "max_yi": 100000},
        "rule": rule if rule is not None else group(),
    }
    base.update(over)
    return ScreenRequest.model_validate(base)


def db_row(code: str = "600519", symbol: str = "sh600519", **over) -> dict:
    base = {
        "code": code,
        "symbol": symbol,
        "exchange": "SH",
        "name": "贵州茅台",
        "board": "sh",
        "trade_date": ASOF,
        "open": Decimal("1280.0000"),
        "high": Decimal("1299.0000"),
        "low": Decimal("1276.0200"),
        "close": Decimal("1290.5000"),
        "pre_close": Decimal("1286.0000"),
        "change_amount": Decimal("4.5000"),
        "change_pct": Decimal("0.3500"),
        "total_market_cap": Decimal("1607604938886.00"),
        "info_market_cap": 1607604938886,
        "circulating_market_cap": Decimal("1607604938886.00"),
        "source": "sina",
        "adj_factor": Decimal("1.00000000"),
        "ma5": Decimal("1280.0000"),
        "ma10": Decimal("1270.0000"),
        "ma20": Decimal("1250.0000"),
        "ma60": Decimal("1200.0000"),
        "tech_score": 6,
        "tech_trend": "多头排列",
        "tech_macd": "金叉(5日)",
        "tech_rsi": "偏强",
        "tech_kdj": "金叉",
        "tech_boll": "正常波动",
        "tech_volume": "平量",
        "tech_support": Decimal("1250.0000"),
        "tech_resistance": Decimal("1300.0000"),
    }
    base.update(over)
    return base


def series_for(symbol: str, closes: list[float]):
    rows = [
        (day(len(closes) - 1 - index), close, close, closes[index - 1] if index else close, 1.0)
        for index, close in enumerate(closes)
    ]
    series = build_series(symbol, rows)
    assert series is not None
    return series


def calendar_of(days: int) -> list[dt.date]:
    return [day(i) for i in range(days)]


# ---------------------------------------------------------------- A1 SQL 形状


def _strip_params(sql: str) -> str:
    import re

    return re.sub(r"%\([a-z_]+\)s", "?", sql)


def test_A1_三条SQL都不含字面百分号():
    for sql in (candidate_sql(), calendar_sql(), bars_sql()):
        assert "%" not in _strip_params(sql)


def test_A1_候选SQL以WITH开头并按代码排序():
    sql = candidate_sql()
    assert sql.lstrip().startswith("WITH")
    assert "ORDER BY code" in sql
    # 市场范围按「纯代码前缀」判定，不是表格那个 ST 优先的 board
    assert "market_board IN %(markets)s" in sql
    assert "is_st = 0" in sql


def test_A1_日历与日线都带参数化占位符():
    assert "LIMIT %(k)s" in calendar_sql()
    # 带下界（冷缓存下不带下界会扫整条日期索引，实测 5.9 s → 3 ms）
    assert "trade_date >= %(floor)s" in calendar_sql()
    assert "trade_date >= %(floor)s" not in calendar_sql_unbounded()
    assert "IN %(symbols)s" in bars_sql()
    assert "BETWEEN %(start)s AND %(asof)s" in bars_sql()


def test_A1_日历下界按窗口长度放大并留出长假():
    asof = dt.date(2026, 10, 19)
    assert calendar_params(asof, 60)["floor"] == asof - dt.timedelta(days=150)
    assert calendar_params(asof, 251)["floor"] == asof - dt.timedelta(days=532)


# ---------------------------------------------------------------- A2 参数换算


def test_A2_市值亿元换算成元_含ST开关():
    params = candidate_params(make_request())
    assert params["cap_min"] == pytest.approx(1e8)
    assert params["cap_max"] == pytest.approx(1e13)
    assert params["include_st"] == 0

    with_st = candidate_params(make_request(include_st=True))
    assert with_st["include_st"] == 1


def test_A2_市值上下限严格开区间():
    sql = candidate_sql()
    assert "> %(cap_min)s" in sql
    assert "< %(cap_max)s" in sql


# ---------------------------------------------------------------- A3 市场白名单


def test_A3_白名单之外的市场进不了SQL():
    with pytest.raises(ValidationError):
        make_request(markets=["bj"])
    with pytest.raises(ValidationError):
        make_request(markets=["sh; DROP TABLE stock_daily"])


# ---------------------------------------------------------------- 夹具


def _patch_fetch(monkeypatch, data: ScreenData):
    calls: list[tuple[ScreenRequest, int]] = []

    def fake_fetch(req: ScreenRequest, k: int) -> ScreenData:
        calls.append((req, k))
        return data

    monkeypatch.setattr(fork_screen, "fetch_screen_data", fake_fetch)
    return calls


def _detail(exc: HTTPException) -> tuple[str, str]:
    detail = exc.detail
    assert isinstance(detail, dict)
    return str(detail.get("code")), str(detail.get("message"))


# ---------------------------------------------------------------- A4/A5 503


def test_A4_日历没更新到asof时返回503(monkeypatch):
    data = ScreenData(
        asof=ASOF,
        candidates=[db_row()],
        calendar=[day(1), day(2)],  # D[1] != asof
        series={},
        stale_date=day(1),
    )
    _patch_fetch(monkeypatch, data)
    with pytest.raises(HTTPException) as info:
        fork_screen.screen(make_request(rule=group(condition("close_above_ma", period=5))))
    assert info.value.status_code == 503
    assert _detail(info.value)[0] == "screen_data_stale"


def test_A5_连不上库时返回503且带原因(monkeypatch):
    def boom(req, k):
        raise fork_market.ForkDbUnavailable("连接行情库失败：拒绝连接")

    monkeypatch.setattr(fork_screen, "fetch_screen_data", boom)
    with pytest.raises(HTTPException) as info:
        fork_screen.screen(make_request())
    assert info.value.status_code == 503
    assert "连接行情库失败" in str(info.value.detail)


# ---------------------------------------------------------------- A6 命中与形状


def test_A6_只返回命中的股票且形状与market_table一致(monkeypatch):
    hit = db_row("600519", "sh600519")
    miss = db_row("000001", "sz000001", exchange="SZ")
    data = ScreenData(
        asof=ASOF,
        candidates=[hit, miss],
        calendar=calendar_of(30),
        series={"sh600519": series_for("sh600519", [10, 10, 10, 10, 11])},
    )
    _patch_fetch(monkeypatch, data)

    body = fork_screen.screen(make_request(rule=group(condition("close_above_ma", period=5))))

    assert body["total"] == 1
    assert [item["c"] for item in body["items"]] == ["600519"]
    assert body["items"][0] == fork_market.map_row(hit)
    assert body["stats"]["candidates"] == 2
    assert body["stats"]["evaluated"] == 1
    assert body["stats"]["insufficient"] == 1
    assert body["asof"] == "2026-10-16"


def test_A6b_结果按代码升序(monkeypatch):
    rows = [db_row("600519", "sh600519"), db_row("000001", "sz000001", exchange="SZ")]
    series = {
        "sh600519": series_for("sh600519", [10, 10, 10, 10, 11]),
        "sz000001": series_for("sz000001", [10, 10, 10, 10, 12]),
    }
    data = ScreenData(asof=ASOF, candidates=rows, calendar=calendar_of(30), series=series)
    _patch_fetch(monkeypatch, data)
    body = fork_screen.screen(make_request(rule=group(condition("close_above_ma", period=5))))
    assert [item["c"] for item in body["items"]] == ["000001", "600519"]


# ---------------------------------------------------------------- A7 空结果


def test_A7_候选为空时返回200且不取日线(monkeypatch):
    data = ScreenData(asof=None, candidates=[], calendar=[], series={})
    calls = _patch_fetch(monkeypatch, data)
    body = fork_screen.screen(make_request(rule=group(condition("ma_bullish"))))
    assert body["total"] == 0
    assert body["items"] == []
    assert body["stats"]["candidates"] == 0
    assert calls and calls[0][1] == 60  # K 仍然是算出来的，只是取数层没东西可取


# ---------------------------------------------------------------- A8 去重


def test_A8_同一天重复行只计一次():
    rows = [
        (day(1), 10.0, 10.0, 10.0, 1.0),
        (day(1), 11.0, 11.0, 10.0, 1.0),
        (day(0), 12.0, 12.0, 10.0, 1.0),
    ]
    series = build_series("sh600000", rows)
    assert series is not None
    assert len(series.bars) == 2
    assert series.bars[0].close == 10.0  # 保留第一条
    assert series.by_date[day(0)] == 1


# ---------------------------------------------------------------- A9 并发闸


def test_A9_并发超过两个时返回429(monkeypatch):
    data = ScreenData(asof=ASOF, candidates=[db_row()], calendar=calendar_of(30), series={})
    _patch_fetch(monkeypatch, data)
    slots = fork_screen._SCREEN_SLOTS
    assert slots.acquire(blocking=False)
    assert slots.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as info:
            fork_screen.screen(make_request())
        assert info.value.status_code == 429
        assert _detail(info.value)[0] == "screen_busy"
    finally:
        slots.release()
        slots.release()
    # 释放之后能正常跑
    body = fork_screen.screen(make_request())
    assert body["total"] == 1


# ---------------------------------------------------------------- A10 K 与窗口


def test_A10_window字段反映K与窗口起点(monkeypatch):
    data = ScreenData(
        asof=ASOF,
        candidates=[db_row()],
        calendar=calendar_of(60),
        series={},
    )
    _patch_fetch(monkeypatch, data)
    body = fork_screen.screen(make_request(rule=group(condition("ma_bullish"))))
    assert body["window"] == {
        "trading_days": 30,
        "fetched_bars": 60,
        "start_date": str(day(59)),
    }


# ---------------------------------------------------------------- A11 板块规则


def test_A11_市场判定用纯代码前缀_ST单独一层():
    """选股的市场范围不能用「ST 优先」的 board（否则选了上证却不含 ST 会漏票）。"""
    market_case = fork_market._MARKET_BOARD_CASE
    for prefix in ("'688', '689'", "'300', '301'", "'60'", "'00'", "'302'"):
        assert prefix in market_case
    assert "ST" not in market_case  # 纯前缀规则里不该出现 ST 判定

    assert "ST" in fork_market._BOARD_CASE  # 表格那个仍是 ST 优先
    assert "THEN 'st'" in fork_market._BOARD_CASE

    # 北交所 920xxx 落到 other → 不在四个市场里 → 天然被排除
    assert "ELSE 'other'" in market_case


def test_A11_候选SQL带is_st列():
    assert "AS is_st" in fork_market._WITH_UNI
    assert "AS market_board" in fork_market._WITH_UNI


def test_A12_日线查询必须用流式tuple_cursor():
    """连接默认是 DictCursor（拿 dict 解包会得到键名）；普通 Cursor 会把全部行读进内存。

    实测 K=251 的 125 万行：普通 Cursor 峰值 919 MB，SSCursor 逐批取。
    """
    from pymysql.cursors import SSCursor

    from src.modules.market.fork_screen import repository as repo

    class FakeConn:
        def cursor(self, *args, **kwargs):  # noqa: ANN002, ANN003 - 桩
            return args

    assert repo._tuple_cursor(FakeConn()) == (SSCursor,)
