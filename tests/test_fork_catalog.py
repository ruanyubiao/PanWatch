"""fork 专用：A 股全市场目录接口（``GET /api/stocks/catalog``）。

覆盖三件容易写错的事：
1. ETF / 港股美股 / 北交所的归属（只服务 A 股股票，北交所只计入「全部」）
2. 板块判定优先级（ST > 科创 > 创业 > 上证 > 深证），必须与前端
   ``frontend/src/lib/board-classify.ts`` 完全一致
3. 分页与关键词搜索
"""

from __future__ import annotations

import pytest

from src.modules.market.api import fork_catalog

SAMPLE = [
    {"symbol": "600519", "name": "贵州茅台", "market": "CN", "asset_type": "stock"},
    {"symbol": "601398", "name": "工商银行", "market": "CN", "asset_type": "stock"},
    {"symbol": "000001", "name": "平安银行", "market": "CN", "asset_type": "stock"},
    {"symbol": "002594", "name": "比亚迪", "market": "CN", "asset_type": "stock"},
    # 深市主板 2025 年起的新号段
    {"symbol": "302132", "name": "中航成飞", "market": "CN", "asset_type": "stock"},
    {"symbol": "300750", "name": "宁德时代", "market": "CN", "asset_type": "stock"},
    {"symbol": "301029", "name": "怡合达", "market": "CN", "asset_type": "stock"},
    {"symbol": "688111", "name": "金山办公", "market": "CN", "asset_type": "stock"},
    {"symbol": "600123", "name": "*ST花王", "market": "CN", "asset_type": "stock"},
    {"symbol": "510300", "name": "沪深300ETF", "market": "CN", "asset_type": "etf"},
    {"symbol": "159915", "name": "创业板ETF", "market": "CN", "asset_type": "etf"},
    {"symbol": "00700", "name": "腾讯控股", "market": "HK", "asset_type": "stock"},
    {"symbol": "AAPL", "name": "苹果", "market": "US", "asset_type": "stock"},
    # 北交所新号段：属于 A 股，保留在「全部」里（没有对应 pill，board=other）
    {"symbol": "920992", "name": "中科美菱", "market": "CN", "asset_type": "stock"},
    # 新三板/老三板：与北交所老号段同段，无法区分，统一排除
    {"symbol": "830799", "name": "艾融软件", "market": "CN", "asset_type": "stock"},
    {"symbol": "400001", "name": "大自然", "market": "CN", "asset_type": "stock"},
    # 退市整理 / 终止上市：不是可交易标的，排除
    {"symbol": "600890", "name": "退市中房", "market": "CN", "asset_type": "stock"},
    {"symbol": "000004", "name": "国华退", "market": "CN", "asset_type": "stock"},
    {"symbol": "000003", "name": "PT金田A", "market": "CN", "asset_type": "stock"},
]


@pytest.fixture()
def catalog(monkeypatch):
    """把目录接口的数据源换成固定样本。"""
    monkeypatch.setattr(fork_catalog, "get_stock_list", lambda: SAMPLE)
    return fork_catalog.stock_catalog


def test_只保留_a_股股票并给出板块计数(catalog):
    """ETF、港股美股、新三板都被排除；北交所(920)计入全部但不进任何板块。"""
    data = catalog(board="all", q="", offset=0, limit=200)

    symbols = [item["symbol"] for item in data["items"]]
    assert "510300" not in symbols and "159915" not in symbols
    assert "00700" not in symbols and "AAPL" not in symbols
    # 新三板/老三板（与北交所老号段同段）必须挡掉，否则「全部」虚高一倍
    assert "830799" not in symbols and "400001" not in symbols
    # 退市整理板 / PT 标的不占列表
    assert "600890" not in symbols and "000004" not in symbols and "000003" not in symbols

    # A 股 = 9 只可归类 + 920992（北交所）
    assert data["counts"]["all"] == 10
    assert data["counts"]["sh"] == 2
    assert data["counts"]["sz"] == 3  # 000001 / 002594 / 302132
    assert data["counts"]["kcb"] == 1
    assert data["counts"]["cyb"] == 2
    assert data["counts"]["st"] == 1
    # 北交所不属于任何板块：板块计数之和 + 1 = 全部
    board_sum = data["counts"]["sh"] + data["counts"]["sz"] + data["counts"]["kcb"] + data["counts"]["cyb"] + data["counts"]["st"]
    assert board_sum + 1 == data["counts"]["all"]


def test_st_优先于交易所板块(catalog):
    """名称带 ST 的沪市股票只出现在 ST 板块里，不会同时算进上证。"""
    st = catalog(board="st", q="", offset=0, limit=50)
    assert [item["symbol"] for item in st["items"]] == ["600123"]
    assert st["total"] == 1

    sh = catalog(board="sh", q="", offset=0, limit=50)
    assert "600123" not in [item["symbol"] for item in sh["items"]]


def test_板块过滤与分页(catalog):
    """board=cyb 只回创业板；分页 offset/limit 生效且 total 是全量数。"""
    cyb = catalog(board="cyb", q="", offset=0, limit=1)
    assert cyb["total"] == 2
    assert len(cyb["items"]) == 1
    assert cyb["items"][0]["symbol"] == "300750"  # 按代码升序

    second = catalog(board="cyb", q="", offset=1, limit=1)
    assert [item["symbol"] for item in second["items"]] == ["301029"]


def test_关键词同时匹配代码与名称(catalog):
    """q 命中代码前缀或名称片段。"""
    by_code = catalog(board="all", q="6005", offset=0, limit=50)
    assert [item["symbol"] for item in by_code["items"]] == ["600519"]

    by_name = catalog(board="all", q="银行", offset=0, limit=50)
    assert {item["symbol"] for item in by_name["items"]} == {"601398", "000001"}


def test_非法板块名回退为全部(catalog):
    """忽略未知 board 值，按「全部」返回（前端 pill 只有固定几个 key）。"""
    data = catalog(board="不存在的板块", q="", offset=0, limit=200)
    assert data["counts"]["all"] == 10
    assert len(data["items"]) == 10


def test_深市主板新号段302归入深证(catalog):
    """302xxx 是深市主板新号段，不是创业板。"""
    assert fork_catalog.classify_board("302132", "中航成飞", "stock") == "sz"
