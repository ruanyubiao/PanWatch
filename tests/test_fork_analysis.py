"""数据分析后端：前瞻口径、停牌顺延、统计口径、Excel 列序。

这些用例全部**不碰 MySQL**：前瞻计算是纯函数（``build_forward``），统计层直接读
内存里的 SQLite。真实库的耗时与结果在服务器上另测（历史上「接口对了但口径错」
的返工都发生在这两层之间）。
"""

from __future__ import annotations

import datetime as dt
import sqlite3

import pytest

from src.modules.market.api import fork_analysis
from src.modules.market.fork_analysis import excel, forward, runner, stats, store

D0 = dt.date(2026, 1, 5)


def days(count: int, start: dt.date = D0) -> list[dt.date]:
    """构造一串交易日（不跳过周末：这里测的是顺延逻辑，不是日历本身）。"""
    return [start + dt.timedelta(days=offset) for offset in range(count)]


FORWARD_DAYS = days(31)[1:]


# ---------------------------------------------------------------------------
# 前瞻：涨幅基准、复权、停牌顺延、数据不足
# ---------------------------------------------------------------------------


def test_涨幅基准是_d0_收盘价():
    bars = [
        (D0, 10.0, 10.0, 10.2),
        (FORWARD_DAYS[0], 11.0, 11.0, 11.5),
        (FORWARD_DAYS[1], 9.0, 9.0, 9.1),
    ]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.d0_close == 10.0
    assert result.returns[0] == pytest.approx(0.10)
    assert result.returns[1] == pytest.approx(-0.10)
    # 第 3 天没有行情 → 顺延第 2 天（停牌前价格），不是 0
    assert result.returns[2] == pytest.approx(-0.10)
    assert result.returns[29] == pytest.approx(-0.10)
    assert result.avail == 2


def test_停牌期间涨幅等于停牌前那一天():
    # 第 5–10 天停牌（只有第 1–4 天与第 11 天之后的行情）
    bars = [(D0, 10.0, 10.0, 10.0)]
    for index in (0, 1, 2, 3):
        bars.append((FORWARD_DAYS[index], 10.0 + index + 1, 10.0 + index + 1, 10.0 + index + 1))
    bars.append((FORWARD_DAYS[10], 20.0, 20.0, 20.0))
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    # 第 4 天 = 14.0 → +40%；第 5..10 天全部等于它
    for day in range(4, 10):
        assert result.returns[day] == pytest.approx(0.40), day
    assert result.returns[10] == pytest.approx(1.00)
    assert result.avail == 5


def test_复权价格用于涨幅而_d0_收盘价保留真实价():
    bars = [
        (D0, 10.0, 20.0, 20.0),   # adj_factor = 2
        (FORWARD_DAYS[0], 5.0, 5.5, 5.5),  # 除权后：真实价腰斩，复权价 +10%
    ]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.d0_close == 10.0
    assert result.returns[0] == pytest.approx(-0.725)  # 5.5/20-1


def test_日历不够时尾部留空而不是记零():
    bars = [(D0, 10.0, 10.0, 10.0), (FORWARD_DAYS[0], 11.0, 11.0, 11.0)]
    result = forward.build_forward(bars, FORWARD_DAYS[:1])
    assert result is not None
    assert result.returns[0] == pytest.approx(0.10)
    assert result.returns[1] is None
    assert result.avail == 1


def test_整段没有行情时不给零收益():
    bars = [(D0, 10.0, 10.0, 10.0)]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.avail == 0
    assert all(value is None for value in result.returns)


def test_触及口径看最高价():
    bars = [
        (D0, 10.0, 10.0, 10.0),
        (FORWARD_DAYS[0], 10.0, 10.0, 12.0),   # 盘中冲到 +20%，收盘只有 0%
        (FORWARD_DAYS[1], 10.0, 9.0, 9.5),
    ]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.returns[0] == pytest.approx(0.0)
    # t5 是「5 天内最高价」→ 12.0/10-1 = 20%
    assert result.touches[0] == pytest.approx(0.20)


def test_代码到市场的映射与条件选股一致():
    assert forward.board_of("600519") == "sh"
    assert forward.board_of("000001") == "sz"
    assert forward.board_of("300750") == "cyb"
    assert forward.board_of("688111") == "kcb"
    assert forward.board_of("920001") == "other"


