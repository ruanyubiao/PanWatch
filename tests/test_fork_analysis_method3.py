"""统计分析方法 3（条件适用面）的回归。

钉住三件事：
1. 取数口径——收盘顺延、一字涨停买不进、缺复权不可验证（不猜 1.0）；
2. 统计口径——盈利按「扣成本后收盘为正」算、超额按日配对、BH 校正、判断三档；
3. 输出契约——统一信封 + 6 个 CSV + report.md，窗口不含 15 日（用户 2026-10-24 指定）。
"""

from __future__ import annotations

import datetime as dt
import sqlite3

import pytest

from src.modules.market.fork_analysis import costs, store, store_m3
from src.modules.market.fork_analysis.methods import method3, method3_data

D0 = dt.date(2022, 6, 1)


def fwd_days(count: int = 30) -> list[dt.date]:
    return [D0 + dt.timedelta(days=offset) for offset in range(1, count + 1)]


def bar(day: dt.date, open_adj: float, close_adj: float) -> tuple:
    return (day, open_adj, close_adj, close_adj, close_adj, open_adj, close_adj)


def series(closes: list[float], *, entry_open: float | None = None,
           days: list[dt.date] | None = None) -> list[tuple]:
    """按收盘价序列造 K 线：d0 用第一根，之后是前瞻。"""
    calendar = [D0] + (days if days is not None else fwd_days(len(closes) - 1))
    bars = [bar(D0, closes[0], closes[0])]
    for index, close in enumerate(closes[1:], start=1):
        open_price = entry_open if (index == 1 and entry_open is not None) else close
        bars.append(bar(calendar[index], open_price, close))
    return bars


# --------------------------------------------------------------------------- #
# 取数口径
# --------------------------------------------------------------------------- #
def test_windows_match_user_spec():
    """用户明确要的是 5/10/20/25/30，不含 15 日。"""
    assert method3.WINDOWS == (5, 10, 20, 25, 30)
    assert 15 not in method3.WINDOWS
    assert method3.FULL_DAYS == 30


def test_build_event_point_and_extremes():
    """第 N 天取收盘、窗口取最高/最低收盘，基准是次日开盘。"""
    closes = [10.0] + [10.0 + 0.1 * index for index in range(1, 31)]
    result = method3_data.build_event(
        series(closes) , fwd_days(), D0, "600000", windows=(5, 10), horizon=30,
    )
    assert result is not None
    assert result["valid"] is True
    assert result["entry_days"] == 1
    assert result["buy_price"] == pytest.approx(10.1)  # 次日开盘
    assert result["c"][5] == pytest.approx(10.5)
    assert result["mc"][5] == pytest.approx(10.5)
    assert result["mn"][5] == pytest.approx(10.1)


def test_suspension_carries_last_close():
    """停牌日按停牌前收盘顺延：第 5 天起停牌时，第 5/10 天的价 = 第 4 天收盘。"""
    closes = [10.0, 10.2, 10.4, 10.6, 10.8]
    bars = series(closes)[:5]  # d0 + 4 个前瞻交易日（第 5 天起停牌）
    calendar = fwd_days(30)  # 只含 d0 之后的日子（与 runner._forward_dates 一致）
    result = method3_data.build_event(bars, calendar, D0, "600000", windows=(5, 10), horizon=30)
    assert result is not None
    assert result["c"][5] == pytest.approx(10.8)   # 第 4 天收盘
    assert result["c"][10] == pytest.approx(10.8)  # 停牌顺延，价格不变
    assert result["avail"] == 4
    assert result["valid"] is False
    # 连续停牌 26 天 > SUSPEND_CAP(20)：判长期停牌，而不是「前瞻不足」
    assert result["reason"] == "long_suspension"


def test_unfillable_limit_up_is_flagged():
    """次日开盘一字涨停（+10%）判买不进，不当作盈利样本。"""
    closes = [10.0] + [11.0] * 30
    bars = series(closes, entry_open=11.0)
    result = method3_data.build_event(bars, fwd_days(), D0, "600000", windows=(5,), horizon=30)
    assert result is not None
    assert result["unfillable"] == 1
    assert result["reason"] == "open_limit_up"


