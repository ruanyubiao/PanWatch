"""条件推理任务的磁盘存储：一个任务一个目录。

目录布局::

    data/infer_runs/<任务id>/
        meta.json       参数 + 状态 + 进度（原子写）
        results.jsonl   每个变体一行结果（追加写，进程被杀也不丢已跑完的）
        finalists.json  最终验算通过的条件（含可直接保存的请求）
        pause           存在 = 用户要求暂停
        stop            存在 = 用户要求停止

为什么结果用 jsonl 不用 SQLite
-----------------------------
一个任务最多几千行（优化次数上限 5000），追加写天然抗中断：跑到第 87 个变体时
进程被杀，前 86 个结果照样能读出来给用户看。SQLite 也行，但为了这点数据多一套
schema 不值当。
"""

from __future__ import annotations

import json
import os
import random
import string
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Optional

#: src/modules/market/fork_infer/store.py → 仓库根
PROJECT_ROOT = Path(__file__).resolve().parents[4]
RUNS_DIR = PROJECT_ROOT / "data" / "infer_runs"

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_PAUSED = "paused"
STATUS_DONE = "done"
STATUS_STOPPED = "stopped"
STATUS_FAILED = "failed"

_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_run_id() -> str:
    """``20261024-153012-abcd``（时间可读 + 4 位随机，防同一秒撞车）。"""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(4))
    return f"{stamp}-{suffix}"


def run_dir(run_id: str) -> Path:
    path = RUNS_DIR / run_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def meta_path(run_id: str) -> Path:
    return run_dir(run_id) / "meta.json"


def results_path(run_id: str) -> Path:
    return run_dir(run_id) / "results.jsonl"


def finalists_path(run_id: str) -> Path:
    return run_dir(run_id) / "finalists.json"


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def save_meta(run_id: str, meta: dict[str, Any]) -> None:
    with _LOCK:
        _atomic_write(meta_path(run_id), json.dumps(meta, ensure_ascii=False, indent=1))


def load_meta(run_id: str) -> dict[str, Any]:
    path = meta_path(run_id)
    if not path.exists():
        raise FileNotFoundError(run_id)
    return json.loads(path.read_text(encoding="utf-8"))


def patch_meta(run_id: str, **fields: Any) -> dict[str, Any]:
    """读改写（单线程任务，加锁足够）。"""
    with _LOCK:
        path = meta_path(run_id)
        meta = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        meta.update(fields)
        _atomic_write(path, json.dumps(meta, ensure_ascii=False, indent=1))
    return meta


def append_result(run_id: str, row: dict[str, Any]) -> None:
    with _LOCK:
        with results_path(run_id).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_results(run_id: str) -> list[dict[str, Any]]:
    path = results_path(run_id)
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def save_finalists(run_id: str, rows: list[dict[str, Any]]) -> None:
    with _LOCK:
        _atomic_write(finalists_path(run_id), json.dumps(rows, ensure_ascii=False, indent=1))


def read_finalists(run_id: str) -> list[dict[str, Any]]:
    path = finalists_path(run_id)
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []


def list_runs(limit: int = 50) -> list[dict[str, Any]]:
    if not RUNS_DIR.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in RUNS_DIR.iterdir():
        if not path.is_dir():
            continue
        try:
            rows.append(load_meta(path.name))
        except (FileNotFoundError, json.JSONDecodeError):
            continue
    rows.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    return rows[:limit]


def delete_run(run_id: str) -> None:
    import shutil

    shutil.rmtree(run_dir(run_id), ignore_errors=True)


# ---------------------------------------------------------------- 控制文件
def _flag(run_id: str, name: str) -> Path:
    return run_dir(run_id) / name


def request_pause(run_id: str) -> None:
    _flag(run_id, "pause").write_text(_now(), encoding="utf-8")


def clear_pause(run_id: str) -> None:
    path = _flag(run_id, "pause")
    if path.exists():
        path.unlink()


def pause_requested(run_id: str) -> bool:
    return _flag(run_id, "pause").exists()


def request_stop(run_id: str) -> None:
    _flag(run_id, "stop").write_text(_now(), encoding="utf-8")


def stop_requested(run_id: str) -> bool:
    return _flag(run_id, "stop").exists()


def clear_stop(run_id: str) -> None:
    path = _flag(run_id, "stop")
    if path.exists():
        path.unlink()
