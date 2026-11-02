"""有效范围（通用 / 个股）与推理独立进程的回归测试。

对应用户 2026-11-03 的六条：
1. 推理拆独立进程 + 内存限制
2. 有效范围列（通用 / 个股）
3. 至少一段 ≥60 → 通用
4. 某只个股 ≥80 → 个股
5. 详情里能看到个股名单（id + 名字）
6. 历史记录不再出现「已完成 undefined / N 个交易日」
"""

from __future__ import annotations

import os

from src.modules.market.fork_analysis import scoring
from src.modules.market.fork_infer import scope as infer_scope
from src.modules.market.fork_infer import store as infer_store
from src.modules.market.fork_infer.engine import VariantMetrics


def _metrics(rows: dict[str, dict], horizons=(5, 10)) -> VariantMetrics:
    """造一份 ``collect_stocks=True`` 的结果：rows 见 ``_entry``。"""
    metrics = VariantMetrics(horizons=list(horizons))
    metrics.by_stock = dict(rows)
    return metrics


def _entry(*, code: str = "000001", name: str = "平安银行", n: int = 20,
           win: int = 18, base: float = 0.45, days: int = 12) -> dict:
    return {
        "code": code, "name": name, "days": days,
        "win": [win, win], "n": [n, n], "base": [base * n, base * n],
    }


def test_个股评分门槛比条件低_八次信号能评分且不超过七十五() -> None:
    """一只股票八年才几十次信号，用条件门槛（300 笔）会让「个股有效」永远不出现。"""
    metrics = _metrics({"000001": _entry(n=10, win=9)})
    rows = infer_scope.stock_rows(metrics)
    assert len(rows) == 1
    assert rows[0]["score"] is not None
    # 10 笔 < 15 笔 → 封顶 75 分
    assert rows[0]["score"] <= scoring.STOCK_CAP_8


def test_个股信号太少直接不进名单() -> None:
    """5 次里赢 5 次不算「个股有效」—— 这就是用户当初抱怨的假信号。"""
    metrics = _metrics({"000001": _entry(n=5, win=5)})
    assert infer_scope.stock_rows(metrics) == []


def test_个股信号充足且胜率高时能进八十分() -> None:
    """25 笔以上不再封顶，18/20 且基准 45% 应该明显过 80。"""
    metrics = _metrics({"000001": _entry(n=30, win=27)})
    rows = infer_scope.stock_rows(metrics)
    assert rows and rows[0]["score"] >= 80


def test_个股赢率低于基准时分数不及格() -> None:
    metrics = _metrics({"000001": _entry(n=30, win=9)})
    rows = infer_scope.stock_rows(metrics)
    assert rows and rows[0]["score"] < 60


def test_两段合并保留两边的分数与名字() -> None:
    train_rows = infer_scope.stock_rows(_metrics({"000001": _entry(n=30, win=27)}))
    valid_rows = infer_scope.stock_rows(
        _metrics({"000001": _entry(n=20, win=17), "600000": _entry(code="600000", name="浦发银行", n=20, win=16)})
    )
    merged = infer_scope.merge(train_rows, valid_rows)
    by_code = {item["code"]: item for item in merged}
    assert by_code["000001"]["train_score"] is not None
    assert by_code["000001"]["test_score"] is not None
    # 只在验证段出现的股票也要在名单里（名字不能丢）
    assert by_code["600000"]["name"] == "浦发银行"
    assert by_code["600000"]["train_score"] is None


def test_有效范围_只有一段六十分就是通用() -> None:
    """用户第 3 条：至少一个 60 以上 → 有效范围「通用」。"""
    train = _metrics({"000001": _entry(n=30, win=9)})          # 个股很差
    valid = _metrics({"000001": _entry(n=30, win=9)})
    result = infer_scope.judge(train, valid,
                               {"score": 64.0}, {"score": 41.0})
    assert result["scope_label"] == "通用"
    assert result["scopes"] == [infer_scope.SCOPE_GENERAL]


def test_有效范围_整条不及格但个股八十分就是个股() -> None:
    """用户第 4 条：个股 ≥80 → 有效范围「个股」。"""
    metrics = _metrics({"000001": _entry(n=30, win=27)})
    result = infer_scope.judge(metrics, metrics, {"score": 48.0}, {"score": 45.0})
    assert result["scope_label"] == "个股"
    assert result["stock_qualified"] == 1
    assert result["stock_best_score"] >= 80


def test_有效范围_两条都成立时显示通用加个股() -> None:
    """用户第 5 条：同时可以既是通用也是个股。"""
    metrics = _metrics({"000001": _entry(n=30, win=27)})
    result = infer_scope.judge(metrics, metrics, {"score": 70.0}, {"score": 62.0})
    assert result["scope_label"] == "通用+个股"
    assert set(result["scopes"]) == {infer_scope.SCOPE_GENERAL, infer_scope.SCOPE_STOCK}


def test_有效范围_两边都不够时是横杠() -> None:
    metrics = _metrics({"000001": _entry(n=30, win=9)})
    result = infer_scope.judge(metrics, metrics, {"score": 48.0}, {"score": 44.0})
    assert result["scope_label"] == "—"
    assert result["scopes"] == []


def test_个股名单只保留达到展示门槛的股票并按分排序() -> None:
    metrics = _metrics({
        "000001": _entry(n=30, win=28),
        "600000": _entry(code="600000", name="浦发银行", n=30, win=24),
        "000002": _entry(code="000002", name="万科A", n=30, win=9),
    })
    result = infer_scope.judge(metrics, metrics, {"score": 40.0}, {"score": 40.0})
    codes = [item["code"] for item in result["stock_list"]]
    assert codes[0] == "000001"
    assert "000002" not in codes          # 跑输基准的不进名单
    assert result["stock_universe"] == 3


