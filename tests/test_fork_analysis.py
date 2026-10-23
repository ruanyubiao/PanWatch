"""数据分析后端：前瞻口径、停牌顺延、统计口径、Excel 列序。

这些用例全部**不碰 MySQL**：前瞻计算是纯函数（``build_forward``），统计层直接读
内存里的 SQLite。真实库的耗时与结果在服务器上另测（历史上「接口对了但口径错」
的返工都发生在这两层之间）。
"""

from __future__ import annotations

import datetime as dt
import sqlite3

import numpy as np

import pytest

from src.modules.market.api import fork_analysis
from src.modules.market.fork_analysis import (
    ablation,
    attribution,
    entry,
    excel,
    forward,
    health,
    leaderboard,
    portfolio,
    runner,
    significance,
    stats,
    store,
)

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
    # 但顺延有上限：超过 20 个交易日后不再编数（那天起多半是退市/长停）
    assert result.returns[forward.SUSPEND_CAP] == pytest.approx(-0.10)
    assert result.returns[forward.SUSPEND_CAP + 1] == pytest.approx(-0.10)
    assert result.returns[forward.SUSPEND_CAP + 2] is None
    assert result.verif == 0
    assert result.stale_days > forward.SUSPEND_CAP
    assert result.avail == 2


def test_顺延超过上限标记不可验证():
    """长期停牌/退市：不能把「一路跌到退市」记成「不涨不跌 0%」。"""
    bars = [(D0, 10.0, 10.0, 10.0), (FORWARD_DAYS[0], 9.0, 9.0, 9.0)]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.verif == 0
    assert result.returns[5] == pytest.approx(-0.10)      # 上限内照常顺延
    assert result.returns[forward.SUSPEND_CAP + 2] is None


def test_可执行口径用次日开盘买入():
    """信号在收盘后才成立：入场价必须是次日开盘，不是 d0 收盘。"""
    bars = [
        (D0, 10.0, 10.0, 10.0, 10.0, 10.0),            # date, open, close, close_adj, open_adj, high_adj
        (FORWARD_DAYS[0], 10.5, 11.0, 11.0, 10.5, 11.0),  # 次日开盘 +5%（没涨停），收盘 +10%
        (FORWARD_DAYS[1], 11.0, 12.1, 12.1, 11.0, 12.1),
    ]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.entry_open == pytest.approx(10.5)
    assert result.entry_days == 1
    # 收盘口径：第 1 天 = 11/10-1 = +10%；可执行口径：第 1 天 = 11/10.5-1
    assert result.returns[0] == pytest.approx(0.10)
    assert result.exec_returns[0] == pytest.approx(11.0 / 10.5 - 1, abs=1e-6)
    assert result.exec_returns[1] == pytest.approx(12.1 / 10.5 - 1, abs=1e-6)
    assert result.unfillable is False


def test_次日开盘涨停标记买不进():
    bars = [
        (D0, 10.0, 10.0, 10.0, 10.0, 10.0),
        (FORWARD_DAYS[0], 11.0, 11.0, 11.0, 11.0, 11.0),   # 主板 +10% 开盘 = 一字涨停
        (FORWARD_DAYS[1], 11.5, 12.0, 12.0, 11.5, 12.1),
    ]
    result = forward.build_forward(bars, FORWARD_DAYS, limit=0.10)
    assert result is not None
    assert result.unfillable is True
    # 创业板 20%：同样的 +10% 开盘不算涨停
    wide = forward.build_forward(bars, FORWARD_DAYS, limit=0.20)
    assert wide is not None and wide.unfillable is False


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
    rows = stats.summary(db)
    baseline = stats.overall_win(rows)
    control = stats.control_win_rates(rows)
    years = {row["key"]: row for row in stats.by_year(db, stats.HORIZONS, baseline, control)}
    assert years["2025"]["control"] is None
    assert years["2026"]["signal"]["5"]["win_rate"] == pytest.approx(100.0)
    boards = {row["key"]: row for row in stats.by_board(db, stats.HORIZONS, baseline, control)}
    assert set(boards) == {"sh", "cyb"}
    # 界面上不显示对照组：分组里的 excess 是「相对条件整体」，不是相对随机买入
    assert years["2026"]["excess"]["5"] == pytest.approx(0.0)


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
    assert workbook.sheetnames == ["明细", "按股票", "汇总", "分组胜率", "年度稳定性", "行业×市值"]
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


