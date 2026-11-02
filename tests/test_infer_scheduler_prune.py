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


def test_空跑的基础条件会被标记失败而不是已完成():
    """0 次评估 = 基础条件没有信号：历史里必须显示「失败」，否则看不出是空跑。"""
    from src.modules.market.fork_infer import search

    source = Path(search.__file__).read_text(encoding="utf-8")
    assert "基础条件在该窗口没有任何信号" in source
    assert "STATUS_FAILED if done == 0" in source