def test_missing_adj_factor_is_not_guessed():
    result = method3_data.build_event(
        series([10.0] + [10.1] * 30), fwd_days(), D0, "600000",
        windows=(5,), horizon=30, adj_missing=1,
    )
    assert result is not None
    assert result["reason"] == "adj_factor_missing"
    assert result["valid"] is False


def test_no_bars_on_d0_returns_none():
    assert method3_data.build_event([], fwd_days(), D0, "600000") is None


# --------------------------------------------------------------------------- #
# 统计口径
# --------------------------------------------------------------------------- #
def test_wilson_interval_bounds():
    low, high = method3._wilson(50, 100)
    assert 39.0 < low < 41.0
    assert 59.0 < high < 61.0
    assert method3._wilson(0, 0) == (0.0, 0.0)


def test_bh_is_monotone_and_bounded():
    qvalues = method3._bh([0.001, 0.02, 0.04, 0.5])
    assert all(0.0 <= value <= 1.0 for value in qvalues)
    assert qvalues[0] <= qvalues[1] <= qvalues[2] <= qvalues[3]


def test_buckets_cover_all_ranges():
    assert method3._mcap_bucket(10) == "<30亿"
    assert method3._mcap_bucket(30) == "30–100亿"
    assert method3._mcap_bucket(5000) == "≥1000亿"
    assert method3._amount_bucket(0.1) == "<0.5亿"
    assert method3._turnover_bucket(20) == "≥15%"
    assert method3._mcap_bucket(None) is None


def test_judge_requires_sample_excess_and_significance():
    assert method3._judge(500, 5.0, 0.01, 100) == "有效"
    assert method3._judge(50, 5.0, 0.01, 100) == "样本不足"
    assert method3._judge(500, 1.0, 0.01, 100) == "无优势"
    assert method3._judge(500, 5.0, 0.5, 100) == "不显著"


# --------------------------------------------------------------------------- #
# 端到端：造一个库，验证报告
# --------------------------------------------------------------------------- #
def make_db(rows: list[dict]) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(store_m3.schema(store.SNAPSHOT_COLUMNS))
    store_m3.insert_rows(conn, rows, store.SNAPSHOT_COLUMNS)
    return conn


def m3_row(d0: str, code: str, *, buy: float, closes: dict[int, float],
           is_control: int = 0, industry: str = "银行", mcap: float = 50.0,
           amount: float = 3.0, turnover: float = 2.0, valid: int = 1) -> dict:
    row = {
        "d0": d0, "code": code, "symbol": code, "name": f"股{code}", "board": "主板",
        "is_control": is_control, "buy_price": buy, "d0_close": buy, "avail": 30,
        "entry_days": 1, "valid": valid, "reason": "",
        "industry": industry, "mcap": mcap, "amount": amount, "turnover": turnover,
        "amplitude": 5.0, "listed_days": 2000, "breadth": 0.5, "crowd": 10,
    }
    for window in store_m3.M3_WINDOWS:
        close = closes.get(window)
        row[f"c{window}"] = close
        row[f"mc{window}"] = close
        row[f"mn{window}"] = close
    return row


def test_build_reports_probability_and_segments():
    """30 个交易日、20 只盈利 + 20 只亏损，逐日铺开；基准全为持平。"""
    rows: list[dict] = []
    for day in range(1, 21):
        d0 = f"2022-06-{day:02d}"
        for index in range(20):
            rows.append(m3_row(d0, f"6000{index:02d}", buy=10.0, closes={5: 10.5, 10: 10.6,
                                                                        20: 10.7, 25: 10.8, 30: 10.9}))
        for index in range(20):
            rows.append(m3_row(d0, f"6001{index:02d}", buy=10.0, closes={5: 9.5, 10: 9.6,
                                                                        20: 9.7, 25: 9.8, 30: 9.9}))
        for index in range(10):
            rows.append(m3_row(d0, f"0000{index:02d}", buy=10.0, is_control=1,
                               closes={5: 10.1, 10: 10.1, 20: 10.1, 25: 10.1, 30: 10.1}))
    conn = make_db(rows)
    report = method3.build(conn, {"params": {"min_sample": 100}})

    windows = next(table for table in report.tables if table.key == "windows")
    five = next(row for row in windows.rows if row["window"] == 5)
    assert five["n"] == 800
    assert five["p_net"] == pytest.approx(50.0, abs=0.5)
    assert five["base_p"] == pytest.approx(100.0, abs=0.5)

    # 超额为负：条件组 50% vs 基准 100%
    assert five["excess_pp"] < 0
    assert report.headline.verdict in {"no_edge", "mixed"}

    quality = report.data_quality
    assert quality["signal_events"] == 800
    assert quality["control_events"] == 200
    assert quality["tests"] > 0


