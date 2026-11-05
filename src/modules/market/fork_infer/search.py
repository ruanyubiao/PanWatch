"""条件推理的主循环：在基础条件之上反复「改一点 → 跑一轮训练段 → 记分 → 留优」。

搜索策略（贪心 + 精英池）
------------------------
1. 先把基础条件本身跑一遍，作为基准分。
2. 之后每一次「调整优化」：从精英池里挑一个父代（少部分直接拿基础条件），
   施加一个变异算子（补条件 / 调参数 / 去条件），得到一个**新**变体。
3. 用训练段的抽样交易日评估它，按用户选的统计口径打分；达到门槛就进精英池。
4. 全部次数跑完后，取精英池里最好的几个，做两件事：
   * 在**完整训练段**上重算（抽样只用于排序，给人看的数字必须用全量）
   * 在**验证段**上验算（这一段搜索全程没看过）
   两边都站得住的条件才进「可保存」清单。

为什么搜索用抽样交易日
--------------------
一个变体跑 485 个交易日要 70 秒以上，100 个变体就是 2 小时。均匀抽 120 天
（所有变体用同一批天，配对比较）已足够给变体排序 —— 排序靠的是**相对**差异，
不是绝对精度；最后入选的少数几个再用全量重算。这是搜索与出报告的分工。

可停止 / 可暂停
--------------
* 停止：写 ``stop`` 文件，循环在当前变体边界退出，已跑完的结果保留，仍然会做
  最终验算（用已经找到的精英）。
* 暂停：写 ``pause`` 文件，循环原地等待（每秒看一次），解除后继续。
"""

from __future__ import annotations

import copy
import datetime as _dt
import logging
import os
import random
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional, Sequence

from ..api import fork_market
from ..fork_analysis import forward, methods
from ..fork_analysis import scoring as scoring100
from ..fork_screen import presets
from ..fork_screen.evaluator import compile_rule, required_bars_of_group
from ..fork_screen.models import ScreenRequest
from . import scope as infer_scope
from . import space, store
from .data import load_calendar, load_dataset, load_universe
from .engine import Engine, score_of
from .models import (
    ELITE_SIZE,
    FINALISTS,
    INFER_HORIZONS,
    MAX_FORWARD,
    MIN_DAYS_WITH_HITS,
    MIN_SIGNALS,
    SEARCH_DAYS,
    InferCreate,
)

logger = logging.getLogger(__name__)

#: 同一台机器同时只跑一个推理任务（4 核机器，跑两个只会互相拖慢）。
#: 2026-11-03 起推理跑在**独立进程**里，所以「谁在跑」由 pid 文件说了算 ——
#: 内存里的字典在 API 进程重启、以及调度器脚本（另一个进程）看来都是空的，
#: 以前正是因此出现「meta 说在跑、其实线程早没了、新任务又建不了」。
_LOCK = threading.Lock()

#: 训练段之前多读多少个交易日的行情（给均线 / 创新高预热）
WARMUP_DAYS = 130

#: 连续多少次「变异失败 / 重复 / 不合法」就提前结束（说明空间搜得差不多了）
MAX_MISSES = 40

#: 云端实测的单日评估耗时（秒），用于创建前的耗时预估。
#: 2026-10-24 首次全量实测：100 次优化 + 5 个变体最终验算共 4518 秒，
#: 摊到「抽样日 + 验算日」约 0.30 秒/日（原值 0.16 把 75 分钟估成了 42 分钟）。
#: 2026-11-02 实测 60 天抽样 16.9 秒/变体（= 0.28 秒/日），与这个常数一致；
#: 抽样天数改成 120 后单变体约 34 秒，1000 次约 9.5 小时 —— 这是用户明确接受的代价。
SECONDS_PER_DAY = 0.30


class InferBusy(RuntimeError):
    """已有推理任务在跑。"""


class InferParamsInvalid(ValueError):
    """参数不合法。"""


def _pid_alive(pid: int) -> bool:
    """pid 还活着，且确实是我们的推理工作进程（防 pid 复用认错人）。"""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return True  # 读不到 /proc（容器/权限），只能信 kill(0)
    return b"fork_infer.worker" in cmdline


def _unit_name(run_id: str) -> str:
    return f"panwatch-infer-{run_id}"


def _unit_active(run_id: str) -> bool:
    """systemd transient 单元还活着吗（进程刚起、还没写 pid 时靠这个）。"""
    import subprocess

    try:
        done = subprocess.run(["systemctl", "is-active", "--quiet", _unit_name(run_id)],
                              capture_output=True, timeout=8)
    except (OSError, Exception):  # noqa: BLE001
        return False
    return done.returncode == 0


def is_running(run_id: str) -> bool:
    """在跑 = 工作进程活着，或者它的 systemd 单元是 active。

    只看 pid 文件会误判：单元刚起来的那一两秒 pid 还没写，调度器会以为任务死了，
    把状态改成 interrupted，然后再开一轮 —— 结果同一轮有两个工作进程抢同一个目录。
    """
    pid = store.read_pid(run_id)
    if pid and _pid_alive(pid):
        return True
    return _unit_active(run_id)