# ---------------------------------------------------------------------------
# 统计口径
# ---------------------------------------------------------------------------


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """一个临时的任务库（不动仓库里的 data/）。"""
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path)
    conn = store.open_db("sx", "run-1")
    yield conn
    conn.close()


def _signal(conn: sqlite3.Connection, code: str, d0: str, closes: dict[int, float], **over):
    row = {
        "d0": d0,
        "code": code,
        "symbol": f"sh{code}",
        "name": f"股票{code}",
        "board": "sh",
        "is_control": 0,
        "d0_close": 10.0,
        "avail": 30,
    }
    for index in range(1, 31):
        row[f"r{index}"] = closes.get(index, 0.0)
    for horizon in (5, 10, 15, 20, 25, 30):
        row[f"t{horizon}"] = closes.get(horizon, 0.0)
    row.update(over)
    store.insert_signals(conn, [row])


def test_胜率与超额(db):
    # 条件组：3 条信号，5 日两涨一跌；对照组 2 条全跌
    _signal(db, "600000", "2026-01-05", {i: 0.05 for i in range(1, 31)})
    _signal(db, "600001", "2026-01-05", {i: 0.03 for i in range(1, 31)})
    _signal(db, "600002", "2026-01-06", {i: -0.02 for i in range(1, 31)})
    for code in ("600010", "600011"):
        _signal(db, code, "2026-01-05", {i: -0.01 for i in range(1, 31)}, is_control=1)

    rows = stats.summary(db)
    five = next(row for row in rows if row["horizon"] == 5)
    assert five["signal"]["n"] == 3
    assert five["signal"]["win_rate"] == pytest.approx(66.67, abs=0.01)
    assert five["control"]["win_rate"] == pytest.approx(0.0)
    assert five["excess_pp"] == pytest.approx(66.67, abs=0.01)
    # 平均涨幅 = (5+3-2)/3 = 2%
    assert five["signal"]["avg_return"] == pytest.approx(2.0, abs=0.01)
    assert five["signal"]["payoff"] == pytest.approx(4.0 / 2.0, abs=0.01)


def test_样本不足时结论标为不能用(db):
    _signal(db, "600000", "2026-01-05", {i: 0.10 for i in range(1, 31)})
    _signal(db, "600010", "2026-01-05", {i: -0.01 for i in range(1, 31)}, is_control=1)
    rows = stats.summary(db)
    assert stats.verdict(rows)["usable"] is False
    assert stats.verdict(rows)["reason"] == "insufficient"


def test_显著跑输随机时结论是_worse(db):
    """120 条条件信号里 30% 上涨，200 条对照里 60% 上涨 → 显著为负。

    这是真实场景的形态（云端 xg1 在 2026 年就是这个结果）：胜率不是「高一点」，
    而是**统计显著地比随机买入差**，结论必须说「要重新设计」，不能只说「没优势」。
    """
    for index in range(120):
        _signal(db, f"60{index:04d}", "2026-01-05",
                {i: (0.02 if index % 10 < 3 else -0.02) for i in range(1, 31)})
    for index in range(200):
        _signal(db, f"00{index:04d}", "2026-01-05",
                {i: (0.02 if index % 10 < 6 else -0.02) for i in range(1, 31)}, is_control=1)
    result = stats.verdict(stats.summary(db))
    assert result["usable"] is False
    assert result["reason"] == "worse"
    assert result["worst_horizon"] == 5
    assert result["worst_excess_pp"] < 0


def test_个股排行按十日在榜且带样本是否足够(db):
    for index in range(3):
        _signal(db, "600000", f"2026-01-{5 + index:02d}", {i: 0.02 for i in range(1, 31)})
    _signal(db, "600001", "2026-01-05", {i: -0.02 for i in range(1, 31)})
    items = stats.by_stock(db, {5: 0.0, 10: 0.0, 15: 0.0, 20: 0.0, 25: 0.0, 30: 0.0})
    assert [item["code"] for item in items] == ["600000", "600001"]
    assert items[0]["n"] == 3
    assert items[0]["win"]["10"] == pytest.approx(100.0)
    assert items[0]["sufficient"] is False  # 3 < 30 次