# ---------------------------------------------------------------------------
# v2 口径（2026-10-22 第二次改版）
# ---------------------------------------------------------------------------


def test_验证天数决定统计周期():
    from src.modules.market.fork_analysis.models import horizons_for

    assert horizons_for(30) == (5, 10, 15, 20, 25, 30)
    assert horizons_for(12) == (5, 10)      # 不额外补 12
    assert horizons_for(10) == (5, 10)
    assert horizons_for(3) == (3,)          # 少于 5 天只剩自己
    assert horizons_for(1) == (1,)


def test_创建请求校验验证天数():
    from pydantic import ValidationError

    from src.modules.market.fork_analysis.models import AnalysisCreate

    with pytest.raises(ValidationError):
        AnalysisCreate(preset="sx", start_date=dt.date(2026, 1, 1), validate_days=0)
    with pytest.raises(ValidationError):
        AnalysisCreate(preset="sx", start_date=dt.date(2026, 1, 1), validate_days=31)
    assert AnalysisCreate(preset="sx", start_date=dt.date(2026, 1, 1)).validate_days == 30


def test_BH_校正保持单调且不超一():
    qvalues = stats.bh_qvalues([0.001, 0.02, 0.5, 0.9])
    assert all(0.0 <= q <= 1.0 for q in qvalues)
    assert qvalues[0] <= qvalues[1] <= qvalues[3]


def test_分组统计能按行业与市值分桶(db):
    for index, industry in enumerate(["半导体", "半导体", "白酒"]):
        _signal(db, f"60000{index}", f"2026-01-0{index + 5}",
                {i: 0.02 for i in range(1, 31)}, industry=industry)
    rows = stats.summary(db)
    blocks = {block["dim"]: block for block in
              stats.groups(db, stats.HORIZONS, stats.overall_win(rows))}
    industries = {item["key"]: item["n"] for item in blocks["industry"]["items"]}
    assert industries == {"半导体": 2, "白酒": 1}
    # 样本 < 100 的分组必须标成「样本不足」，不能让 1 条 100% 胜率排到前面
    assert all(item["verdict"] == "insufficient" for item in blocks["industry"]["items"])


def test_到达天数分布回答几天内能走出来(db):
    # 第 3 天才第一次收涨
    _signal(db, "600000", "2026-01-05", {1: -0.01, 2: -0.01, 3: 0.02,
                                         4: 0.02, 5: 0.02, 10: 0.02, 15: 0.02, 20: 0.02,
                                         25: 0.02, 30: 0.02})
    _signal(db, "600001", "2026-01-05", {i: -0.01 for i in range(1, 31)})
    data = stats.arrival(db, stats.HORIZONS)
    assert data["median_days"] == 3
    assert data["within"]["5"] == pytest.approx(50.0)
    assert data["within"]["30"] == pytest.approx(50.0)


def test_Excel_明细列数跟随验证天数(tmp_path, monkeypatch, db):
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path / "runs")
    store.open_db("sx", "run-12").close()
    conn = store.open_db("sx", "run-12")
    store.save_meta("sx", {"run_id": "run-12", "preset": "sx", "created_at": store._now(),
                           "status": store.STATUS_DONE, "validate_days": 12})
    _signal(conn, "000001", "2026-01-05", {1: 0.01, 12: 0.05})
    path = excel.write_workbook(conn, "sx", "run-12")
    conn.close()

    from openpyxl import load_workbook

    workbook = load_workbook(path)
    header = [cell.value for cell in workbook["明细"][1]]
    assert header[-2] == "第12天涨幅"
    assert header[-1] == "实际可取天数"
    assert "第13天涨幅" not in header


