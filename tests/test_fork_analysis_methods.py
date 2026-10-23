"""统计分析方法 2（规格实现）+ 方法注册表 + 统一输出信封的回归。

全部不碰 MySQL：``build_event`` 是纯计算，统计层读临时 SQLite。
规格里那几条验收条件（累计窗口单调、达标率随目标递减、比例可复算）都在这里钉住。
"""

from __future__ import annotations

import datetime as dt
import sqlite3

import pytest

from src.modules.market.fork_analysis import methods, store
from src.modules.market.fork_analysis.methods import method2, method2_data

D0 = dt.date(2026, 1, 5)


def fwd_days(count: int = 35) -> list[dt.date]:
    return [D0 + dt.timedelta(days=offset) for offset in range(1, count + 1)]


def bar(day: dt.date, *, open_adj: float, close_adj: float, high: float | None = None,
        low: float | None = None) -> tuple:
    """(date, open_adj, close_adj, high_adj, low_adj, open_raw, close_raw)"""
    return (day, open_adj, close_adj, high if high is not None else close_adj,
            low if low is not None else close_adj, open_adj, close_adj)


def event(d0: str, code: str, buy: float, path: list[tuple[float, float]],
          valid: bool = True, is_control: bool = False) -> method2.Event:
    """``path`` = 每个交易日的 (最高, 最低)，长度应 ≥ 35。"""
    highs: dict[int, float] = {}
    lows: dict[int, float] = {}
    top, bottom = 0.0, float("inf")
    for index, (high, low) in enumerate(path, start=1):
        top = max(top, high)
        bottom = min(bottom, low)
        if index in method2.WINDOWS:
            highs[index] = top
            lows[index] = bottom
    return method2.Event(d0=d0, code=code, name=code, buy_price=buy, highs=highs, lows=lows,
                         avail=len(path), is_control=is_control, valid=valid)


# --------------------------------------------------------------------------- #
# 注册表与契约
# --------------------------------------------------------------------------- #
def test_两个方法都注册且默认是方法1():
    specs = methods.list_specs()
    assert [spec.id for spec in specs] == ["stat_v1", "stat_v2"]
    assert methods.normalize(None) == "stat_v1"
    payload = methods.specs_payload()
    assert payload[0]["default"] is True
    assert payload[1]["forward_days"] == 35


def test_未知方法报错而不是静默降级():
    with pytest.raises(methods.UnknownMethod):
        methods.normalize("stat_v9")


def test_老任务没有方法字段按方法1():
    assert methods.method_of({"run_id": "x"}) == "stat_v1"
    assert methods.method_of({"method": "stat_v2"}) == "stat_v2"


def test_存储窗口与方法2窗口一致():
    # 两边写死是刻意的（避免 import 环），所以必须有一条断言钉住
    assert store.M2_WINDOWS == method2.WINDOWS


def test_方法2的产物清单就是规格那八个加一个按股票():
    assert set(method2.METHOD.outputs) == {
        "stock_event_metrics.csv", "window_summary.csv", "return_distribution.csv",
        "date_summary.csv", "coverage_summary.csv", "data_quality_report.csv",
        "baseline_comparison.csv", "stock_summary.csv", "report.md",
    }


# --------------------------------------------------------------------------- #
# 窗口统计与验收条件
# --------------------------------------------------------------------------- #
def test_累计窗口单调且达标率随目标递减():
    events = [
        event("2026-01-05", "A", 1.0, [(1.0, 0.98)] * 2 + [(1.12, 1.05)] * 33),
        event("2026-01-05", "B", 1.0, [(1.0, 0.97)] * 35),
        event("2026-01-06", "C", 1.0, [(1.02, 0.99)] * 35),
    ]
    summary = method2.window_summary(events)
    # 累计窗口：5 日的样本必然是 10 日样本的子集，达标率不会下降
    for target in method2.RETURN_TARGETS:
        key = f"hit_{method2.target_key(target)}_rate"
        rates = [row[key] for row in summary]
        assert rates == sorted(rates), f"{target} 的达标率随窗口下降：{rates}"
    # 目标越高，达标率越低
    for row in summary:
        rates = [row[f"hit_{method2.target_key(target)}_rate"] for target in method2.RETURN_TARGETS]
        assert rates == sorted(rates, reverse=True), rates
    assert method2.check_invariants(events, summary) == []


def test_自检能发现违规的窗口序列():
    # 人为造一个「第 10 日最高价低于第 5 日」的事件：累计窗口被破坏
    bad = method2.Event(d0="2026-01-05", code="X", name="X", buy_price=1.0,
                        highs={5: 1.2, 10: 1.1, 15: 1.3, 20: 1.3, 25: 1.3, 35: 1.3},
                        lows={5: 0.9}, avail=35, valid=True)
    problems = method2.check_invariants([bad], method2.window_summary([bad]))
    assert problems and "小于更短窗口" in problems[0]