def test_年度与市场分组带对照组(db):
    _signal(db, "600000", "2025-06-03", {i: 0.02 for i in range(1, 31)})
    _signal(db, "300001", "2026-06-03", {i: 0.02 for i in range(1, 31)}, board="cyb")
    _signal(db, "600010", "2026-06-03", {i: -0.02 for i in range(1, 31)}, is_control=1)
    years = {row["key"]: row for row in stats.by_year(db)}
    assert years["2025"]["control"] is None
    assert years["2026"]["signal"]["5"]["win_rate"] == pytest.approx(100.0)
    boards = {row["key"]: row for row in stats.by_board(db)}
    assert set(boards) == {"sh", "cyb"}


# ---------------------------------------------------------------------------
# 存储 / 任务状态
# ---------------------------------------------------------------------------


def test_任务目录与断点记录(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path)
    meta = {
        "run_id": "20260101-000000-abcd",
        "preset": "sx",
        "created_at": store._now(),
        "status": store.STATUS_RUNNING,
        "start_date": "2026-01-01",
        "end_date": "2026-01-31",
    }
    store.save_meta("sx", meta)
    conn = store.open_db("sx", "20260101-000000-abcd")
    store.record_day(conn, "2026-01-05", 3, 200, 3100)
    assert store.done_days(conn) == ["2026-01-05"]
    assert store.counts(conn)["days"] == 1
    conn.close()
    assert (tmp_path / "sx" / meta["run_id"] / "meta.json").is_file()
    assert store.find_run(meta["run_id"])[0] == "sx"
    store.request_stop("sx", meta["run_id"])
    assert store.stop_requested("sx", meta["run_id"]) is True


def test_Excel_列序与文件名(tmp_path, monkeypatch, db):
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path / "runs")
    store.open_db("sx", "run-1").close()  # 在新目录下建库（覆盖 fixture 的连接）
    conn = store.open_db("sx", "run-1")
    _signal(conn, "000001", "2026-01-05", {1: 0.0123, 30: -0.0456})
    path = excel.write_workbook(conn, "sx", "run-1")
    conn.close()

    from openpyxl import load_workbook

    workbook = load_workbook(path)
    assert workbook.sheetnames == ["明细", "按股票", "汇总"]
    header = [cell.value for cell in workbook["明细"][1]]
    assert header[:5] == ["日期", "股票代码", "股票名称", "d0收盘价", "第1天涨幅"]
    assert header[-2] == "第30天涨幅"
    assert header[-1] == "实际可取天数"
    first = [cell.value for cell in workbook["明细"][2]]
    assert first[0] == "2026-01-05"
    assert first[1] == "000001"          # 代码保持文本（Excel 不会把 000001 变成 1）
    assert first[4] == pytest.approx(1.23)   # 百分点
    assert first[-2] == pytest.approx(-4.56)
    summary_header = [cell.value for cell in workbook["汇总"][1]]
    assert summary_header[0] == "持有周期(交易日)"
    assert "超额(百分点)" in summary_header


# ---------------------------------------------------------------------------
# 端点：只验编排与错误码（业务实现被 monkeypatch 掉）
# ---------------------------------------------------------------------------


def test_创建接口把异常翻译成错误码(monkeypatch):
    from fastapi import HTTPException

    def boom(payload):
        raise runner.AnalysisBusy("已有一个在跑")

    monkeypatch.setattr(runner, "create", boom)
    payload = fork_analysis.AnalysisCreate(preset="sx", start_date=dt.date(2026, 1, 1))
    with pytest.raises(HTTPException) as excinfo:
        fork_analysis.create_analysis_run(payload)
    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["code"] == "analysis_busy"


def test_找不到任务返回_404(monkeypatch, tmp_path):
    from fastapi import HTTPException

    monkeypatch.setattr(store, "RUNS_DIR", tmp_path)
    with pytest.raises(HTTPException) as excinfo:
        fork_analysis.get_analysis_run("nope")
    assert excinfo.value.status_code == 404
    assert excinfo.value.detail["code"] == "analysis_run_not_found"


def test_重启后_running_线程已死的任务显示中断(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path)
    meta = {
        "run_id": "20260101-000000-abcd",
        "preset": "sx",
        "created_at": store._now(),
        "status": store.STATUS_RUNNING,
    }
    store.save_meta("sx", meta)
    view = fork_analysis._meta_view("sx", store.load_meta("sx", meta["run_id"]))
    assert view["status"] == "interrupted"
    assert view["running"] is False