def test_老库缺快照列时报告不炸且能自动补列(tmp_path, monkeypatch):
    """v2 之前的 signals.db 没有 industry/mcap… 列：报告要能跑，列要能自动补上。"""
    monkeypatch.setattr(store, "RUNS_DIR", tmp_path / "runs")
    run_id = "legacy-1"
    directory = store.run_dir("sx", run_id)
    directory.mkdir(parents=True)
    legacy = sqlite3.connect(directory / "signals.db")
    legacy.executescript(
        "CREATE TABLE days (d0 TEXT PRIMARY KEY, hits INTEGER, control INTEGER, elapsed_ms INTEGER);"
        "CREATE TABLE signals (id INTEGER PRIMARY KEY, d0 TEXT, code TEXT, symbol TEXT, name TEXT,"
        " board TEXT, is_control INTEGER, d0_close REAL, avail INTEGER);"
    )
    legacy.execute("INSERT INTO days VALUES ('2026-01-05', 1, 0, 100)")
    legacy.execute(
        "INSERT INTO signals (d0, code, symbol, name, board, is_control, d0_close, avail) "
        "VALUES ('2026-01-05', '600000', 'sh600000', '浦发银行', 'sh', 0, 10.0, 30)"
    )
    for index in range(1, 31):
        legacy.execute(f"ALTER TABLE signals ADD COLUMN r{index} REAL")
    for horizon in (5, 10, 15, 20, 25, 30):
        legacy.execute(f"ALTER TABLE signals ADD COLUMN t{horizon} REAL")
    legacy.execute("UPDATE signals SET r5 = 0.02, r10 = 0.03, r30 = -0.01")
    legacy.commit()
    legacy.close()
    store.save_meta("sx", {"run_id": run_id, "preset": "sx", "created_at": store._now(),
                           "status": store.STATUS_DONE, "validate_days": 30})

    conn = store.open_db_readonly("sx", run_id)      # 只读打开时要先补列
    report = stats.build_report(conn, store.load_meta("sx", run_id))
    conn.close()
    assert report["validate_days"] == 30
    assert any(block["dim"] == "industry" for block in report["groups"])
    # 老数据没有行业 → 全部落在「未知」，不能报错
    industries = {item["key"] for block in report["groups"] if block["dim"] == "industry"
                  for item in block["items"]}
    assert industries == {"未知"}


# ---------------------------------------------------------------------------
# 诚实显著性：重叠样本、按日聚合、口径回退
# ---------------------------------------------------------------------------


def _bulk(conn: sqlite3.Connection, day: str, n_sig: int, wins_sig: int,
          n_ctl: int, wins_ctl: int) -> None:
    """一天里写 n_sig 条条件信号（其中 wins_sig 条上涨）+ n_ctl 条对照。"""
    rows = []
    for index in range(n_sig):
        rows.append({
            "d0": day, "code": f"6{index:05d}", "symbol": f"sh6{index:05d}",
            "name": "S", "board": "sh", "is_control": 0, "d0_close": 10.0, "avail": 30,
            **{f"r{i}": (0.05 if index < wins_sig else -0.05) for i in range(1, 31)},
            **{f"t{i}": 0.05 for i in (5, 10, 15, 20, 25, 30)},
        })
    for index in range(n_ctl):
        rows.append({
            "d0": day, "code": f"0{index:05d}", "symbol": f"sz0{index:05d}",
            "name": "C", "board": "sz", "is_control": 1, "d0_close": 10.0, "avail": 30,
            **{f"r{i}": (0.05 if index < wins_ctl else -0.05) for i in range(1, 31)},
            **{f"t{i}": 0.05 for i in (5, 10, 15, 20, 25, 30)},
        })
    store.insert_signals(conn, rows)