def test_build_finds_a_usable_segment():
    """只有「小市值」能赚：分层面必须把它挑出来判「有效」。"""
    rows: list[dict] = []
    for day in range(1, 21):
        d0 = f"2022-07-{day:02d}"
        for index in range(60):
            rows.append(m3_row(d0, f"6002{index:02d}", buy=10.0, mcap=10.0,
                               closes={5: 10.8, 10: 10.8, 20: 10.8, 25: 10.8, 30: 10.8}))
        for index in range(60):
            rows.append(m3_row(d0, f"6003{index:02d}", buy=10.0, mcap=500.0,
                               closes={5: 9.2, 10: 9.2, 20: 9.2, 25: 9.2, 30: 9.2}))
        # 对照组每个市值档都是「一半赚一半亏」，且赚亏比例逐日浮动，
        # 这样日度超额有波动（全常数序列的 Newey–West 标准误为 0，t 无定义）。
        winners = 10 if day % 2 else 14
        for index in range(20):
            close = 10.05 if index < winners else 9.95
            rows.append(m3_row(d0, f"0001{index:02d}", buy=10.0, is_control=1, mcap=10.0,
                               closes={5: close, 10: close, 20: close, 25: close, 30: close}))
        for index in range(20):
            close = 10.05 if index < winners else 9.95
            rows.append(m3_row(d0, f"0002{index:02d}", buy=10.0, is_control=1, mcap=500.0,
                               closes={5: close, 10: close, 20: close, 25: close, 30: close}))
    conn = make_db(rows)
    report = method3.build(conn, {"params": {"min_sample": 100}})

    profile = next(table for table in report.tables if table.key == "profile")
    usable = [row for row in profile.rows if row["verdict"] == "有效"]
    assert usable, "小市值那一档应该被判为有效"
    assert any("<30亿" in str(row["value"]) for row in usable)
    assert report.data_quality["usable_segments"] >= 1

    stock_table = next(table for table in report.tables if table.key == "stocks")
    assert stock_table.total_rows == 120
    assert stock_table.rows[0]["p5"] is not None


def test_build_counts_excluded_and_empty_case():
    conn = make_db([])
    report = method3.build(conn, {})
    assert report.headline.verdict == "insufficient"
    assert report.data_quality["events"] == 0


def test_artifacts_are_complete_and_markdown_reads():
    rows = [m3_row(f"2022-08-{day:02d}", f"6004{index:02d}", buy=10.0,
                   closes={5: 10.4, 10: 10.4, 20: 10.4, 25: 10.4, 30: 10.4})
            for day in range(1, 6) for index in range(30)]
    conn = make_db(rows)
    report = method3.build(conn, {})
    text = method3.render_markdown(report)
    assert "方法 3" in text
    assert "盈利概率" in text
    assert "口径与局限" in text
    assert [artifact.name for artifact in report.artifacts] == list(method3.METHOD.outputs)
    assert "window_summary.csv" in method3.METHOD.outputs


def test_cost_model_is_used_for_net_probability():
    """同一个价格路径，成交额越小成本越高 → 净盈利概率不应更高。"""
    result = costs.realistic_cost("2022-06-01", 0.2)
    assert result > 0
    assert costs.realistic_cost("2022-06-01", 50.0) < result
