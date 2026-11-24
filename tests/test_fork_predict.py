"""fork: 每日个股预测（模型预测页 / 分析页那一列）。

钉住四件线上真会出问题的事：

1. **表不存在不是 500**：本地开发库没有 stock_predict_daily，页面要显示「暂无」；
2. **北交所拒绝**（用户口径：股票池排除 bj），而不是给一个空列表；
3. **名次顺序**：1 = 最看好，列表按名次升序，前端不再自己排；
4. **详情页的曲线是「时间从左到右」**：库里取的是倒序，接口要给正序，否则图上
   看着像在往上涨。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from src.modules.market.api import fork_predict
from src.modules.market.fork_predict import data as predict_data


# ── 桩：把 MySQL 查询换成返回固定行 ──────────────────────────────────────


@pytest.fixture
def fake_rows(monkeypatch):
    """``rows`` 按 SQL 关键字路由到不同的假结果。"""

    def _install(rows_by_key: dict[str, list[dict]], row_by_key: dict[str, dict] | None = None):
        def _rows(sql: str, params: tuple = ()):
            for key, value in rows_by_key.items():
                if key in sql:
                    return value
            return []

        def _row(sql: str, params: tuple = ()):
            for key, value in (row_by_key or {}).items():
                if key in sql:
                    return value
            got = _rows(sql, params)
            return got[0] if got else None

        monkeypatch.setattr(predict_data, "_rows", _rows)
        monkeypatch.setattr(predict_data, "_row", _row)

    return _install


def _missing_table():
    class _Err(Exception):
        args = (1146, "Table 'stock.stock_predict_daily' doesn't exist")

    return _Err()


# ── 代码归一化 ───────────────────────────────────────────────────────────


def test_symbol_normalizes_three_spellings():
    assert fork_predict._normalize("600519") == "600519"
    assert fork_predict._normalize("sh600519") == "600519"
    assert fork_predict._normalize("600519.SH") == "600519"


def test_symbol_rejects_beijing():
    for symbol in ("920025", "bj430047", "430047.BJ", "830799", "870199"):
        with pytest.raises(HTTPException) as ctx:
            fork_predict._normalize(symbol)
        assert ctx.value.status_code == 400
        assert ctx.value.detail["code"] == "predict_beijing_excluded"


def test_symbol_rejects_garbage():
    with pytest.raises(HTTPException) as ctx:
        fork_predict._normalize("60051")
    assert ctx.value.detail["code"] == "predict_bad_symbol"


# ── 取数层 ───────────────────────────────────────────────────────────────


def test_missing_table_reads_as_no_predictions(fake_rows, monkeypatch):
    """表不存在 → available=False（200），不是异常。"""

    def _boom(sql, params=()):
        raise _missing_table()

    monkeypatch.setattr(predict_data, "_rows", _boom)
    dates = predict_data.available_dates()
    assert dates == {"available": False, "dates": [], "latest": None}
    assert predict_data.load_daily()["available"] is False
    assert predict_data.load_scores()["available"] is False
    assert predict_data.load_stock("600519") is None


def test_daily_keeps_rank_order_and_names(fake_rows):
    fake_rows(
        {
            "GROUP BY trade_date": [
                {"trade_date": "2026-11-24", "n": 4991, "v": "pred_head_20261124-1458", "t": "2026-11-24 15:42:32"}
            ],
            "ORDER BY p.rank_no ASC": [
                {"rank_no": 1, "symbol": "sh688630", "code": "688630", "score": 0.47, "pct": 100.0,
                 "amt_med20": 1.6e9, "name": "芯碁微装", "model_version": "v", "scored_at": "2026-11-24 15:42:32"},
                {"rank_no": 2, "symbol": "sh688519", "code": "688519", "score": 0.47, "pct": 99.98,
                 "amt_med20": 1.5e9, "name": "南亚新材", "model_version": "v", "scored_at": "2026-11-24 15:42:32"},
            ],
            "WHERE trade_date = %s": [{"n": 2, "v": "v", "t": "2026-11-24 15:42:32"}],
        }
    )
    payload = predict_data.load_daily()
    assert payload["available"] is True
    assert payload["trade_date"] == "2026-11-24"
    assert [item["rank_no"] for item in payload["items"]] == [1, 2]
    assert payload["items"][0]["name"] == "芯碁微装"
    assert payload["total"] == 2


def test_scores_map_is_by_code(fake_rows):
    fake_rows(
        {
            "GROUP BY trade_date": [{"trade_date": "2026-11-24", "n": 2, "v": "v", "t": None}],
            "SELECT code, rank_no, pct": [
                {"code": "688630", "rank_no": 1, "pct": 100.0},
                {"code": "000975", "rank_no": 900, "pct": 81.2},
            ],
        }
    )
    scores = predict_data.load_scores()
    assert scores["trade_date"] == "2026-11-24"
    assert scores["scores"]["688630"] == {"rank_no": 1, "pct": 100.0}
    assert scores["scores"]["000975"]["pct"] == 81.2


def test_stock_history_is_oldest_first(fake_rows):
    """库里按 trade_date DESC 取，接口必须翻成时间正序（否则曲线画反）。"""
    fake_rows(
        {
            "ORDER BY p.trade_date DESC LIMIT 1": [
                {"trade_date": "2026-11-24", "rank_no": 900, "score": 0.1, "pct": 81.2,
                 "amt_med20": 6e8, "model_version": "v", "scored_at": "2026-11-24 15:42:32",
                 "name": "山金国际", "exchange": "SZ"}
            ],
            "WHERE code = %s ORDER BY trade_date DESC": [
                {"trade_date": "2026-11-24", "rank_no": 900, "pct": 81.2},
                {"trade_date": "2026-11-21", "rank_no": 1200, "pct": 75.0},
            ],
            "COUNT(*) AS n FROM stock_predict_daily WHERE trade_date": [{"n": 4991}],
            "is_active = 1": [{"version": "pred_head_20261124-1458", "trained_at": "2026-11-24 15:19:56",
                               "best_iter": 375, "n_features": 73, "label_def": "head20",
                               "metrics_json": "{\"auc\": 0.62}"}],
        }
    )
    payload = predict_data.load_stock("000975")
    assert payload is not None
    assert payload["name"] == "山金国际"
    assert payload["universe"] == 4991
    # 正序：21 号在前、24 号在后
    assert [h["trade_date"] for h in payload["history"]] == ["2026-11-21", "2026-11-24"]
    assert payload["model"]["n_features"] == 73


def test_stock_without_records_returns_none(fake_rows):
    fake_rows({"ORDER BY p.trade_date DESC LIMIT 1": []})
    assert predict_data.load_stock("600519") is None


# ── 接口层 ───────────────────────────────────────────────────────────────


def test_stock_endpoint_404_when_no_record(fake_rows):
    fake_rows({"ORDER BY p.trade_date DESC LIMIT 1": []})
    with pytest.raises(HTTPException) as ctx:
        fork_predict.predict_stock("600519", days=60)
    assert ctx.value.status_code == 404
    assert ctx.value.detail["code"] == "predict_not_found"


def test_endpoints_map_db_failure_to_503(monkeypatch):
    def _boom(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(predict_data, "available_dates", _boom)
    with pytest.raises(HTTPException) as ctx:
        fork_predict.predict_dates()
    assert ctx.value.status_code == 503
    assert ctx.value.detail["code"] == "predict_market_data_unavailable"