def test_按日聚合能把重叠样本的假显著压下去(db):
    """同样的合并胜率，日度稳定性不同 → 结论必须不同。

    旧的合并 z 检验只看「几千行里 60% vs 50%」，两份数据都给 z≈7（极显著）；
    按日聚合后，每天都是 +10pp 的那份仍然显著，「三天 +30pp 三天 −10pp」的那份
    区间跨 0 —— 后者不能说自己靠得住。
    """
    # 两份数据放在两个库里，避免互相污染
    db_a = store.open_db("sx", "run-a")
    db_b = store.open_db("sx", "run-b")
    # A：6 天，每天都是 60% vs 50%（日度超额稳定在 +10pp）
    for day in range(6):
        _bulk(db_a, f"2026-01-{day + 1:02d}", 400, 240, 400, 200)
    tests_a, _ = significance.tests(db_a, [5])
    # B：6 天，三天 80% vs 50%、三天 40% vs 50%（合并仍是 60% vs 50%）
    for day in range(3):
        _bulk(db_b, f"2026-02-{day + 1:02d}", 400, 320, 400, 200)
        _bulk(db_b, f"2026-02-{day + 11:02d}", 400, 160, 400, 200)
    tests_b, _ = significance.tests(db_b, [5])
    assert tests_a[0]["pooled_excess_pp"] == pytest.approx(10.0, abs=0.01)
    assert tests_b[0]["pooled_excess_pp"] == pytest.approx(10.0, abs=0.01)
    assert tests_a[0]["significant_up"] is True
    assert tests_b[0]["significant_up"] is False


def test_有效样本量按周期折算(db):
    for day in range(60):
        _bulk(db, f"2026-03-{day % 28 + 1:02d}" if day < 28 else f"2026-04-{day - 27:02d}", 10, 6, 10, 5)
    tests, _ = significance.tests(db, [5, 30])
    five, thirty = tests
    assert five["days"] == 60
    assert five["n_eff"] == 12      # 60 / 5
    assert thirty["n_eff"] == 2     # 60 / 30


def test_自助区间可复现(db):
    for day in range(30):
        _bulk(db, f"2026-05-{day + 1:02d}", 20, 12, 20, 10)
    first, _ = significance.tests(db, [10])
    significance._MEM_CACHE.clear() if hasattr(significance, "_MEM_CACHE") else None
    second, _ = significance.tests(db, [10])
    assert first[0]["ci_low_pp"] == second[0]["ci_low_pp"]
    assert first[0]["ci_high_pp"] == second[0]["ci_high_pp"]


def test_结论要求至少两个周期同向显著(db):
    rows = [
        {"horizon": 5, "days": 100, "mean_excess_pp": 5.0, "ci_low_pp": 1.0,
         "ci_high_pp": 9.0, "significant_up": True, "significant_down": False},
        {"horizon": 10, "days": 100, "mean_excess_pp": 1.0, "ci_low_pp": -3.0,
         "ci_high_pp": 5.0, "significant_up": False, "significant_down": False},
    ]
    assert significance.conclusion(rows)["verdict"] != "usable"
    rows[1].update({"mean_excess_pp": 4.0, "ci_low_pp": 0.5, "ci_high_pp": 7.0,
                    "significant_up": True})
    assert significance.conclusion(rows)["verdict"] == "usable"


def test_没有可执行口径时退回收盘口径(db):
    _bulk(db, "2026-06-01", 10, 6, 10, 5)
    prefix, caliber = significance.caliber_columns(db)
    assert prefix == "r" and caliber == "close"


def test_个股排行按收缩后胜率排序(db):
    """命中 2 次全胜的股票不该排在命中 40 次 70% 的股票前面。"""
    for day in range(20):
        _bulk(db, f"2026-07-{day + 1:02d}", 2, 2, 5, 2)     # 每天两只「全胜」小样本股
    # 一只大样本股：40 次里 28 次上涨（70%）
    rows = []
    for index in range(40):
        rows.append({
            "d0": f"2026-08-{index % 28 + 1:02d}", "code": "600519", "symbol": "sh600519",
            "name": "大手笔", "board": "sh", "is_control": 0, "d0_close": 10.0, "avail": 30,
            **{f"r{i}": (0.05 if index < 28 else -0.05) for i in range(1, 31)},
            **{f"t{i}": 0.05 for i in (5, 10, 15, 20, 25, 30)},
        })
    store.insert_signals(db, rows)

    items = stats.by_stock(db, {}, horizons=(30,))
    big = next(item for item in items if item["code"] == "600519")
    small = next(item for item in items if item["n"] <= 20)
    assert big["win"]["30"] == pytest.approx(70.0, abs=0.01)
    assert small["win"]["30"] == pytest.approx(100.0, abs=0.01)
    # 原始胜率差 30pp，收缩后差距明显变小（噪声不再排在前面）
    raw_gap = small["win"]["30"] - big["win"]["30"]
    shrunk_gap = small["win_shrunk"]["30"] - big["win_shrunk"]["30"]
    assert shrunk_gap < raw_gap * 0.7


