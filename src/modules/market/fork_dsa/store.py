"""报告存储：``<DATA_DIR>/dsa_reports.db``（SQLite，一张表）。

为什么不进 PanWatch 的应用库
---------------------------
应用库 ``panwatch.db`` 是上游管理的（自选、AI 配置、会话…），fork 往里加表会让
上游迁移越来越难对。而且这份数据是「可随时整表删掉」的分析产物，独立文件更好备份
也更好清理 —— 与 ``fork_analysis`` 把任务结果放 ``data/analysis_runs/`` 是同一个理由。

一行就是一次分析：``status`` 先 running，模型回来写 done 或 failed。页面轮询就是
读这张表，所以「刷新页面还能看到上次结果」不需要额外的缓存层。
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
                model_used  TEXT,
                payload     TEXT,
                error       TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_dsa_reports_symbol ON dsa_reports(symbol, id DESC)"
        )


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
        "model_used": row["model_used"],
        "error": row["error"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "report": payload,
    }


def create(symbol: str, name: Optional[str], model_used: Optional[str] = None) -> int:
    init()
    now = _now()
    with _LOCK, _connect() as conn:
        cur = conn.execute(
            "INSERT INTO dsa_reports(symbol, name, status, model_used, created_at, updated_at)"
            " VALUES (?, ?, 'running', ?, ?, ?)",
            (symbol, name, model_used, now, now),
        )
        return int(cur.lastrowid or 0)


def finish(report_id: int, payload: dict[str, Any], model_used: Optional[str]) -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "UPDATE dsa_reports SET status='done', payload=?, model_used=?, error=NULL,"
            " updated_at=? WHERE id=?",
            (json.dumps(payload, ensure_ascii=False), model_used, _now(), report_id),
        )


def fail(report_id: int, error: str) -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "UPDATE dsa_reports SET status='failed', error=?, updated_at=? WHERE id=?",
            (error[:500], _now(), report_id),
        )


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
    """这只票有没有正在跑的分析（避免连点两次重复烧 token）。"""
    init()
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM dsa_reports WHERE symbol=? AND status='running' ORDER BY id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
    return _row_to_dict(row) if row else None