def any_running() -> Optional[str]:
    """有推理任务在工作进程里跑着就返回它的 id。

    只看状态是不够的：meta 里可能写着 running 而工作进程已经死了，
    那正是「新的任务不能创建」的老症状。所以要求「状态在跑」且「pid 活着」。
    """
    for meta in store.list_runs(limit=60):
        run_id = str(meta.get("run_id") or "")
        if not run_id:
            continue
        status = str(meta.get("status") or "")
        if status not in (store.STATUS_RUNNING, store.STATUS_PENDING, store.STATUS_PAUSED):
            continue
        if is_running(run_id):
            return run_id
    return None


def base_request_of(preset_name: str, markets: Optional[Sequence[str]],
                    include_st: Optional[bool]) -> ScreenRequest:
    record = presets.load(preset_name)
    raw = record.get("request")
    if not isinstance(raw, dict):
        raise InferParamsInvalid(f"条件「{preset_name}」文件里没有可用的请求")
    request = ScreenRequest.model_validate(raw)
    update: dict[str, Any] = {}
    if markets:
        update["markets"] = list(markets)
    if include_st is not None:
        update["include_st"] = bool(include_st)
    return request.model_copy(update=update) if update else request


def base_summary(request: ScreenRequest) -> str:
    """基础条件的一句话描述（结果表里给人看）。"""
    parts: list[str] = []

    def walk(node: Any) -> None:
        if getattr(node, "type", "") == "condition":
            parts.append(space.describe_condition(node.name, dict(node.params or {}),
                                                  int(request.trading_days)))
        else:
            for child in getattr(node, "children", []) or []:
                walk(child)

    walk(request.rule)
    return " 且 ".join(parts) if parts else "（无条件）"


def two_segment_days(payload: InferCreate) -> dict[str, Any]:
    """把训练段 / 验证段落成真实交易日，并给出可验证的结束日上限。"""
    conn = fork_market._connect()
    try:
        latest = forward.latest_trade_date(conn)
        if latest is None:
            raise InferParamsInvalid("行情库里没有任何数据")
        # 前瞻行情不够的日期验算不出来：统一夹到「最新日往前 MAX_FORWARD 个交易日」
        max_verifiable = forward.shift_back(conn, latest, MAX_FORWARD)
        train_end = min(payload.train_end, max_verifiable)
        valid_end = min(payload.valid_end or max_verifiable, max_verifiable)
        if payload.train_start > train_end:
            raise InferParamsInvalid(
                f"训练段开始日 {payload.train_start} 晚于可验证的结束日 {max_verifiable}")
        if payload.valid_start > valid_end:
            raise InferParamsInvalid(
                f"验证段开始日 {payload.valid_start} 晚于可验证的结束日 {max_verifiable}")
        if payload.valid_start <= train_end:
            raise InferParamsInvalid("验证段必须晚于训练段（否则等于拿训练集当测试集）")
        train_days = forward.trading_calendar(conn, payload.train_start, train_end)
        valid_days = forward.trading_calendar(conn, payload.valid_start, valid_end)
        version = forward.data_version(conn)
    finally:
        conn.close()
    if not train_days:
        raise InferParamsInvalid("训练段内没有任何交易日")
    if not valid_days:
        raise InferParamsInvalid("验证段内没有任何交易日")
    return {
        "latest_trade_date": latest.isoformat(),
        "max_verifiable": max_verifiable.isoformat(),
        "train_days": train_days,
        "valid_days": valid_days,
        "data_version": version,
    }


def preview(payload: InferCreate) -> dict[str, Any]:
    """创建前的预估：两段各有多少交易日、要读多少行情、大概跑多久。"""
    method_id = methods.normalize(payload.method)
    spec = methods.spec(method_id)
    info = two_segment_days(payload)
    request = base_request_of(payload.preset, payload.markets, payload.include_st)
    base_k = max(1, required_bars_of_group(compile_rule(request), int(request.trading_days)))
    search_days = min(SEARCH_DAYS, len(info["train_days"]))
    estimate = int(
        SECONDS_PER_DAY * search_days * payload.iterations
        + SECONDS_PER_DAY * (len(info["train_days"]) + len(info["valid_days"])) * FINALISTS
        + 90  # 读行情的一次性开销
    )
    return {
        "method": method_id,
        "method_name": spec.name,
        "train_days": len(info["train_days"]),
        "valid_days": len(info["valid_days"]),
        "train_first": str(info["train_days"][0]),
        "train_last": str(info["train_days"][-1]),
        "valid_first": str(info["valid_days"][0]),
        "valid_last": str(info["valid_days"][-1]),
        "search_days": search_days,
        "iterations": int(payload.iterations),
        "max_verifiable": info["max_verifiable"],
        "latest_trade_date": info["latest_trade_date"],
        "base_summary": base_summary(request),
        "base_trading_days": int(request.trading_days),
        "base_bars": int(base_k),
        "estimate_seconds": estimate,
        "horizons": list(INFER_HORIZONS),
        "data_version": info.get("data_version") or {},
    }


def reconcile() -> None:
    """把「meta 说在跑、线程其实已经没了」的任务标成 interrupted。

    不做这一步，一个僵死记录会一直占着单任务槽 —— 表现就是用户说的
    「新的任务不能创建」（2026-10-24 截图里那个 99/100 的任务）。
    """
    for meta in store.list_runs(limit=300):
        status = str(meta.get("status") or "")
        if status not in (store.STATUS_RUNNING, store.STATUS_PENDING, store.STATUS_PAUSED):
            continue
        run_id = str(meta.get("run_id") or "")
        if not run_id or is_running(run_id):
            continue
        # 刚起的那一两分钟别急着判死：工作进程要先把整个行情库读进内存
        # （2026-11-03：单元刚起、pid 还没写时被 reconcile 误判成 interrupted）
        try:
            age = time.time() - store.meta_path(run_id).stat().st_mtime
        except OSError:
            age = 0.0
        if age < 180.0:
            continue
        try:
            store.patch_meta(run_id, status="interrupted",
                             progress={**(meta.get("progress") or {}), "phase": "interrupted"})
        except Exception:  # noqa: BLE001
            continue