def test_数据质量标出覆盖不足的日子(db):
    for day in range(10):
        _bulk(db, f"2026-09-{day + 1:02d}", 5, 3, 5, 2)
        store.record_day(db, f"2026-09-{day + 1:02d}", 5, 5, 100, coverage=5000, usable=5)
    db.execute("UPDATE days SET coverage = 500 WHERE d0 = '2026-09-05'")
    db.commit()
    report = stats.quality(db)
    assert report["coverage_median"] == 5000
    assert report["suspect_days_count"] == 1
    assert report["suspect_days"][0]["d0"] == "2026-09-05"


def test_股票池逐年变大不会被误判成数据缺失(db):
    """七年里股票池从 3800 只长到 5570 只：整段都比现在少，但不是「同步不全」。"""
    start = dt.date(2020, 1, 1)
    for index in range(60):
        day = (start + dt.timedelta(days=index)).isoformat()
        _bulk(db, day, 3, 2, 3, 1)
        store.record_day(db, day, 3, 3, 100, coverage=3800 + index * 30, usable=3)
    report = stats.quality(db)
    assert report["suspect_days_count"] == 0


def test_样本内外分别给超额(db):
    for day in range(10):
        _bulk(db, f"2023-01-{day + 1:02d}", 20, 14, 20, 10)
        _bulk(db, f"2025-01-{day + 1:02d}", 20, 10, 20, 10)
    result = stats.stability(db, [10])
    assert result["design_excess_pp"]["10"] == pytest.approx(20.0, abs=0.5)
    assert result["validate_excess_pp"]["10"] == pytest.approx(0.0, abs=0.5)
    assert result["decay_pp"]["10"] < 0


def test_分组统计的涨幅是平均值不是总和(db):
    """v5 之前 group_stats.avg 存的是 Σ 涨幅，样本多的分类会显示成几千个百分点。"""
    for day in range(10):
        for index in range(5):
            _bulk(db, f"2026-10-{day + 1:02d}", 1, 1, 0, 0)
    rows = stats.summary(db, (30,))
    blocks = stats.groups(db, (30,), stats.overall_win(rows), "r", 0.0)
    board = next(block for block in blocks if block["dim"] == "board")
    item = next(entry for entry in board["items"] if entry["key"] == "sh")
    # 每组平均涨幅 5%，不是 5% × 50 条
    assert item["avg_return"] == pytest.approx(5.0, abs=0.01)


def test_d0_价格是收盘价不是开盘价():
    """d0_close 只用于 Excel 展示，但取错列会让用户看到的「信号日价格」全是开盘价。"""
    bars = [
        (D0, 12.0, 13.0, 13.0, 12.0, 13.2),     # open 12 / close 13
        (FORWARD_DAYS[0], 13.5, 13.5, 13.5, 13.5, 13.6),
    ]
    result = forward.build_forward(bars, FORWARD_DAYS)
    assert result is not None
    assert result.d0_close == pytest.approx(13.0)
    assert result.entry_open == pytest.approx(13.5)


def test_口径名与列前缀都能传(db):
    """report["caliber"] 是 exec/close，列前缀是 x/r：两种写法都要认，否则报 no such column。"""
    from src.modules.market.fork_analysis.stats import caliber_prefix

    assert caliber_prefix("exec") == "x"
    assert caliber_prefix("x") == "x"
    assert caliber_prefix("close") == "r"
    assert caliber_prefix("r") == "r"
    _bulk(db, "2026-11-02", 10, 6, 10, 5)
    assert stats.summary(db, (30,), "close", 0.0)[0]["signal"]["n"] == 10
    assert stats.summary(db, (30,), "r", 0.0)[0]["signal"]["n"] == 10


