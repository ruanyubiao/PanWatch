"""``market-table`` / ``stocks/screen`` 的**交易日状态**字段（2026-10-20 第 5 条）。

表格新增的「状态」列（停牌 / 正常 / ST …）与筛选「全部状态」都读这三个字段：

=================  =====================================================
status_code        库里的状态码；没有状态行时按 ``traded`` 兜底
status_label       2–3 个字的短标签（「其他风险警示(ST)」那种长文案塞不进固定列宽）
status_group       库里分组（suspension / risk_warning / delisting / listing）
=================  =====================================================

纯函数单测，不连库。
"""

from __future__ import annotations

from src.modules.market.api.fork_market import (
    _STATUS_SHORT_ZH,
    map_row,
    trade_status_code,
)


def test_有状态行时用状态行() -> None:
    assert trade_status_code({"status_code": "SUSPENDED", "traded": 1}) == "SUSPENDED"
    assert trade_status_code({"status_code": "ST", "traded": 1}) == "ST"
    assert trade_status_code({"status_code": "STAR_ST"}) == "STAR_ST"


def test_没有状态行时按traded兜底() -> None:
    # 当日无成交 = 全天停牌（状态管道还没跑完时也要显示对）
    assert trade_status_code({"status_code": None, "traded": 0}) == "SUSPENDED"
    assert trade_status_code({"status_code": "", "traded": 0}) == "SUSPENDED"
    # 有成交 = 正常
    assert trade_status_code({"status_code": None, "traded": 1}) == "NORMAL"
    # 两个都没有：当作正常（老接口/老响应）
    assert trade_status_code({}) == "NORMAL"
    assert trade_status_code({"status_code": None, "traded": None}) == "NORMAL"


def test_短标签覆盖库里所有状态码() -> None:
    """``stock_status_type`` 目前的 7 个码都要有短标签，并且都在 3 个字以内（固定列宽 68px）。"""
    codes = [
        "SUSPENDED",
        "ST",
        "STAR_ST",
        "DELISTING",
        "DELIST_PENDING",
        "DELISTED",
        "NEW_LISTING",
    ]
    for code in codes:
        assert code in _STATUS_SHORT_ZH, code
        assert len(_STATUS_SHORT_ZH[code]) <= 3, code
    # 「正常」不是一个库里的状态码，是缺省值
    assert _STATUS_SHORT_ZH["NORMAL"] == "正常"


def test_map_row带出状态三字段() -> None:
    row = {
        "code": "600933",
        "symbol": "sh600933",
        "exchange": "SH",
        "name": "爱柯迪",
        "board": "sh",
        "trade_date": "2026-10-20",
        "close": 14.02,
        "adj_factor": 1,
        "status_code": "SUSPENDED",
        "status_group": "suspension",
        "status_text": "全天停牌",
    }
    mapped = map_row(row)
    assert mapped["status_code"] == "SUSPENDED"
    assert mapped["status_label"] == "停牌"
    assert mapped["status_group"] == "suspension"


def test_map_row正常与未知状态() -> None:
    base = {
        "code": "600519",
        "symbol": "sh600519",
        "exchange": "SH",
        "name": "贵州茅台",
        "board": "sh",
        "trade_date": "2026-10-20",
        "close": 1500.0,
        "adj_factor": 1,
        "traded": 1,
    }
    normal = map_row(dict(base))
    assert normal["status_code"] == "NORMAL"
    assert normal["status_label"] == "正常"

    # 库里出现了映射表里没有的新状态码：不冒充「正常」，标签退回「其他」
    unknown = map_row({**base, "status_code": "SOMETHING_NEW"})
    assert unknown["status_code"] == "SOMETHING_NEW"
    assert unknown["status_label"] == "其他"
