"""深度分析2 的**串行任务队列**（与 PanWatch 自己的分析队列完全独立）。

为什么要单开一条队列
--------------------
一次深度分析要打十来个外网接口 + 一次大模型，并发跑几只票会同时压垮上游接口，
也会让「谁先跑」不可控。用户口径是：多只票排队，**第一个是正在运行的，后面是等待**，
可以删掉排队项。所以这里是一条 FIFO、单消费者的线程，与上游 ``analysis`` 队列
不共享任何状态（不排队、不抢占、不写同一个库）。

状态机在 ``store`` 里（queued → running → done/failed/cancelled）。这一层只做三件事：
取下一个、调 ``service._worker``、没有任务时睡一会儿。

为什么不用内存队列（``queue.Queue``）
------------------------------------
进程重启会丢；而用户很可能是「点了一堆票，然后关掉浏览器」。任务落在 SQLite 里，
重启后 ``recover_stale()`` 把死掉的 running 退回 queued，队列接着跑 —— 代价只是
最多重跑一次（没跑完的那份本来也没有结果）。
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from . import store

logger = logging.getLogger(__name__)

#: 队列空转时的唤醒间隔（秒）。任务结束会立刻回到循环，不靠这个轮询。
IDLE_POLL_SECONDS = 1.0

_LOCK = threading.Lock()
_thread: Optional[threading.Thread] = None
_stop = threading.Event()


def ensure_started() -> None:
    """确保消费线程在跑（幂等）。首次启动时把遗留的 running 归位成 queued。"""
    global _thread
    with _LOCK:
        if _thread is not None and _thread.is_alive():
            return
        recovered = store.recover_stale()
        if recovered:
            logger.info("深度分析2：%s 个中断的任务重新入队", recovered)
        _stop.clear()
        _thread = threading.Thread(target=_loop, name="dsa2-queue", daemon=True)
        _thread.start()


def _loop() -> None:
    # 延迟导入：service 依赖 store 与 queue（start 时调 ensure_started），
    # 模块级互引会成环。
    from . import service

    while not _stop.is_set():
        job = store.next_queued()
        if not job:
            _stop.wait(IDLE_POLL_SECONDS)
            continue
        try:
            service._worker(job["symbol"], job["name"], job.get("model_id"), job["id"])
        except Exception:  # noqa: BLE001 - _worker 自己会落 failed，这里只防线程猝死
            logger.exception("深度分析2 队列消费异常 %s", job.get("symbol"))


def stop(timeout: float = 5.0) -> None:
    """停掉消费线程（进程退出 / 测试清理用）。队列内容保留在 SQLite 里。"""
    global _thread
    with _LOCK:
        _stop.set()
        thread, _thread = _thread, None
    if thread is not None:
        thread.join(timeout=timeout)


def drain(timeout: float = 30.0) -> bool:
    """等队列跑空（测试与运维脚本用）。返回是否在超时前跑空。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not store.queue_rows():
            return True
        time.sleep(0.1)
    return False


def enqueue(symbol: str, name: Optional[str] = None, model_id: Optional[int] = None) -> dict:
    """入队并唤醒消费线程；同一只票已在队列里就直接复用它。"""
    existing = store.active(symbol)
    if existing:
        ensure_started()
        existing["queue_position"] = store.queue_position(existing["id"])
        return existing
    report_id = store.create(symbol, name, model_id)
    ensure_started()
    row = store.get(report_id) or {"id": report_id, "symbol": symbol, "status": "queued"}
    row["queue_position"] = store.queue_position(report_id)
    return row
