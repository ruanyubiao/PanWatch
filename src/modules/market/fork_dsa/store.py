"""报告存储 + 任务队列：``<DATA_DIR>/dsa_reports.db``（SQLite，一张表）。

为什么不进 PanWatch 的应用库
---------------------------
应用库 ``panwatch.db`` 是上游管理的（自选、AI 配置、会话…），fork 往里加表会让
上游迁移越来越难对。而且这份数据是「可随时整表删掉」的分析产物，独立文件更好备份
也更好清理 —— 与 ``fork_analysis`` 把任务结果放 ``data/analysis_runs/`` 是同一个理由。

一张表既是**报告库**也是**队列**
--------------------------------
一行 = 一次分析，``status`` 走四态机：

    queued ──claim──> running ──> done
       │                 │
       │                 └──> failed
       └──delete──> (删行)   running 时删除 → cancelled，结果丢弃

队列放 SQLite 而不是内存的理由：进程重启后**排队中的任务还在**（用户口径：多只票
排队，关掉窗口不该丢任务）；重启时把遗留的 ``running`` 归位成 ``queued``（
``recover_stale``），因为上一个进程已经死了，那一份不可能再有人写结果。

``started_at`` 单独一列而不是复用 ``created_at``：用户明确要求刷新页面时「已用时间」
不能归零 —— 计时起点必须是**任务真正开始跑**的时刻，而 ``created_at`` 是**入队**时刻
（排队 3 分钟后才开跑时，两者差很多）。页面头部显示 ``created_at``，计时用 ``started_at``。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from src.platform.runtime.paths import get_data_dir

_LOCK = threading.Lock()

#: 队列里的两种「活着」的状态。其余（done/failed/cancelled）都是历史。
ACTIVE_STATUSES = ("queued", "running")


def _db_path() -> Path:
    directory = get_data_dir()
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "dsa_reports.db"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_db_path(), timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS dsa_reports (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol      TEXT NOT NULL,
                name        TEXT,
                status      TEXT NOT NULL,
                model_id    INTEGER,
                model_used  TEXT,
                payload     TEXT,
                error       TEXT,
                created_at  TEXT NOT NULL,
                started_at  TEXT,
                updated_at  TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dsa_reports_symbol ON dsa_reports(symbol, id DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dsa_reports_status ON dsa_reports(status, id)"
        )
        # 老库（只有 running/done/failed 三态那一版）补列，不重建表、不丢历史报告。
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(dsa_reports)")}
        if "started_at" not in columns:
            conn.execute("ALTER TABLE dsa_reports ADD COLUMN started_at TEXT")
        if "model_id" not in columns:
            conn.execute("ALTER TABLE dsa_reports ADD COLUMN model_id INTEGER")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    payload = None
    if row["payload"]:
        try:
            payload = json.loads(row["payload"])
        except json.JSONDecodeError:
            payload = None
    return {
        "id": row["id"],
        "symbol": row["symbol"],
        "name": row["name"],
        "status": row["status"],
        "model_id": row["model_id"],
        "model_used": row["model_used"],
        "error": row["error"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "updated_at": row["updated_at"],
        "report": payload,
    }


# ── 入队 / 认领 ──────────────────────────────────────────────────────────


def create(symbol: str, name: Optional[str], model_id: Optional[int] = None) -> int:
    """入队一次分析（status=queued）。返回行 id。"""
    init()
    now = _now()
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO dsa_reports(symbol, name, status, model_id, created_at, updated_at)"
            " VALUES (?, ?, 'queued', ?, ?, ?)",
            (symbol, name, model_id, now, now),
        )
        return int(cur.lastrowid or 0)


def mark_running(report_id: int) -> bool:
    """``queued → running`` 的原子认领，同时写下 ``started_at``（计时起点）。

    返回 False 表示这一行已经被删/被取消，调用方应当直接放弃 —— 排队期间用户点过
    「删除」的任务不能再偷偷开跑。
    """
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "UPDATE dsa_reports SET status='running', started_at=?, updated_at=?"
            " WHERE id=? AND status='queued'",
            (_now(), _now(), report_id),
        )
        return cur.rowcount > 0


def next_queued() -> Optional[dict[str, Any]]:
    """取最早排队的那个任务（FIFO）。"""
    init()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM dsa_reports WHERE status='queued' ORDER BY id ASC LIMIT 1"
        ).fetchone()
    return _row_to_dict(row) if row else None


def recover_stale() -> int:
    """进程重启后把遗留的 running 退回 queued（上一个进程已经死了，没人会写结果）。"""
    init()
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "UPDATE dsa_reports SET status='queued', started_at=NULL, updated_at=?"
            " WHERE status='running'",
            (_now(),),
        )
        return int(cur.rowcount or 0)


# ── 状态推进 ─────────────────────────────────────────────────────────────


def finish(report_id: int, payload: dict[str, Any], model_used: Optional[str]) -> None:
    """写结果。**只在 running 时生效** —— 排队/运行期间被取消的任务结果要丢弃。"""
    with _LOCK, _connect() as conn:
        conn.execute(
            "UPDATE dsa_reports SET status='done', payload=?, model_used=?, error=NULL,"
            " updated_at=? WHERE id=? AND status='running'",
            (json.dumps(payload, ensure_ascii=False), model_used, _now(), report_id),
        )


def fail(report_id: int, error: str) -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "UPDATE dsa_reports SET status='failed', error=?, updated_at=?"
            " WHERE id=? AND status='running'",
            (error[:500], _now(), report_id),
        )


def cancel(report_id: int) -> Optional[str]:
    """删除队列项。

    - ``queued``：整行删掉（还没开跑，没有任何价值要留）；
    - ``running``：标 ``cancelled``，线程回来时 ``finish`` 不会覆盖。**不会中断**
      已经在跑的取数与模型调用（那是外部 HTTP），只是把结果丢掉。
    - 其余状态：不在队列里，返回 ``None`` 让接口报 404。
    """
    init()
    with _LOCK, _connect() as conn:
        row = conn.execute("SELECT status FROM dsa_reports WHERE id=?", (report_id,)).fetchone()
        if not row:
            return None
        status = row["status"]
        if status == "queued":
            conn.execute("DELETE FROM dsa_reports WHERE id=?", (report_id,))
            return "deleted"
        if status == "running":
            conn.execute(
                "UPDATE dsa_reports SET status='cancelled', updated_at=? WHERE id=?",
                (_now(), report_id),
            )
            return "cancelled"
        return None


# ── 读取 ─────────────────────────────────────────────────────────────────


def get(report_id: int) -> Optional[dict[str, Any]]:
    init()
    with _connect() as conn:
        row = conn.execute("SELECT * FROM dsa_reports WHERE id=?", (report_id,)).fetchone()
    return _row_to_dict(row) if row else None


def latest(symbol: str) -> Optional[dict[str, Any]]:
    init()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM dsa_reports WHERE symbol=? ORDER BY id DESC LIMIT 1", (symbol,)
        ).fetchone()
    return _row_to_dict(row) if row else None


def latest_done(symbol: str) -> Optional[dict[str, Any]]:
    init()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM dsa_reports WHERE symbol=? AND status='done' ORDER BY id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    return _row_to_dict(row) if row else None


def history(symbol: str, limit: int = 20) -> list[dict[str, Any]]:
    init()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM dsa_reports WHERE symbol=? AND status='done'"
            " ORDER BY id DESC LIMIT ?",
            (symbol, int(limit)),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def running(symbol: str) -> Optional[dict[str, Any]]:
    """这只票正在跑的分析。"""
    init()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM dsa_reports WHERE symbol=? AND status='running' ORDER BY id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    return _row_to_dict(row) if row else None


def active(symbol: str) -> Optional[dict[str, Any]]:
    """这只票在队列里（排队中或运行中）的那一份 —— 连点不重复入队。"""
    init()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM dsa_reports WHERE symbol=? AND status IN ('queued','running')"
            " ORDER BY id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    return _row_to_dict(row) if row else None


def queue_rows() -> list[dict[str, Any]]:
    """队列列表：运行中的永远排第一，其余按入队先后（用户口径：第一个是正在运行的）。"""
    init()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM dsa_reports WHERE status IN ('queued','running')"
            " ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, id ASC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def queue_position(report_id: int) -> int:
    """前面还有几个任务（含正在跑的那个）。

    运行中 → 0；等待中 → （有任务在跑就 +1）+ 排在自己前面的等待任务数。
    页面文案是「前面还有 N 个任务」，把正在跑的那个也算上才不会出现
    「前面 0 个」却还在等的怪话。
    """
    init()
    with _connect() as conn:
        row = conn.execute("SELECT status FROM dsa_reports WHERE id=?", (report_id,)).fetchone()
        if not row:
            return 0
        if row["status"] == "running":
            return 0
        ahead = conn.execute(
            "SELECT COUNT(*) FROM dsa_reports WHERE status='queued' AND id<?", (report_id,)
        ).fetchone()[0]
        running = conn.execute(
            "SELECT COUNT(*) FROM dsa_reports WHERE status='running'"
        ).fetchone()[0]
    return int(ahead or 0) + int(running or 0)