def test_分组同时给相对随机的超额(db):
    """分组优势是相对条件整体；用户真正要知道的是这一类能不能打过随机买入。"""
    _bulk(db, "2026-12-01", 20, 14, 20, 10)     # 条件 70%，对照 50%
    rows = stats.summary(db, (30,), "r", 0.0)
    blocks = stats.groups(db, (30,), stats.overall_win(rows), "r", 0.0,
                          control_baseline=stats.control_win_rates(rows))
    board = next(block for block in blocks if block["dim"] == "board")
    item = next(entry for entry in board["items"] if entry["key"] == "sh")
    assert item["edge_pp"] == pytest.approx(0.0, abs=0.01)          # 相对条件整体
    assert item["excess_vs_random_pp"] == pytest.approx(20.0, abs=0.01)  # 相对随机


# ---------------------------------------------------------------------------
# v4 评估体系（2026-10-23 第三轮）：双口径 / 成本 / 入场 / 组合 / 归因 / 体检
# ---------------------------------------------------------------------------


def _exec(conn, code, d0, *, x10, amount=30.0, is_control=0, r1=0.01, r10=0.02, **over):
    """写一条带可执行口径的信号（x 列决定成本与组合模拟的结果）。"""
    values = {f"x{i}": x10 for i in range(1, 31)}
    values["v10"] = x10
    values.update(over)
    _signal(conn, code, d0, {i: r10 for i in range(1, 31)}, r1=r1, r10=r10,
            amount=amount, is_control=is_control, **values)


def test_加权口径按命中数加权而不是按天(db):
    """同一天命中 10 只和命中 1 只，权重必须不同（否则拥挤日被稀释）。"""
    for index in range(10):
        _signal(db, f"60000{index}", "2026-01-05", {i: 0.05 for i in range(1, 31)})
        _signal(db, f"60010{index}", "2026-01-05", {i: -0.05 for i in range(1, 31)}, is_control=1)
    _signal(db, "600020", "2026-01-06", {i: -0.05 for i in range(1, 31)})
    _signal(db, "600021", "2026-01-06", {i: 0.05 for i in range(1, 31)}, is_control=1)

    equal = significance.horizon_test(db, 10, "r", 0.0)
    weighted = significance.weighted_test(db, 10, "r", 0.0)
    assert equal["mean_excess_pp"] == pytest.approx(0.0, abs=0.01)     # (100 − 100)/2
    assert weighted["mean_excess_pp"] == pytest.approx(81.8, abs=0.2)  # (10×100 − 100)/11
    assert weighted["n_signals"] == 11


def test_卡方上尾与_Q_检验():
    assert significance.chi2_sf(3.8415, 1) == pytest.approx(0.05, abs=0.002)
    assert significance.chi2_sf(9.4877, 4) == pytest.approx(0.05, abs=0.002)
    same = [{"effect_pp": 3.0, "se_pp": 1.0}, {"effect_pp": 3.1, "se_pp": 1.0},
            {"effect_pp": 2.9, "se_pp": 1.0}]
    assert significance.cochran_q(same)["consistent"] is True
    spread = [{"effect_pp": 12.0, "se_pp": 0.5}, {"effect_pp": -6.0, "se_pp": 0.5}]
    result = significance.cochran_q(spread)
    assert result["consistent"] is False and result["i2"] > 50


def test_成本敏感性_高成本会吃掉超额(db):
    for index in range(5):
        _exec(db, f"60030{index}", "2026-01-05", x10=0.005)
        _exec(db, f"60040{index}", "2026-01-05", x10=0.0, is_control=1)
    data = stats.cost_sensitivity(db, (10,), "exec")
    assert data["available"] is True
    by_key = {level["key"]: level["horizons"]["10"] for level in data["levels"]}
    assert by_key["base"] == pytest.approx(100.0, abs=0.01)     # 0.5% − 0.2% > 0
    assert by_key["heavy"] == pytest.approx(0.0, abs=0.01)      # 0.5% − 0.8% < 0
    assert by_key["base"] > by_key["heavy"]


