"""fork 专用：A 股全市场行情表接口（``GET /api/stocks/market-table``）。

覆盖四件容易写错、且会让界面出现「看着合理但不对」的数字的事：

1. **复权口径**：``maN`` 与 ``tech_support/resistance`` 在库里是后复权空间的值，
   而 ``close/high/low`` 是不复权价。不还原就会出现「ma5 比现价高一大截」。
2. **pymysql 的参数插值**：``cursor.execute(sql, params)`` 会做 ``query % args``，
   SQL 里只要有一个字面 ``%``（LIKE 通配符）就会炸 —— 因此板块判定用
   LEFT()/LOCATE() 而不是 LIKE，这条规则要有测试钉住。
3. **数据不足**：``tech_*`` 整组 NULL（新股/历史不足 120 根）时返回 null，
   不能喂 0（0 分会被映射成「观望」这个结论）。
4. **缺凭据**：没有 STOCK_DB_RO_* 时给 503 + 明确原因，不是崩栈。
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from fastapi import HTTPException

from src.modules.market.api import fork_market


def _db_row(**over):
    """一条「库里取回来的行」——列名与 SQL 的 SELECT 一致。"""
    base = {
        "code": "600519",
        "symbol": "sh600519",
        "exchange": "SH",
        "name": "贵州茅台",
        "board": "sh",
        "trade_date": dt.date(2026, 10, 14),
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


# ------------------------------------------------------------------ 复权口径

def test_复权因子把均线与支撑压力还原到不复权空间():
    """adj_factor=2.68 的票：库里 ma5=30.88（后复权），显示必须是 11.52。"""
    row = _db_row(
        adj_factor=Decimal("2.68142065"),
        ma5=Decimal("30.8800"),
        ma20=Decimal("30.8000"),
        tech_support=Decimal("30.2100"),
        tech_resistance=Decimal("31.8750"),
        close=Decimal("11.5900"),
    )
    item = fork_market.map_row(row)

    assert item["close"] == 11.59  # 现价本来就不复权，不动
    assert item["ma"]["ma5"] == pytest.approx(30.88 / 2.68142065, rel=1e-4)
    assert item["ma"]["ma20"] == pytest.approx(30.80 / 2.68142065, rel=1e-4)
    # 支撑/压力同口径还原（不还原会出现「支撑比现价高一大截」的假象）
    assert item["tech"]["support"] == pytest.approx(30.21 / 2.68142065, rel=1e-4)
    assert item["tech"]["resistance"] == pytest.approx(31.875 / 2.68142065, rel=1e-4)
    # 还原后与不复权的现价在同一个量级（这才是这条口径的意义）
    assert 11.0 < item["tech"]["support"] < item["close"] < item["tech"]["resistance"] < 12.5
    assert item["adj_factor"] == 2.68142065


def test_adj_factor_缺省按_1_处理而不是除零():
    item = fork_market.map_row(_db_row(adj_factor=None))
    assert item["adj_factor"] == 1.0
    assert item["ma"]["ma5"] == 1280.0


def test_adj_factor_为零或负数时按_1_避免除零或价格翻号():
    zero = fork_market.map_row(_db_row(adj_factor=Decimal("0")))
    negative = fork_market.map_row(_db_row(adj_factor=Decimal("-2")))
    assert zero["adj_factor"] == 1.0
    assert zero["ma"]["ma5"] == 1280.0
    assert negative["adj_factor"] == 1.0
    assert negative["ma"]["ma5"] == 1280.0


def test_市值取当日值_当日为空时回落到股票表():
    assert fork_market.map_row(_db_row())["total_market_cap"] == 1607604938886.0
    fallback = fork_market.map_row(_db_row(total_market_cap=None))
    assert fallback["total_market_cap"] == 1607604938886.0


# ------------------------------------------------------------------ 数据不足

def test_技术面为空的票返回_none_而不是零分():
    row = _db_row(tech_score=None, tech_trend=None, tech_macd=None, tech_rsi=None,
                  tech_kdj=None, tech_boll=None, tech_volume=None,
                  tech_support=None, tech_resistance=None)
    item = fork_market.map_row(row)
    assert item["tech"] is None
    # 行情照旧要有（新股也有收盘价）
    assert item["close"] == 1290.5


def test_交易日序列化成字符串():
    assert fork_market.map_row(_db_row())["trade_date"] == "2026-10-14"


# ------------------------------------------------------------------ SQL 形状

def test_sql_里没有多余的百分号():
    """pymysql 传了 args 就会做 ``query % args``：除 ``%(name)s`` 占位符外，
    任何字面 % （比如 LIKE 的通配符）都会被当格式符打爆。"""
    import re

    placeholder = re.compile(r"%\([A-Za-z_][A-Za-z0-9_]*\)s")
    for sql in (
        fork_market._COUNTS_SQL,
        fork_market.build_page_sql("all", "")[0],
        fork_market.build_total_sql("all", "")[0],
        fork_market.build_page_sql("kcb", "茅台")[0],
        fork_market.build_total_sql("kcb", "茅台")[0],
    ):
        assert "%" not in placeholder.sub("", sql), sql


def test_板块筛选只在白名单内生效():
    sql, params = fork_market.build_page_sql("st", "")
    assert "board = %(board)s" in sql
    assert params == {"board": "st"}

    # 非法板块 → 退化成全集，不报错也不注入
    sql_all, params_all = fork_market.build_page_sql("'; drop table --", "")
    assert "board = %(board)s" not in sql_all
    assert params_all == {}


def test_关键词搜索用_locate_且与计数同口径():
    page_sql, page_params = fork_market.build_page_sql("all", " 茅台 ")
    total_sql, total_params = fork_market.build_total_sql("all", " 茅台 ")
    assert "LOCATE(%(needle)s, code) > 0 OR LOCATE(%(needle)s, name) > 0" in page_sql
    assert page_params == {"needle": "茅台"}
    assert total_params == page_params
    # 计数与分页共用同一段 WHERE：口径不会漂
    assert "LOCATE(%(needle)s, code)" in total_sql


def test_分页查询带上了_CTE_前缀():
    """FROM uni 依赖 WITH ... AS (uni)：漏了前缀就是语法错。"""
    sql, _ = fork_market.build_page_sql("all", "")
    assert sql.lstrip().upper().startswith("WITH")
    assert "FROM uni" in sql
    assert "ORDER BY code" in sql


# ------------------------------------------------------------------ 端点

@pytest.fixture()
def canned(monkeypatch):
    """把 _query 换成固定应答：计数 / 总数 / 页数据。"""
    calls: list[tuple[str, dict]] = []
    rows = [_db_row(), _db_row(code="000001", symbol="sz000001", exchange="SZ", name="平安银行", board="sz")]

    def fake_queries(statements):
        out = []
        for sql, params in statements:
            calls.append((sql, params or {}))
            if "COUNT(*) AS total" in sql:
                out.append([{"total": 2}])
            elif "c_all" in sql:
                out.append([{
                    "asof": dt.date(2026, 10, 14),
                    "c_all": 5574, "c_sh": 1632, "c_sz": 1420,
                    "c_kcb": 605, "c_cyb": 1370, "c_st": 201,
                }])
            else:
                out.append(rows)
        return out

    monkeypatch.setattr(fork_market, "_queries", fake_queries)
    return calls


def test_端点返回计数_总数_交易日与行(canned):
    data = fork_market.market_table(board="all", q="", offset=0, limit=100)

    assert data["asof"] == "2026-10-14"
    # 未筛选时总数与板块计数里的「全部」是同一次聚合，不再另查 COUNT
    assert data["total"] == 5574
    assert data["offset"] == 0 and data["limit"] == 100
    assert data["counts"] == {
        "all": 5574, "sh": 1632, "sz": 1420, "kcb": 605, "cyb": 1370, "st": 201,
    }
    assert [item["code"] for item in data["items"]] == ["600519", "000001"]
    # 未筛选：总数直接用 c_all，只查计数和页数据
    assert len(canned) == 2
    assert "COUNT(*) AS total" not in canned[0][0]
    assert "COUNT(*) AS total" not in canned[1][0]


def test_筛选时才单独计数且与分页同口径(canned):
    data = fork_market.market_table(board="kcb", q=" 茅台 ", offset=20, limit=10)
    assert data["total"] == 2
    assert len(canned) == 3
    total_sql, total_params = canned[1]
    page_sql, page_params = canned[2]
    assert "COUNT(*) AS total" in total_sql
    assert "LOCATE(%(needle)s, code)" in total_sql
    assert total_params == {"needle": "茅台", "board": "kcb"}
    assert page_params["needle"] == "茅台"
    assert page_params["board"] == "kcb"
    assert page_params["limit"] == 10 and page_params["offset"] == 20


def test_端点_板块非法时退化成全部(canned):
    data = fork_market.market_table(board="不存在", q="", offset=0, limit=10)
    assert data["counts"]["all"] == 5574
    assert "board = %(board)s" not in canned[-1][0]


def test_缺凭据时给_503_加明确原因(monkeypatch):
    def boom(statements):
        raise fork_market.ForkDbUnavailable("未配置只读行情库")

    monkeypatch.setattr(fork_market, "_queries", boom)
    with pytest.raises(HTTPException) as excinfo:
        fork_market.market_table(board="all", q="", offset=0, limit=10)
    assert excinfo.value.status_code == 503
    assert "未配置只读行情库" in str(excinfo.value.detail)


def test_db_config_缺环境变量时抛_ForkDbUnavailable(monkeypatch):
    monkeypatch.delenv("STOCK_DB_RO_USER", raising=False)
    monkeypatch.delenv("STOCK_DB_RO_PASSWORD", raising=False)
    with pytest.raises(fork_market.ForkDbUnavailable):
        fork_market._db_config()


def test_db_config_端口非法时抛_ForkDbUnavailable(monkeypatch):
    monkeypatch.setenv("STOCK_DB_RO_USER", "stock_ro")
    monkeypatch.setenv("STOCK_DB_RO_PASSWORD", "x")
    monkeypatch.setenv("STOCK_DB_PORT", "abc")
    with pytest.raises(fork_market.ForkDbUnavailable, match="STOCK_DB_PORT"):
        fork_market._db_config()


def test_db_config_默认主机与库名(monkeypatch):
    monkeypatch.setenv("STOCK_DB_RO_USER", "stock_ro")
    monkeypatch.setenv("STOCK_DB_RO_PASSWORD", "x")
    monkeypatch.delenv("STOCK_DB_HOST", raising=False)
    monkeypatch.delenv("STOCK_DB_PORT", raising=False)
    monkeypatch.delenv("STOCK_DB_NAME", raising=False)
    config = fork_market._db_config()
    assert config["host"] == "127.0.0.1"
    assert config["port"] == 3306
    assert config["database"] == "stock"


# ---------------------------------------------------------------------- 构建信息

def test_构建信息_优先读部署时写下的文件(tmp_path, monkeypatch):
    """云端没有 .git，版本只能来自 BUILD_INFO.json（10-publish.sh 写的）。"""
    info = tmp_path / "BUILD_INFO.json"
    info.write_text(
        '{"sha":"abc12345","branch":"analysis-20261019","'
        'commit_time":"2026-10-19T18:56:00+08:00","published_at":"2026-10-19T19:30:00+08:00"}',
        encoding="utf-8",
    )
    monkeypatch.setattr(fork_market, "_BUILD_INFO_FILE", info)
    for key in ("APP_GIT_SHA", "APP_GIT_BRANCH", "APP_GIT_COMMIT_TIME"):
        monkeypatch.delenv(key, raising=False)
    fork_market.build_info.cache_clear()
    try:
        data = fork_market.build_info()
    finally:
        fork_market.build_info.cache_clear()

    assert data["sha"] == "abc12345"
    assert data["branch"] == "analysis-20261019"
    assert data["commit_time"] == "2026-10-19T18:56:00+08:00"
    assert data["published_at"] == "2026-10-19T19:30:00+08:00"


def test_构建信息_文件缺失或损坏时退回环境变量(tmp_path, monkeypatch):
    """文件坏了不能把接口打挂 —— 退回环境变量，字段仍然是四个键。"""
    broken = tmp_path / "BUILD_INFO.json"
    broken.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(fork_market, "_BUILD_INFO_FILE", broken)
    monkeypatch.setenv("APP_GIT_SHA", "deadbee1")
    monkeypatch.setenv("APP_GIT_BRANCH", "dev")
    monkeypatch.setenv("APP_GIT_COMMIT_TIME", "2026-10-19T10:00:00+08:00")
    fork_market.build_info.cache_clear()
    try:
        data = fork_market.build_info()
    finally:
        fork_market.build_info.cache_clear()

    assert data["sha"] == "deadbee1"
    assert data["branch"] == "dev"
    assert data["commit_time"] == "2026-10-19T10:00:00+08:00"


def test_market_meta_端点返回四个键():
    data = fork_market.market_meta()
    assert set(data) == {"sha", "branch", "commit_time", "published_at"}
    assert all(value is None or isinstance(value, str) for value in data.values())