def create(payload: InferCreate) -> dict[str, Any]:
    """建任务目录 + 起后台线程。"""
    info = preview(payload)
    # preview() 里的 train_days / valid_days 是**个数**（给界面显示用），
    # meta 里要存的是日期数组（主循环按日期回看）。所以这里再取一次交易日历。
    segment = two_segment_days(payload)
    reconcile()
    busy = any_running()
    if busy:
        raise InferBusy(f"已有条件推理任务在跑（{busy}），等它结束或先停止")
    run_id = store.new_run_id()
    request = base_request_of(payload.preset, payload.markets, payload.include_st)
    meta = {
        "run_id": run_id,
        "kind": "infer",
        "created_at": store._now(),
        "status": store.STATUS_PENDING,
        "preset": presets.normalize_name(payload.preset),
        "base_summary": info["base_summary"],
        "base_rule": request.model_dump(mode="json")["rule"],
        "base_request": request.model_dump(mode="json"),
        "method": info["method"],
        "method_name": info["method_name"],
        "train_start": str(payload.train_start),
        "train_end": info["train_last"],
        "valid_start": str(payload.valid_start),
        "valid_end": info["valid_last"],
        "train_days": [str(day) for day in segment["train_days"]],
        "valid_days": [str(day) for day in segment["valid_days"]],
        "search_days": info["search_days"],
        "iterations": info["iterations"],
        "max_verifiable": info["max_verifiable"],
        "latest_trade_date": info["latest_trade_date"],
        "seed": int(payload.seed),
        "horizons": info["horizons"],
        "markets": list(request.markets),
        "include_st": bool(request.include_st),
        "estimate_seconds": info["estimate_seconds"],
        "data_version": info.get("data_version") or {},
        "progress": {
            "phase": "pending",
            "done_iterations": 0,
            "iterations": info["iterations"],
            "current": "",
            "best_score": None,
            "best_desc": "",
            "elite": 0,
            "elapsed_s": 0,
            "eta_s": None,
            "variants_evaluated": 0,
            "load_progress": 0,
            "load_label": "",
        },
        "error": None,
    }
    store.run_dir(run_id)
    store.save_meta(run_id, meta)
    start(run_id)
    return store.load_meta(run_id)


def start(run_id: str) -> None:
    """起（或续跑）**独立进程**。已完成的变体按 results.jsonl 跳过，所以续跑是幂等的。

    以前是往 API 进程里塞一个线程：一次 `systemctl restart` 就把跑了几小时的推理
    废掉，而且线程占的内存跟网页挤在一起（用户 2026-11-03 第 1 条要求拆出去）。
    """
    with _LOCK:
        if is_running(run_id):
            return
        store.clear_stop(run_id)
        _spawn(run_id)


def _spawn(run_id: str) -> None:
    """拉起工作进程。

    优先用 systemd 跑成**独立的 transient service**（``systemd-run --unit``）：
    它有自己的 cgroup，``systemctl restart panwatch`` 不会带走它 —— 2026-11-03 实测
    用普通 ``subprocess.Popen`` 时，worker 虽然开了新会话，但仍留在 panwatch.service
    的 cgroup 里，一次重启就被 systemd 连锅端掉，9 小时的搜索白跑。
    顺带还能用 cgroup 直接限内存（``MemoryMax``），比 ``RLIMIT_AS`` 靠谱
    （Python 的虚拟内存远大于真实占用，地址空间限太紧会误杀）。

    没有 systemd / 没有免密 sudo 时退回普通 Popen：仍能跑，但重启服务会打断，
    由调度器在几分钟内续跑（断点续跑是幂等的）。
    """
    import subprocess
    import sys

    log_path = store.log_path(run_id)
    env = {**os.environ, "PYTHONUNBUFFERED": "1", "MALLOC_ARENA_MAX": "2"}
    argv = [sys.executable, "-m", "src.modules.market.fork_infer.worker", run_id]
    unit = _unit_name(run_id)

    if _systemd_available():
        cmd = [
            "sudo", "-n", "systemd-run", "--unit", unit, "--collect",
            "--description", f"PanWatch 条件推理 {run_id}",
            # sudo 起的 transient unit 默认以 root 跑 —— 那样写出 meta.json /
            # results.jsonl 全是 root 属主，之后 API（ubuntu）就再也写不进去了
            "-p", f"User={_run_user()}", "-p", f"Group={_run_group()}",
            "-p", "MemoryMax=1500M", "-p", "MemorySwapMax=1G",
            "-p", "CPUQuota=300%", "-p", "Nice=10",
            # transient unit 拿到的是**干净环境**：不注入凭据就会一启动就报
            # 「未配置只读行情库」（2026-11-03 踩过，一次白跑一轮）
            "-p", f"EnvironmentFile={_env_file()}",
            "--setenv=PYTHONUNBUFFERED=1", "--setenv=MALLOC_ARENA_MAX=2",
            "--setenv=PYTHONPATH=" + str(store.PROJECT_ROOT),
            "-p", f"StandardOutput=append:{log_path}",
            "-p", f"StandardError=append:{log_path}",
            "--working-directory", str(store.PROJECT_ROOT),
            *argv,
        ]
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=45)
        if done.returncode == 0:
            # 等工作进程自己把 pid 写下来（它启动后第一件事就是写），
            # 否则紧接着的 any_running() 会以为没人跑，可能再起一轮
            for _ in range(40):
                if store.read_pid(run_id):
                    break
                time.sleep(0.25)
            logger.info("条件推理工作进程已启动（systemd 单元 %s）", unit)
            return
        logger.warning("systemd-run 启动失败，退回普通进程：%s", (done.stderr or "").strip()[:300])

    log = log_path.open("a", encoding="utf-8")
    try:
        proc = subprocess.Popen(
            argv, cwd=str(store.PROJECT_ROOT),
            stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            start_new_session=True, env=env,
        )
    finally:
        log.close()
    store.write_pid(run_id, proc.pid)
    logger.info("条件推理工作进程已启动 run=%s pid=%s", run_id, proc.pid)