def test_入场假设敏感性给出四种口径(db):
    for index in range(4):
        _exec(db, f"60050{index}", "2026-01-05", x10=0.15, r1=0.05, r10=0.20)
        _exec(db, f"60060{index}", "2026-01-05", x10=0.0, r1=0.0, r10=0.0, is_control=1)
    rows = {row["base"]: row for row in entry.sensitivity(db, 10, 0.0)}
    assert set(rows) == {"signal_close", "next_open", "next_close", "next_vwap"}
    assert rows["next_open"]["available"] is True
    assert rows["next_open"]["win_rate"] == pytest.approx(100.0)
    # 次日收盘买入 = (1+r10)/(1+r1)−1 = 14.29%，不是 15%
    assert rows["next_close"]["win_rate"] == pytest.approx(100.0)


def test_组合模拟遵守仓位上限(db):
    for day in range(1, 6):
        for index in range(6):
            _exec(db, f"6007{day}{index}", f"2026-02-0{day}",
                  x10=0.05, **{f"x{i}": 0.01 * i for i in range(1, 10)})
    result = portfolio.simulate(db, 10, 2, 0.0)
    metrics = result["signal"]["metrics"]
    assert metrics["days"] >= 4
    assert metrics["avg_positions"] <= 2 * 10 + 1
    assert metrics["capital_use_pct"] <= 100
    assert metrics["final_value"] > 1.0
    assert len(result["signal"]["equity"]) >= 2


def test_因子归因给出原始与调整后超额(db):
    for index in range(60):
        _exec(db, f"60080{index}", f"2026-03-{index % 20 + 1:02d}", x10=0.03, mcap=20.0)
        _exec(db, f"60090{index}", f"2026-03-{index % 20 + 1:02d}", x10=-0.03, is_control=1, mcap=200.0)
    data = attribution.fit(db, 10, "x", 0.0)
    assert data["n"] == 120
    assert data["raw_excess_pp"] == pytest.approx(100.0, abs=0.01)
    # 命中组市值 20 亿、对照组 200 亿：市值这个变量会解释掉一部分
    assert data["adjusted_excess_pp"] is not None
    assert abs(data["adjusted_excess_pp"]) <= abs(data["raw_excess_pp"]) + 15
    assert any(feature["name"] == "log总市值" for feature in data["features"])


def test_体检能标出异常涨跌幅(db):
    _signal(db, "600000", "2026-01-05", {1: 0.60, 2: 0.60}, listed_days=500)
    _signal(db, "600001", "2026-01-05", {i: 0.01 for i in range(1, 31)}, listed_days=500)
    result = health.snapshot(db, "close")
    assert result["extreme_rows"] == 1
    assert result["score"] < 100
    assert result["level"] in ("warn", "bad")


def test_消融变体包含去条件与参数扰动():
    from src.modules.market.fork_screen.models import ScreenRequest

    request = ScreenRequest.model_validate({
        "trading_days": 30,
        "markets": ["sh"],
        "include_st": False,
        "rule": {
            "type": "group", "operator": "AND", "children": [
                {"type": "condition", "name": "consecutive_bullish", "params": {"start": 1, "days": 4}},
                {"type": "condition", "name": "ma_bullish", "params": {"periods": [5, 10]}},
            ],
        },
    })
    variants = ablation.build_variants(request)
    kinds = {variant["kind"] for variant in variants}
    assert kinds == {"base", "drop", "param"}
    assert any(variant["label"].startswith("去掉 consecutive_bullish") for variant in variants)
    assert any(variant["label"] == "days 4→5" for variant in variants)
    # 去掉一条之后仍然是一个合法的条件树
    for variant in variants:
        ScreenRequest.model_validate({**request.model_dump(mode="json"), "rule": variant["rule"]})


def test_排行榜按同一口径排序并给选择偏差(db, tmp_path, monkeypatch):
    import json

    for run_id, wins in (("20260101-000000-aaaa", 8), ("20260101-000001-bbbb", 2)):
        conn = store.open_db("sx", run_id)
        for index in range(10):
            row = {"d0": "2026-01-05", "code": f"60{index:04d}", "symbol": f"sh{index}",
                   "name": "x", "board": "sh", "is_control": 0, "d0_close": 10.0, "avail": 30}
            for i in range(1, 31):
                row[f"r{i}"] = 0.02 if index < wins else -0.02
            store.insert_signals(conn, [row])
        conn.close()
        store.save_meta("sx", {"run_id": run_id, "preset": "sx", "status": store.STATUS_DONE,
                               "horizons": [5, 10, 15, 20, 25, 30], "days": 1,
                               "start_date": "2026-01-05", "end_date": "2026-01-05",
                               "created_at": "2026-01-01T00:00:00+08:00"})
    board = leaderboard.board(10)
    assert board["count"] == 2
    assert board["items"][0]["hits"] == 10
    assert board["items"][0]["rank"] == 1
    assert board["note"] == "expected_max"


