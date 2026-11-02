"""常驻调度器的清盘策略：**只清大文件，不删历史记录**（用户 2026-11-02 第 2 条）。

背景：之前 prune 是「只留最近 20 轮、其余整目录 rmtree」，于是历史记录跟着消失 ——
用户在「全部历史任务」里只能看到最近一两天的任务。现在分两层：
``meta.json`` / ``finalists.json`` 永久保留，只有 ``results.jsonl`` 会被裁剪。

这些用例直接在临时目录里造任务目录，不碰 /opt/PanWatch。
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_scheduler():
    spec = importlib.util.spec_from_file_location(
        "infer_scheduler_under_test", REPO_ROOT / "scripts" / "infer_scheduler.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def scheduler(tmp_path, monkeypatch):
    module = _load_scheduler()
    runs = tmp_path / "infer_runs"
    analysis = tmp_path / "analysis_runs"
    runs.mkdir()
    analysis.mkdir()
    monkeypatch.setattr(module, "DATA_DIR", str(runs))
    monkeypatch.setattr(module, "ANALYSIS_DIR", str(analysis))
    monkeypatch.setattr(module, "KEEP_RUNS", 1)
    monkeypatch.setattr(module, "KEEP_ANALYSIS_MIN", 0)
    return module, runs, analysis


def _make_run(root: Path, name: str, lines: int, scores=None, mtime: float = 0) -> Path:
    path = root / name
    path.mkdir()
    (path / "meta.json").write_text(json.dumps({
        "run_id": name, "preset": "xg1", "status": "done", "scores": scores or {},
    }), encoding="utf-8")
    (path / "finalists.json").write_text("[]", encoding="utf-8")
    (path / "results.jsonl").write_text(
        "".join(json.dumps({"index": i}) + "\n" for i in range(lines)), encoding="utf-8")
    if mtime:
        for item in path.iterdir():
            os.utime(item, (mtime, mtime))
        os.utime(path, (mtime, mtime))
    return path


def test_旧轮次的_meta_永远不删(scheduler):
    module, runs, _ = scheduler
    old = _make_run(runs, "20260101-000000-aaaa", 500, mtime=1)
    mid = _make_run(runs, "20260102-000000-bbbb", 500, mtime=2)
    new = _make_run(runs, "20260103-000000-cccc", 500, mtime=3)

    module.prune({"protect": []})

    for path in (old, mid, new):
        assert (path / "meta.json").exists(), f"{path.name} 的 meta.json 被删了，历史记录会消失"
        assert (path / "finalists.json").exists()


def test_旧轮次只裁_results_最近的保留全量(scheduler):
    module, runs, _ = scheduler
    made = [_make_run(runs, f"2026010{i}-000000-aaaa", 500, mtime=i) for i in range(1, 6)]
    newest, mid = made[-1], made[-2]
    dropped = made[0]

    module.prune({"protect": []})

    # 最近 1 轮（KEEP_RUNS=1）保留全量
    assert len((newest / "results.jsonl").read_text(encoding="utf-8").splitlines()) == 500
    # 次新的裁到 200 行（i < KEEP_RUNS * 3）
    assert len((mid / "results.jsonl").read_text(encoding="utf-8").splitlines()) == 200
    # 更老的整份删掉（meta 还在）
    assert not (dropped / "results.jsonl").exists()
    assert (dropped / "meta.json").exists()


def test_分析任务只删重产物留_meta(scheduler):
    module, _, analysis = scheduler
    run = analysis / "xg1" / "20260101-000000-aaaa"
    run.mkdir(parents=True)
    (run / "meta.json").write_text(json.dumps({"run_id": "20260101-000000-aaaa"}),
                                   encoding="utf-8")
    (run / "signals.db").write_bytes(b"x" * 1024)
    (run / "明细.xlsx").write_bytes(b"x" * 1024)
    os.utime(run, (1, 1))
    for item in run.iterdir():
        os.utime(item, (1, 1))

    module.prune({"protect": []})

    assert (run / "meta.json").exists()
    assert not (run / "signals.db").exists()
    assert not (run / "明细.xlsx").exists()
    meta = json.loads((run / "meta.json").read_text(encoding="utf-8"))
    assert meta["artifacts_pruned"] is True


def test_高分轮次受保护不被裁剪(scheduler):
    module, runs, _ = scheduler
    good = _make_run(runs, "20260101-000000-aaaa", 500,
                     scores={"train": {"score": 70.0}, "test": {"score": 68.0}}, mtime=1)
    _make_run(runs, "20260102-000000-bbbb", 500, mtime=2)
    _make_run(runs, "20260103-000000-cccc", 500, mtime=3)

    module.prune({"protect": []})

    assert len((good / "results.jsonl").read_text(encoding="utf-8").splitlines()) == 500


def test_空跑与无入围的轮次都标失败():
    """0 次评估 / 有评估但没入围 = 这轮没有评分：历史里必须显示「失败」。

    以前一律标 done，历史里显示「已完成、评分 —」，看不出是白跑。
    """
    from src.modules.market.fork_infer import search

    assert search.final_outcome(False, 0, False)[0] == "failed"
    assert "没有任何信号" in (search.final_outcome(False, 0, False)[1] or "")
    assert search.final_outcome(False, 120, False)[0] == "failed"
    assert "信号不足" in (search.final_outcome(False, 120, False)[1] or "")
    assert search.final_outcome(False, 120, True) == ("done", None)
    assert search.final_outcome(True, 120, True) == ("stopped", None)


# --------------------------------------------------------------------------- #
# 启动预算：空跑的失败轮不占名额（否则连续几个窄条件会把机器锁成空闲）
# --------------------------------------------------------------------------- #
def test_失败的空跑轮不占用24小时启动预算(scheduler):
    import time as _time

    module, _runs_dir, _analysis_dir = scheduler
    now = _time.time()
    state = {"starts": [
        {"ts": now - 60, "run_id": "r-failed-1"},
        {"ts": now - 120, "run_id": "r-failed-2"},
        {"ts": now - 180, "run_id": "r-ok-1"},
        {"ts": now - 90000, "run_id": "r-old"},      # 超过 24 小时，本来就不计
    ]}
    runs = [
        {"run_id": "r-failed-1", "status": "failed"},
        {"run_id": "r-failed-2", "status": "failed"},
        {"run_id": "r-ok-1", "status": "done"},
        {"run_id": "r-old", "status": "done"},
    ]
    # 只有 1 轮真正产出了东西 → 还剩 5 次预算，而不是被判成 3/6
    assert module._starts_today(state, runs) == 1


def test_运行中和已完成的轮次照常占用预算(scheduler):
    import time as _time

    module, _runs_dir, _analysis_dir = scheduler
    now = _time.time()
    state = {"starts": [{"ts": now - 60, "run_id": f"r-{index}"} for index in range(6)]}
    runs = [{"run_id": f"r-{index}", "status": "done" if index % 2 else "running"}
            for index in range(6)]
    assert module._starts_today(state, runs) == 6
    assert module._starts_today(state, runs) >= module.MAX_STARTS_PER_DAY


def test_没有轮次列表时退回旧口径不漏算(scheduler):
    import time as _time

    module, _runs_dir, _analysis_dir = scheduler
    now = _time.time()
    state = {"starts": [{"ts": now - 60, "run_id": "r-1"},
                        {"ts": now - 30, "run_id": "r-2"}]}
    # 查不到状态时宁可高估（宁可少开一轮，也不要无限开）
    assert module._starts_today(state) == 2


def test_有轮次在跑时不去白打选股体检(scheduler, monkeypatch):
    """start_new 必须先判「要不要开」，再花时间体检基础条件。

    顺序颠倒时，每 5 分钟的 tick 都会打一次 W=250 的选股（有推理线程时实测 61 秒），
    日志里连续刷 "base check skipped TimeoutError"，等于体检失效。
    """
    module, _runs_dir, _analysis_dir = scheduler
    calls: list[tuple] = []
    monkeypatch.setattr(module, "_alive", lambda item: True)
    monkeypatch.setattr(module, "_latest", lambda runs: runs[0] if runs else None)
    monkeypatch.setattr(module, "_post", lambda *a, **k: calls.append((a, k)) or {})

    runs = [{"run_id": "r-1", "status": "running"}]
    assert module.start_new("token", runs, {}, force=False) == "busy"
    assert calls == [], "有轮次在跑时不该再调用 /stocks/screen"