def _run_user() -> str:
    """工作进程跑成谁：与服务进程同一个用户（默认 ubuntu）。

    用 root 跑会把任务目录写成 root 属主，之后接口读写全部 PermissionError。
    """
    return str(os.environ.get("PANWATCH_INFER_USER") or "ubuntu")


def _run_group() -> str:
    return str(os.environ.get("PANWATCH_INFER_GROUP") or _run_user())


def _env_file() -> str:
    """行情库凭据的唯一来源（与 panwatch.service 的 EnvironmentFile 同一个文件）。"""
    return str(os.environ.get("PANWATCH_ENV_FILE") or "/opt/stock/.env")


def _systemd_available() -> bool:
    """能不能用 systemd-run 起 transient 单元（需要 systemd + 免密 sudo）。"""
    if str(os.environ.get("PANWATCH_INFER_SYSTEMD", "1")).lower() in ("0", "false", "no"):
        return False
    try:
        done = __import__("subprocess").run(["sudo", "-n", "true"], capture_output=True, timeout=10)
    except (OSError, Exception):  # noqa: BLE001 - 没有 sudo/systemd 就用普通进程
        return False
    return done.returncode == 0


def pause(run_id: str) -> dict[str, Any]:
    store.request_pause(run_id)
    return store.patch_meta(run_id, status=store.STATUS_PAUSED)


def resume(run_id: str) -> dict[str, Any]:
    store.clear_pause(run_id)
    meta = store.load_meta(run_id)
    status = str(meta.get("status") or "")
    alive = is_running(run_id)
    if alive:
        # 线程还在：暂停中的恢复成运行，其它状态原样返回
        if status == store.STATUS_PAUSED:
            return store.patch_meta(run_id, status=store.STATUS_RUNNING)
        return meta
    # 线程不在：只有 paused / interrupted / 僵死的 running、pending 才值得续跑
    # （以前只认 paused，一次部署就把 385/1000 的进度废掉）
    if status not in (store.STATUS_PAUSED, store.STATUS_RUNNING, store.STATUS_PENDING,
                      "interrupted"):
        return meta
    if str(meta.get("finished_at") or ""):
        return meta
    # 从「已完成次数之后」继续
    store.patch_meta(run_id, status=store.STATUS_PENDING)
    start(run_id)
    return store.load_meta(run_id)


def stop(run_id: str) -> dict[str, Any]:
    store.request_stop(run_id)
    store.clear_pause(run_id)
    return store.load_meta(run_id)


# --------------------------------------------------------------------------- #
# 主循环
# --------------------------------------------------------------------------- #
def _sample(days: list[_dt.date], limit: int) -> list[_dt.date]:
    """均匀抽样（保持时间顺序），用于搜索阶段的排序。"""
    if len(days) <= limit:
        return list(days)
    step = len(days) / float(limit)
    return [days[int(index * step)] for index in range(limit)]


class _Control:
    """暂停 / 停止的收口点（只在这里读写 meta，别处不要重复判断）。"""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self._started = time.perf_counter()

    def stop_requested(self) -> bool:
        return store.stop_requested(self.run_id)

    def wait_if_paused(self) -> bool:
        """暂停中原地等待；返回 True 表示应该收工（停止）。"""
        paused = False
        while store.pause_requested(self.run_id) and not store.stop_requested(self.run_id):
            if not paused:
                paused = True
                progress = dict(store.load_meta(self.run_id).get("progress") or {})
                progress["phase"] = "paused"
                store.patch_meta(self.run_id, status=store.STATUS_PAUSED, progress=progress)
            time.sleep(1.0)
        if paused and not store.stop_requested(self.run_id):
            progress = dict(store.load_meta(self.run_id).get("progress") or {})
            progress["phase"] = "searching"
            store.patch_meta(self.run_id, status=store.STATUS_RUNNING, progress=progress)
        return store.stop_requested(self.run_id)

    def elapsed(self) -> int:
        return int(time.perf_counter() - self._started)


def _throttle() -> None:
    """把推理线程压到「留一个核给系统」：绑核 + 降优先级。

    用户 2026-10-24 第 3 条：*「服务器跑条件推理任务的时候，cpu不能占满，需要给服务器空一个
    cpu核心」*。Linux 的 ``sched_setaffinity(0, ...)`` 只影响**当前线程**，所以网页/接口
    线程仍然能用满所有核，只有这个搜索线程被限制在 ``n-1`` 个核上跑。
    """
    try:
        cores = os.cpu_count() or 1
        if cores > 1:
            os.sched_setaffinity(0, set(range(cores - 1)))
    except (AttributeError, OSError):  # 非 Linux 或没权限：不致命
        pass
    try:
        os.nice(10)  # 只降当前线程的优先级（nice 在 Linux 上是 per-thread）
    except OSError:
        pass