def test_结论卡的最优周期与超额同源(db):
    """旧实现用合并口径挑周期、诚实口径下结论，会给出自相矛盾的卡片。"""
    def row(horizon, excess, win_rate, n=500):
        return {"horizon": horizon, "excess_pp": excess, "z": 3.0,
                "signal": {"n": n, "win_rate": win_rate, "avg_return": 1.0, "payoff": 1.2},
                "control": {"win_rate": 48.0}}

    rows = [row(5, 8.0, 60.0), row(10, 3.0, 51.0)]
    honest = {"verdict": "worse", "best_horizon": 10, "best_excess_pp": -3.5,
              "best_ci_low_pp": -5.0, "best_ci_high_pp": -2.0, "worst_horizon": 10,
              "worst_excess_pp": -3.5, "primary_horizon": 10, "primary_excess_pp": -3.5,
              "primary_ci_low_pp": -5.0, "primary_ci_high_pp": -2.0,
              "up_count": 0, "down_count": 2, "up_horizons": [], "down_horizons": [5, 10]}
    decision = stats.verdict(rows, honest)
    assert decision["reason"] == "worse"
    assert decision["best_horizon"] == 10
    assert decision["best_excess_pp"] == pytest.approx(-3.5)
    assert decision["pooled_best_horizon"] == 5        # 合并口径只留档，不上卡片
    assert decision["sample"] == 500


def test_报告带齐新分段(db):
    for index in range(30):
        _exec(db, f"6010{index}", f"2026-04-{index % 20 + 1:02d}", x10=0.02)
        _exec(db, f"6011{index}", f"2026-04-{index % 20 + 1:02d}", x10=0.0, is_control=1)
    report = stats.build_report(db, {"horizons": [5, 10, 15, 20, 25, 30], "validate_days": 30})
    for key in ("signal_weighted", "cost_sensitivity", "entry", "portfolio",
                "attribution", "heterogeneity", "power", "conclusion"):
        assert key in report
    assert report["evaluation_version"] == "v4"
    assert report["quality"]["health"]["total_rows"] == 30


def test_归因标准误按日聚类(db):
    """同一天几十只股票共享一段行情：聚类标准误必须比独立同分布的大。"""
    from src.modules.market.fork_analysis.attribution import _cluster_se, _fit

    rng = np.random.default_rng(11)
    days, per = 20, 100
    n = days * per
    x = rng.normal(size=n)
    day = np.repeat(np.arange(days), per)
    # 每天的「斜率」都不一样 = 真实的聚类来源（不同日期行情对信号的影响强度不同）
    slope_shock = rng.normal(0, 1.5, days)[day]
    matrix = np.column_stack([np.ones(n), x])
    target = (rng.random(n) < 1 / (1 + np.exp(-((0.5 + slope_shock) * x)))).astype(float)
    beta, plain = _fit(matrix, target)
    clustered = _cluster_se(matrix, target, beta, [f"d{index}" for index in range(days) for _ in range(per)])
    assert clustered[1] > plain[1] * 2.0


def test_归因在对照组缺横截面时拒绝下结论(db):
    for index in range(60):
        _signal(db, f"6020{index}", "2026-05-05", {i: 0.02 for i in range(1, 31)},
                mcap=None, amount=None, turnover=None, amplitude=None,
                listed_days=None, breadth=None, x10=0.02)
        _signal(db, f"6021{index}", "2026-05-05", {i: -0.02 for i in range(1, 31)},
                is_control=1, mcap=100.0, amount=5.0, turnover=2.0, amplitude=3.0,
                listed_days=900, breadth=0.5, x10=-0.02)
    data = attribution.fit(db, 10, "x", 0.0)
    assert data.get("note") == "cross_section_missing"