def test_个股档不用条件的样本门槛() -> None:
    """同一个窗口行，个股档不会被「每天 0.5 个信号」这类条件门槛压到 55 以下。"""
    windows = [{"window": 10, "n": 30, "p_net": 90.0, "base_p": 45.0,
                "excess_pp": 45.0, "lower_pp": 30.0, "n_eff": 3, "expectancy": None}]
    stock = scoring.score_segment(windows=windows, events=30, days=5, profile="stock")
    condition = scoring.score_segment(windows=windows, events=30, days=5)
    assert stock["score"] > condition["score"]
    assert condition["score"] <= scoring.PASS_SCORE - 5


# --------------------------------------------------------------- 独立进程
def test_pid必须是自己人_别人的pid不算在跑(tmp_path, monkeypatch) -> None:
    """只用 ``kill(0)`` 判活会认错人：pid 复用之后随便一个进程都能占住任务槽。"""
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    infer_store.write_pid("run-a", os.getpid())
    assert infer_store.read_pid("run-a") == os.getpid()
    # 当前进程是 pytest，cmdline 里没有 fork_infer.worker → 不算推理进程
    assert search._pid_alive(os.getpid()) is False
    assert search._pid_alive(999_999) is False
    assert search.is_running("run-a") is False


def test_工作进程活着时占用单任务槽(tmp_path, monkeypatch) -> None:
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    infer_store.save_meta("run-a", {"run_id": "run-a", "status": "running"})
    infer_store.write_pid("run-a", os.getpid())
    monkeypatch.setattr(search, "_pid_alive", lambda pid: True)
    assert search.is_running("run-a") is True
    assert search.any_running() == "run-a"


def test_没有pid文件时即使状态写着running也不占槽(tmp_path, monkeypatch) -> None:
    """2026-10-24 那次「新的任务不能创建」就是死任务一直占着单任务槽。"""
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    infer_store.save_meta("run-b", {"run_id": "run-b", "status": "running"})
    infer_store.clear_pid("run-b")
    assert search.is_running("run-b") is False
    assert search.any_running() != "run-b"


def test_工作进程启动会写pid文件_没有systemd时用普通进程(tmp_path, monkeypatch) -> None:
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    monkeypatch.setenv("PANWATCH_INFER_SYSTEMD", "0")
    monkeypatch.setattr(search, "_unit_active", lambda run_id: False)
    spawned: list[list[str]] = []

    class _Fake:
        pid = os.getpid()

    def _fake_popen(argv, **kwargs):  # noqa: ANN001
        spawned.append(list(argv))
        return _Fake()

    import subprocess
    monkeypatch.setattr(subprocess, "Popen", _fake_popen)
    search.start("run-c")
    assert spawned and spawned[0][-1] == "run-c"
    assert "fork_infer.worker" in " ".join(spawned[0])
    assert infer_store.read_pid("run-c") == os.getpid()


def test_有systemd时跑成独立单元_带内存上限(tmp_path, monkeypatch) -> None:
    """2026-11-03 实测：普通子进程仍在 panwatch.service 的 cgroup 里，
    一次 systemctl restart 就把跑了 9 小时的搜索带走。改用 transient unit，
    重启服务不再打断推理，内存上限也由 cgroup 兜住。"""
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(search, "_systemd_available", lambda: True)
    monkeypatch.setattr(search, "_unit_active", lambda run_id: False)
    calls: list[list[str]] = []

    class _Done:
        returncode = 0
        stderr = ""

    def _fake_run(cmd, **kwargs):  # noqa: ANN001
        calls.append(list(cmd))
        # systemd 单元起来后，工作进程会写 pid；这里模拟它
        infer_store.write_pid("run-d", os.getpid())
        return _Done()

    import subprocess
    monkeypatch.setattr(subprocess, "run", _fake_run)
    search.start("run-d")
    cmd = calls[-1]
    assert "systemd-run" in cmd
    assert "panwatch-infer-run-d" in cmd
    assert any("MemoryMax=1500M" in item for item in cmd)
    # transient unit 是干净环境：不给 EnvironmentFile 就会一启动就报「未配置只读行情库」
    assert any(item.startswith("EnvironmentFile=") for item in cmd)
    # sudo 起的 transient unit 默认跑成 root，会把任务目录写成 root 属主
    assert "User=ubuntu" in cmd
    assert cmd[-1] == "run-d"


def test_单元还活着就算在跑_哪怕pid文件还没写(tmp_path, monkeypatch) -> None:
    """单元刚起来的一两秒 pid 还没写，只看 pid 会误判任务已死 → 再开一轮抢同一个目录。"""
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(search, "_unit_active", lambda run_id: True)
    infer_store.clear_pid("run-e")
    assert search.is_running("run-e") is True


def test_刚起的任务不会被误判为中断(tmp_path, monkeypatch) -> None:
    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(search, "is_running", lambda run_id: False)
    infer_store.save_meta("run-f", {"run_id": "run-f", "status": "running",
                                    "created_at": "2026-11-03T00:00:00+08:00"})
    search.reconcile()
    assert infer_store.load_meta("run-f")["status"] == "running"


def test_老任务没有pid也没有单元才算中断(tmp_path, monkeypatch) -> None:
    import os as _os
    import time as _time

    from src.modules.market.fork_infer import search

    monkeypatch.setattr(infer_store, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(search, "is_running", lambda run_id: False)
    infer_store.save_meta("run-g", {"run_id": "run-g", "status": "running"})
    old = _time.time() - 3600
    _os.utime(infer_store.meta_path("run-g"), (old, old))
    search.reconcile()
    assert infer_store.load_meta("run-g")["status"] == "interrupted"