def _score_100(metrics: Any, reference: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """把一次完整评估映射成 0–100 分（与数据分析用的是同一个评分模块）。

    口径：方法 3 的「扣成本可执行胜率」，超额按**日**算（同日基准差），
    t 值用逐日序列算 —— 同一天命中的几百只股票不是独立样本。
    """
    from .engine import primary_metric

    metric, _ = primary_metric("stat_v3")
    windows: list[dict[str, Any]] = []
    for index, horizon in enumerate(metrics.horizons):
        windows.append({
            "window": horizon,
            "n": metrics.signal_count(index, metric),
            "p_net": metrics.rate(index, metric),
            "base_p": metrics.base_rate(index, metric),
            "excess_pp": metrics.day_excess(index, metric),
            "t": metrics.day_t(index, metric),
            "n_eff": None,
            "expectancy": None,
        })
    best = scoring100.best_horizon_by_lower(windows) or windows[0]
    best_index = metrics.horizons.index(best["window"])
    years = [value for value in metrics.year_excess(best_index, metric).values()]
    return scoring100.score_segment(
        windows=windows,
        events=metrics.signals(),
        days=metrics.days_with_hits(),
        year_excess=years,
        layer_excess=(),
        stress_excess=None,
        reference=reference,
    )


def _loop(run_id: str) -> None:
    _throttle()
    control = _Control(run_id)
    meta = store.load_meta(run_id)
    try:
        store.patch_meta(run_id, status=store.STATUS_RUNNING,
                         progress={**(meta.get("progress") or {}), "phase": "loading"})
        request = base_request_of(meta["preset"], meta.get("markets"), meta.get("include_st"))
        method_id = meta.get("method") or "stat_v3"
        train_days = [_dt.date.fromisoformat(day) for day in meta["train_days"]]
        valid_days = [_dt.date.fromisoformat(day) for day in meta["valid_days"]]
        search = _sample(train_days, int(meta.get("search_days") or SEARCH_DAYS))
        iterations = int(meta.get("iterations") or 0)
        base_rule = meta["base_rule"]
        summary = meta.get("base_summary") or "基础条件"

        conn = fork_market._connect()
        try:
            universe = load_universe(conn, request.markets, request.include_st)
            base_k = max(1, required_bars_of_group(compile_rule(request), int(request.trading_days)))
            warm_need = max(WARMUP_DAYS, base_k)
            warm = forward.trading_calendar(
                conn, train_days[0] - _dt.timedelta(days=warm_need * 2 + 60), train_days[0])
            world_start = warm[-(warm_need + 1)] if len(warm) > warm_need else train_days[0]
            # 读到最后一天：最后一段信号还要向前看 31 个交易日才算得出涨幅，
            # 只读到 valid_end 会让尾部的信号全部「不可验证」
            world_end = _dt.date.fromisoformat(
                meta.get("latest_trade_date") or str(max(valid_days[-1], train_days[-1])))
            calendar = load_calendar(conn, world_start, world_end)

            def load_progress(done: int, total: int) -> None:
                progress = dict(store.load_meta(run_id).get("progress") or {})
                progress["load_progress"] = round(done / max(1, total), 3)
                progress["load_label"] = f"{done}/{total} 只股票"
                store.patch_meta(run_id, progress=progress)

            dataset = load_dataset(conn, universe, calendar, progress=load_progress,
                                   should_stop=control.stop_requested)
        finally:
            conn.close()

        engine = Engine(dataset, request)
        store.patch_meta(run_id, progress={**(store.load_meta(run_id).get("progress") or {}),
                                           "phase": "searching", "load_progress": 1.0})

        indices = [index for index in (dataset.day_index(day) for day in search)
                   if index is not None]
        if not indices:
            raise InferParamsInvalid("抽样后的交易日为空（行情数据可能没覆盖训练段）")

        rng = random.Random(int(meta.get("seed") or 0))
        seen = {space.canonical(space.make_rule(base_rule, []))}
        elite: list[dict[str, Any]] = []
        evaluated = 0
        done = 0
        misses = 0
        last_seconds = 0.0
        # 成功 / 失败次数（用户 2026-10-24 第 7 条）：失败的变体只在内存里计数，
        # 不写 results.jsonl，也不留任何文件 —— 长跑几千次时磁盘是会被写满的。
        successes = 0
        failed = 0
        exhausted = False

        def run_variant(rule: dict[str, Any], filters: list[dict[str, Any]],
                        parent: Optional[dict[str, Any]], operator: str,
                        trial: bool = True,
                        tree: Optional[dict[str, Any]] = None,
                        desc: Optional[str] = None) -> Optional[dict[str, Any]]:
            nonlocal evaluated, last_seconds, failed
            issues = engine.validate(rule)
            if issues:
                failed += 1
                return None
            began = time.perf_counter()
            metrics = engine.evaluate(rule, indices, should_stop=control.stop_requested)
            last_seconds = time.perf_counter() - began
            evaluated += 1
            score, horizon = score_of(metrics, method_id)
            row = {
                "index": evaluated,
                "desc": desc or space.describe(summary, filters),
                "base": tree if tree is not None else base_rule,
                "filters": [{"name": item["name"], "params": dict(item.get("params") or {})}
                            for item in filters],
                "operator": operator,
                "parent": parent.get("index") if parent else None,
                "rule": rule,
                "score": score,
                "best_horizon": horizon,
                "signals": metrics.signals(),
                "days_with_hits": metrics.days_with_hits(),
                "days": metrics.days,
                "evaluated_at": store._now(),
                "seconds": round(last_seconds, 1),
                "rows": metrics.table(),
                "trial": trial,
            }
            store.append_result(run_id, row)
            remaining = max(0, iterations - done)
            store.patch_meta(run_id, done_iterations=done, progress={
                "phase": "searching",
                "done_iterations": done,
                "iterations": iterations,
                "current": row["desc"],
                "current_score": score,
                "current_signals": metrics.signals(),
                "best_score": elite[0]["score"] if elite else None,
                "best_desc": elite[0]["desc"] if elite else "",
                "elite": len(elite),
                "elapsed_s": control.elapsed(),
                "eta_s": int(last_seconds * remaining) if last_seconds else None,
                "variants_evaluated": evaluated,
                "load_progress": 1.0,
                "load_label": f"{len(universe)} 只股票",
            })
            return row

        def consider(row: Optional[dict[str, Any]]) -> None:
            if not row or row.get("score") is None:
                return
            elite.append(row)
            elite.sort(key=lambda item: float(item.get("score") or -999), reverse=True)
            while len(elite) > ELITE_SIZE:
                elite.pop()

        # ---- 断点续跑：把上次已评估的变体读回来（1000 次要跑十几小时，进程重启不能从头来）
        previous = store.read_results(run_id)
        if previous:
            evaluated = len(previous)
            for row in previous:
                if not isinstance(row, dict) or not isinstance(row.get("rule"), dict):
                    continue
                try:
                    seen.add(space.canonical(row["rule"]))
                except Exception:  # noqa: BLE001 - 老结果里可能有画不出来的规则
                    continue
                consider(row)
            done = max(0, min(iterations, len(previous) - 1))  # 第一行是基础条件
            store.patch_meta(run_id, done_iterations=done,
                             progress={**(store.load_meta(run_id).get("progress") or {}),
                                       "phase": "searching",
                                       "done_iterations": done,
                                       "successes": done,
                                       "failures": 0,
                                       "attempts": done})

        # ---- 第 0 步：基础条件本身（不计入优化次数，只做基准）
        if not previous:
            consider(run_variant(space.make_rule(base_rule, []), [], None, "base", tree=base_rule,
                                 desc=space.describe_tree(base_rule, [],
                                                          int(request.trading_days))))

        # ---- 主循环：每一次循环 = 一次「调整优化」
        while done < iterations:
            if control.wait_if_paused():
                break
            parent: Optional[dict[str, Any]] = None
            if elite and rng.random() < 0.85:
                # 偏向排名靠前的父代（平方分布），但不是只盯着第一名
                pick = int((rng.random() ** 2) * len(elite))
                parent = elite[min(pick, len(elite) - 1)]
            filters = list(parent["filters"]) if parent else []
            # 每个变体自己的基础条件树（用户第 1 条允许替换基础条件之后，它不再是常量）
            parent_tree = parent.get("base") if parent else None
            tree = copy.deepcopy(parent_tree if isinstance(parent_tree, dict) else base_rule)
            # swap = 换基础条件：上一轮在 873 次就把空间穷举完了，就是因为没有这一步
            operator = rng.choices(("add", "tune", "tree", "remove", "swap"),
                                   weights=(0.28, 0.24, 0.18, 0.10, 0.20))[0]
            if operator == "add":
                candidate = space.add_filter(filters, rng, excluded=space.base_names(tree))
                if candidate is None:
                    operator = "tune"
                else:
                    filters = candidate
            if operator == "tune":
                candidate = space.jitter_filters(filters, rng)
                if candidate is None:
                    operator = "tree"
                else:
                    filters = candidate
            if operator == "tree":
                tree, key = space.jitter_tree(tree, rng)
                if key is None:
                    misses += 1
                    if misses >= MAX_MISSES:
                        break
                    continue
            if operator == "swap":
                tree, swapped = space.replace_condition(tree, rng)
                if swapped is None:
                    misses += 1
                    if misses >= MAX_MISSES:
                        break
                    continue
            if operator == "remove":
                candidate = space.remove_filter(filters, rng)
                if candidate is None:
                    misses += 1
                    if misses >= MAX_MISSES:
                        break
                    continue
                filters = candidate
            rule = space.make_rule(tree, filters)
            canonical = space.canonical(rule)
            if canonical in seen:
                misses += 1
                if misses >= MAX_MISSES:
                    exhausted = True
                    break
                continue
            seen.add(canonical)
            row = run_variant(rule, filters, parent, operator, tree=tree,
                              desc=space.describe_tree(tree, filters, int(request.trading_days)))
            if row is None:
                misses += 1
                if misses >= MAX_MISSES:
                    exhausted = True
                    break
                continue
            misses = 0
            done += 1
            consider(row)
            store.patch_meta(run_id, done_iterations=done,
                             progress={**(store.load_meta(run_id).get("progress") or {}),
                                       "done_iterations": done,
                                       "successes": done,
                                       "failures": failed,
                                       "attempts": done + failed,
                                       "exhausted": exhausted})

        # ---- 最终验算：完整训练段 + 验证段
        finals: list[dict[str, Any]] = []
        if elite:
            store.patch_meta(run_id, progress={
                **(store.load_meta(run_id).get("progress") or {}),
                "phase": "verifying", "current": "最终验算（完整训练段 + 验证段）",
            })
            train_all = [index for index in (dataset.day_index(day) for day in train_days)
                         if index is not None]
            valid_all = [index for index in (dataset.day_index(day) for day in valid_days)
                         if index is not None]
            min_valid_signals = max(100, MIN_SIGNALS // 3)
            min_valid_days = max(10, MIN_DAYS_WITH_HITS // 2)
            for rank, row in enumerate(elite[:FINALISTS], start=1):
                if control.stop_requested():
                    break
                try:
                    train_metrics = engine.evaluate(row["rule"], train_all,
                                                    should_stop=control.stop_requested,
                                                    collect_stocks=True)
                    valid_metrics = engine.evaluate(row["rule"], valid_all,
                                                    should_stop=control.stop_requested,
                                                    collect_stocks=True)
                except InterruptedError:
                    break
                train_score, train_horizon = score_of(train_metrics, method_id)
                valid_score, valid_horizon = score_of(valid_metrics, method_id)
                # 0–100 分（用户 2026-10-24 第 1/9 条）：推理段先算，测试段带衰减惩罚
                train_grade = _score_100(train_metrics)
                valid_grade = _score_100(valid_metrics, reference=train_grade)
                combined = scoring100.combined(train_grade, valid_grade)
                # 有效范围：通用（整条 ≥60）还是个股（某只股票 ≥80），
                # 用户 2026-11-03 第 3/4/5 条
                scope_info = infer_scope.judge(train_metrics, valid_metrics, train_grade, valid_grade)
                passed = bool(combined.get("verdict") == "pass")
                kept = bool(scope_info["scopes"])
                finals.append({
                    "rank": rank,
                    "desc": row["desc"],
                    "rule": row["rule"],
                    "base": row.get("base") or base_rule,
                    "filters": row["filters"],
                    "operator": row["operator"],
                    "trial_score": row.get("score"),
                    "trial_horizon": row.get("best_horizon"),
                    "train_score": train_score,
                    "train_horizon": train_horizon,
                    "train_signals": train_metrics.signals(),
                    "train_days": train_metrics.days,
                    "valid_score": valid_score,
                    "valid_horizon": valid_horizon,
                    "valid_signals": valid_metrics.signals(),
                    "valid_days": valid_metrics.days,
                    # 0–100 评分（界面上一眼看的两个数）
                    "train_grade": train_grade,
                    "valid_grade": valid_grade,
                    "combined": combined,
                    "passed": passed,
                    # 有效范围 + 个股名单（第 2/4/5 条）
                    "kept": kept,
                    "scope": scope_info["scopes"],
                    "scope_label": scope_info["scope_label"],
                    "stock_best_score": scope_info["stock_best_score"],
                    "stock_qualified": scope_info["stock_qualified"],
                    "stock_universe": scope_info["stock_universe"],
                    "stock_list": scope_info["stock_list"],
                    "train_rows": train_metrics.table(),
                    "valid_rows": valid_metrics.table(),
                })
        store.save_finalists(run_id, finals)

        stopped = control.stop_requested()
        best_final = None
        if finals:
            best_final = max(
                finals,
                key=lambda item: ((item.get("combined") or {}).get("score") or -1,
                                  (item.get("train_grade") or {}).get("score") or -1),
            )
        scores_payload = None
        if best_final:
            scores_payload = {
                "train": {key: (best_final.get("train_grade") or {}).get(key)
                          for key in ("score", "grade", "best_window", "excess_pp", "lower_pp", "events", "days")},
                "test": {key: (best_final.get("valid_grade") or {}).get(key)
                         for key in ("score", "grade", "best_window", "excess_pp", "lower_pp", "events", "days")},
                "verdict": best_final.get("combined"),
                "desc": best_final.get("desc"),
                # 有效范围（用户 2026-11-03 第 2/3/4 条）：通用 / 个股 / 通用+个股
                "scope": best_final.get("scope") or [],
                "scope_label": best_final.get("scope_label") or "—",
                "stock_best_score": best_final.get("stock_best_score"),
                "stock_qualified": best_final.get("stock_qualified") or 0,
            }
        # 跑满一轮却一个入围变体都没有 = 所有变体信号不足（条件过窄），
        # 这种轮次不该显示「已完成、无评分」—— 历史里必须能一眼看出白跑了一轮。
        final_status, final_error = final_outcome(stopped, done, bool(finals))
        store.patch_meta(
            run_id,
            status=final_status,
            error=final_error,
            done_iterations=done,
            successes=done,
            failures=failed,
            exhausted=exhausted,
            finished_at=store._now(),
            scores=scores_payload,
            best_desc=(best_final or {}).get("desc"),
            best_score=(scores_payload or {}).get("verdict", {}).get("score") if scores_payload else None,
            progress={
                **(store.load_meta(run_id).get("progress") or {}),
                "phase": "stopped" if stopped else "finished",
                "done_iterations": done,
                "iterations": iterations,
                "elapsed_s": control.elapsed(),
                "eta_s": 0,
                "finalists": len(finals),
                "passed": sum(1 for item in finals if item.get("passed")),
                "successes": done,
                "failures": failed,
                "attempts": done + failed,
                "exhausted": exhausted,
            },
        )
    except InterruptedError:
        store.patch_meta(run_id, status=store.STATUS_STOPPED,
                         progress={**(store.load_meta(run_id).get("progress") or {}),
                                   "phase": "stopped"})
    except Exception as exc:  # noqa: BLE001 - 任何异常都落进 meta，别让界面一直转圈
        logger.exception("条件推理失败：%s", exc)
        store.patch_meta(run_id, status=store.STATUS_FAILED, error=str(exc),
                         progress={**(store.load_meta(run_id).get("progress") or {}),
                                   "phase": "failed"})


# --------------------------------------------------------------------------- #
# 读结果 / 保存条件
# --------------------------------------------------------------------------- #
def final_outcome(stopped: bool, done: int, has_finalists: bool) -> tuple[str, Optional[str]]:
    """一轮结束后该落什么状态。

    * 用户停止            → stopped
    * 一次都没评估出来     → failed（基础条件筛选不出股票，搜索空间为空）
    * 跑满一轮但无入围变体 → failed（所有变体有效信号不足，这轮没有评分）
    * 其余                → done

    为什么空跑必须标 failed：历史里如果显示「已完成」却没有评分，用户看不出
    这一轮其实是白跑的（2026-11-02 之前十几轮都这样）。
    """
    if stopped:
        return store.STATUS_STOPPED, None
    if done == 0:
        return store.STATUS_FAILED, "基础条件在该窗口没有任何信号：搜索空间为空"
    if not has_finalists:
        return store.STATUS_FAILED, "所有变体有效信号不足，本轮无评分（基础条件过窄）"
    return store.STATUS_DONE, None


def results(run_id: str, limit: int = 50) -> dict[str, Any]:
    rows = store.read_results(run_id)
    ranked = [row for row in rows if row.get("score") is not None]
    ranked.sort(key=lambda item: float(item.get("score") or 0), reverse=True)
    return {
        "run_id": run_id,
        "evaluated": len(rows),
        "ranked": len(ranked),
        "rows": ranked[:limit],
        "finalists": store.read_finalists(run_id),
    }


#: 名字末尾的评分后缀：``_999_778`` / ``_716``（2–4 位数字，1–2 段）。
#: 只认 2 位以上，避免把 ``base_1`` 这种自带数字的名字误当已带后缀。
SCORE_SUFFIX_RE = re.compile(r"(?:_\d{2,4}){1,2}$")


def _score_suffix(meta: dict[str, Any]) -> str:
    """评分 ×10 取整数部分，拼成名字后缀（用户 2026-11-05）。

    99.9 / 77.8 → ``_999_778``；只有一段（单段分析）→ ``_716``。
    没有分数的段直接跳过：推理轮里验证段没跑出分，不该让整条后缀消失。
    整数部分用 ``int()`` 向下取整：81.9 → 819。
    """
    scores = meta.get("scores") or {}
    parts: list[str] = []
    for key in ("train", "test"):
        value = (scores.get(key) or {}).get("score")
        if value is None:
            continue
        try:
            parts.append(str(int(float(value) * 10)))
        except (TypeError, ValueError):
            continue
    return "_" + "_".join(parts) if parts else ""


def scored_name(name: str, scores: dict[str, Any] | None) -> str:
    """给名字补上评分后缀；已经带后缀的不重复追加。

    用户 2026-11-05 第 1/2 条：已保存条件与新推理出来的条件，名字里都要有分数。
    """
    stem = str(name or "")
    if SCORE_SUFFIX_RE.search(stem):
        return stem
    return f"{stem}{_score_suffix({'scores': scores or {}})}"


def save_condition(run_id: str, index: int, name: Optional[str] = None) -> dict[str, Any]:
    """把一个变体保存成「已保存条件」，之后可以直接拿去条件选股 / 数据分析。"""
    meta = store.load_meta(run_id)
    rule: Optional[dict[str, Any]] = None
    for row in store.read_finalists(run_id):
        if int(row.get("rank") or 0) == index:
            rule = row.get("rule")
            break
    if rule is None:
        for row in store.read_results(run_id):
            if int(row.get("index") or 0) == index:
                rule = row.get("rule")
                break
    if rule is None:
        raise InferParamsInvalid(f"没有编号为 {index} 的变体")
    base = meta.get("base_request") or {}
    request = ScreenRequest.model_validate({
        "trading_days": base.get("trading_days", 30),
        "markets": base.get("markets", ["sh", "sz", "cyb", "kcb"]),
        "include_st": bool(base.get("include_st", False)),
        "rule": rule,
    })
    # 名字里带上两段评分（用户 2026-11-05 第 2 条）：xxx_999_778。
    # 同名再存（同一分数被存第二次）时加序号 —— presets.save 不允许静默覆盖，
    # 而用户看到「已存在同名条件」也不知道该改什么。
    stem = str(name) if name else f"{meta.get('preset', 'xg')}-{index}"
    suffix = _score_suffix(meta)
    final_name = f"{stem}{suffix}"
    payload = request.model_dump(mode="json")
    for attempt in range(1, 10):
        try:
            return presets.save(final_name, payload, overwrite=False)
        except presets.PresetExists:
            final_name = f"{stem}{suffix}_{attempt}"
            continue
    raise presets.PresetExists(f"同名条件太多，换一个名字再存（最后一次尝试：{final_name}）")