def test_比例都能从计数复算():
    events = [event("2026-01-05", code, 1.0, [(1.03, 0.99)] * 35) for code in ("A", "B", "C")]
    summary = method2.window_summary(events)
    for row in summary:
        assert row["positive_rate"] == pytest.approx(100.0 * row["positive"] / row["valid"], abs=0.01)
        for target in method2.RETURN_TARGETS:
            key = method2.target_key(target)
            assert row[f"hit_{key}_rate"] == pytest.approx(
                100.0 * row[f"hit_{key}"] / row["valid"], abs=0.01)


def test_覆盖率的分母只含有有效命中的交易日():
    events = [
        event("2026-01-05", "A", 1.0, [(1.05, 0.99)] * 35),
        event("2026-01-06", "B", 1.0, [(0.99, 0.98)] * 35),
        event("2026-01-07", "C", 1.0, [(0.99, 0.98)] * 35, valid=False),
    ]
    rows = [row for row in method2.coverage_summary(method2.date_summary(events))
            if row["window"] == 5 and row["target"] == "≥3%"]
    assert len(rows) == 1
    assert rows[0]["days"] == 2          # 1/7 全是无效样本 → 不进分母
    assert rows[0]["days_with_hit"] == 1
    assert rows[0]["coverage_rate"] == 50.0


def test_最大不利波动是窗口内最低价():
    one = event("2026-01-05", "A", 1.0, [(1.05, 0.90)] * 2 + [(1.0, 0.95)] * 33)
    assert one.adverse_return(5) == pytest.approx(-0.10)
    assert one.max_return(5) == pytest.approx(0.05)


# --------------------------------------------------------------------------- #
# 结论与统一信封
# --------------------------------------------------------------------------- #
def test_样本不足时给样本不足():
    events = [event("2026-01-05", "A", 1.0, [(1.05, 0.99)] * 35)]
    report, _ = method2.build_from_events({"preset": "xg1"}, events, [])
    assert report.headline.verdict == "insufficient"
    assert report.schema_version == "1"
    assert report.method.id == "stat_v2"


def test_显著跑输时判更差():
    days = [f"2026-02-{day:02d}" for day in range(1, 29)]
    losers = [event(day, f"L{index:03d}", 1.0, [(0.99, 0.90)] * 35)
              for index, day in enumerate(days * 5)]
    winners = [event(day, f"W{index:03d}", 1.0, [(1.20, 0.99)] * 35)
               for index, day in enumerate(days * 4)]
    report, _ = method2.build_from_events({"preset": "xg1"}, losers, winners)
    assert report.headline.verdict == "worse"
    assert "更差" in report.headline.title


def test_统一信封带表格与产物():
    events = [event("2026-01-05", "A", 1.0, [(1.05, 0.99)] * 35)]
    report, payload = method2.build_from_events({"preset": "xg1"}, events, [])
    keys = [table.key for table in report.tables]
    for expected in ("window_summary", "baseline", "coverage", "distribution", "stocks", "quality"):
        assert expected in keys
    assert [artifact.name for artifact in report.artifacts] == list(method2.METHOD.outputs)
    assert payload["window_summary"][0]["valid"] == 1


# --------------------------------------------------------------------------- #
# 落库、去重、产物
# --------------------------------------------------------------------------- #
def test_重复事件去重并计数(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path)
    conn = store.open_db("sx", "run-m2")
    row = {
        "d0": "2026-01-05", "code": "600519", "symbol": "sh600519", "name": "贵州茅台",
        "board": "sh", "is_control": 0, "buy_price": 10.0, "d0_close": 10.0, "avail": 35,
        "entry_days": 1, "valid": 1, "reason": "",
        **{f"mh{window}": 11.0 for window in store.M2_WINDOWS},
        **{f"ml{window}": 9.0 for window in store.M2_WINDOWS},
    }
    store.insert_m2_events(conn, [row, row])
    events, duplicates = method2.load_events(conn)
    conn.close()
    assert duplicates == 1
    assert len(events) == 1
    assert events[0].max_return(35) == pytest.approx(0.10)


def test_产物写出全部文件(tmp_path):
    events = [event("2026-01-05", "A", 1.0, [(1.05, 0.99)] * 35)]
    _report, payload = method2.build_from_events({"preset": "xg1", "days_done": 1}, events, [])
    names = method2.write_artifacts(tmp_path, payload)
    assert names == list(method2.METHOD.outputs)
    for name in names:
        assert (tmp_path / name).is_file()
    text = (tmp_path / "report.md").read_text(encoding="utf-8")
    assert "统计分析方法 2" in text
    # CSV 带 BOM，Excel 打开中文表头不乱码
    assert (tmp_path / "window_summary.csv").read_bytes().startswith(b"\xef\xbb\xbf")


