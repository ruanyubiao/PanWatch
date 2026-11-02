"""条件推理的工作进程（用户 2026-11-03 第 1 条：把推理拆出 API 进程）。

为什么要独立进程
----------------
以前推理是 FastAPI 进程里的一个线程，带来三个连带伤害：

1. **内存**：预读全市场行情占 600–700MB，跟网页/接口挤在同一个 4G 小机器里，
   swap 一度只剩 200MB，任何一次大查询都可能把整机压死（2026-10-24 就这么挂过一次）。
2. **CPU/延迟**：搜索线程抢 GIL，推理跑着的时候「条件选股」从 8 秒变成 60 秒。
3. **生命周期**：一次 `systemctl restart` 就打断推理（线程跟着进程一起没），
   而 meta 里还写着 running，于是任务卡死。

拆出来之后：API 进程只在创建/停止/读 meta 时碰一下，推理崩了也只死自己的工作进程，
状态照样能从 meta.json 与 results.jsonl 恢复（断点续跑）。

用法::

    python -m src.modules.market.fork_infer.worker <run_id>

环境变量
--------
``PANWATCH_INFER_MEM_MB``
    RSS 软上限（默认 1300MB）。超过就主动收工并把状态写成 failed —— 与其被内核
    随机挑一个进程 OOM 杀掉，不如自己退，留下清楚的原因。
``PANWATCH_INFER_AS_MB``
    地址空间硬上限（默认 3000MB，``RLIMIT_AS``）。只是兜底，正常不会碰到：
    Python 的虚拟内存远大于 RSS，限太紧会误杀。
"""

from __future__ import annotations

import os
import resource
import signal
import sys
import threading
import time
from pathlib import Path

DEFAULT_RSS_MB = 1300
DEFAULT_AS_MB = 3000


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, "") or default)
    except ValueError:
        return default
    return value if value > 0 else default


def _rss_mb() -> int:
    """当前进程的常驻内存（MB）。读 /proc 而不是 psutil，少一个依赖。"""
    try:
        with open("/proc/self/statm", "r", encoding="utf-8") as handle:
            pages = int(handle.read().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE") // (1024 * 1024)
    except (OSError, ValueError, IndexError):
        return 0


def apply_limits() -> None:
    """绑核、降优先级、设内存上限。只影响本进程，不影响 API。"""
    cores = os.cpu_count() or 1
    if cores > 1:
        try:
            # 留一个核给系统和网页接口（用户 2026-10-24 第 3 条）
            os.sched_setaffinity(0, set(range(cores - 1)))
        except (AttributeError, OSError):
            pass
    try:
        os.nice(10)
    except OSError:
        pass
    try:
        limit = _env_int("PANWATCH_INFER_AS_MB", DEFAULT_AS_MB) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
    except (OSError, ValueError):
        pass


def _watchdog(run_id: str) -> None:
    """RSS 守护：超限就把任务标成 failed 然后自杀，别等内核 OOM。"""
    limit = _env_int("PANWATCH_INFER_MEM_MB", DEFAULT_RSS_MB)
    from . import store  # 延迟导入：--help 之类的路径不该连数据库

    while True:
        time.sleep(30)
        current = _rss_mb()
        if current <= limit:
            continue
        try:
            progress = dict(store.load_meta(run_id).get("progress") or {})
            progress["phase"] = "failed"
            store.patch_meta(
                run_id,
                status=store.STATUS_FAILED,
                error=f"推理进程内存超过 {limit}MB（当前 {current}MB），已主动退出",
                finished_at=store._now(),
                progress=progress,
            )
        except Exception:  # noqa: BLE001 - 守护线程里不能抛
            pass
        os._exit(3)


def _install_signals(run_id: str) -> None:
    """SIGTERM → 写停止标记后退出：`systemctl stop` 不会留下「永远 running」的僵尸。"""
    from . import store

    def _handler(signum, frame):  # noqa: ANN001, ARG001
        try:
            store.request_stop(run_id)
        finally:
            raise SystemExit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handler)
        except (ValueError, OSError):
            pass


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("用法：python -m src.modules.market.fork_infer.worker <run_id>", file=sys.stderr)
        return 2
    run_id = argv[1]

    from . import search, store

    apply_limits()
    _install_signals(run_id)
    store.write_pid(run_id, os.getpid())
    threading.Thread(target=_watchdog, args=(run_id,), name="infer-watchdog", daemon=True).start()
    try:
        search._loop(run_id)
    finally:
        store.clear_pid(run_id)
    return 0


if __name__ == "__main__":  # pragma: no cover - 进程入口
    raise SystemExit(main(sys.argv))