def test_对照组SQL聚合与事件聚合一致(tmp_path, monkeypatch):
    """大任务走 SQL 聚合、小样本走事件聚合，两条路的计数必须逐项相等。"""
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path)
    conn = store.open_db("sx", "run-agg")
    payload = []
    for index, code in enumerate(("A", "B", "C", "D")):
        high = 10.0 * (1 + 0.01 * (index + 1))
        payload.append({
            "d0": "2026-01-05" if index < 3 else "2026-01-06",
            "code": code, "symbol": f"sh{code}", "name": code, "board": "sh", "is_control": 1,
            "buy_price": 10.0, "d0_close": 10.0, "avail": 35, "entry_days": 1,
            "valid": 1, "reason": "",
            **{f"mh{window}": high for window in store.M2_WINDOWS},
            **{f"ml{window}": 9.0 for window in store.M2_WINDOWS},
        })
    store.insert_m2_events(conn, payload)
    events, _ = method2.load_events(conn, is_control=True)
    from_events = method2.aggregate_events(events)
    from_sql = method2.load_control_aggregates(conn)
    conn.close()
    for window in method2.WINDOWS:
        assert from_sql[window]["n"] == from_events[window]["n"] == 4
        assert from_sql[window]["positives"] == from_events[window]["positives"]
        assert from_sql[window]["rates"] == from_events[window]["rates"]
        for target in method2.RETURN_TARGETS:
            assert from_sql[window]["hits"][target] == from_events[window]["hits"][target]


# --------------------------------------------------------------------------- #
# 取数与口径
# --------------------------------------------------------------------------- #
def test_买入价是次日开盘且窗口极值含当日():
    days = fwd_days()
    bars = [bar(D0, open_adj=9.8, close_adj=10.0, high=10.1, low=9.7)]
    bars += [bar(day, open_adj=10.2, close_adj=10.5, high=10.6, low=10.0) for day in days]
    result = method2_data.build_event(bars, days, D0, "600000", method2.WINDOWS)
    assert result is not None
    assert result["buy_price"] == pytest.approx(10.2)
    assert result["valid"] is True
    assert result["mh"][5] == pytest.approx(10.6)
    assert result["mh"][35] == pytest.approx(10.6)
    # 涨幅以买入价为基准：10.6 / 10.2 - 1
    assert result["mh"][5] / result["buy_price"] - 1 == pytest.approx(0.0392, abs=1e-4)


def test_停牌日不新增极值但样本标为不完整():
    days = fwd_days()
    bars = [bar(D0, open_adj=10.0, close_adj=10.0)]
    for index, day in enumerate(days):
        if index == 3:          # 第 4 天停牌（没有这一根）
            continue
        bars.append(bar(day, open_adj=10.0, close_adj=10.3, high=10.4, low=9.9))
    result = method2_data.build_event(bars, days, D0, "600000", method2.WINDOWS)
    assert result is not None
    assert result["avail"] == 34
    assert result["valid"] is False
    assert result["reason"] == "incomplete_forward"
    # 停牌日不会把最高价拉低
    assert result["mh"][35] == pytest.approx(10.4)


def test_次日开盘涨停判为买不进():
    days = fwd_days()
    bars = [bar(D0, open_adj=10.0, close_adj=10.0)]
    bars += [bar(day, open_adj=11.0, close_adj=11.0) for day in days]
    result = method2_data.build_event(bars, days, D0, "600000", method2.WINDOWS)
    assert result is not None
    assert result["valid"] is False
    assert result["reason"] == "open_limit_up"


def test_复权因子缺失不冒充正常行情():
    days = fwd_days()
    bars = [bar(D0, open_adj=10.0, close_adj=10.0)]
    bars += [bar(day, open_adj=10.0, close_adj=10.0) for day in days]
    result = method2_data.build_event(bars, days, D0, "600000", method2.WINDOWS, adj_missing=2)
    assert result is not None
    assert result["valid"] is False
    assert result["reason"] == "adj_factor_missing"


def test_日历不足35天判为不完整():
    days = fwd_days(10)
    bars = [bar(D0, open_adj=10.0, close_adj=10.0)]
    bars += [bar(day, open_adj=10.0, close_adj=10.0) for day in days]
    result = method2_data.build_event(bars, days, D0, "600000", method2.WINDOWS)
    assert result is not None
    assert result["valid"] is False
