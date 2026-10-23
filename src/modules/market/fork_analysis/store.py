"""分析任务的磁盘存储：一个任务一个目录，任务状态在 ``meta.json``，明细在 SQLite。

目录布局（与「条件代号/id.xlsx」的要求一致）::

    data/analysis_runs/<条件名>/<任务id>/
        meta.json     任务参数 + 状态 + 进度（原子写）
        signals.db    逐条信号（SQLite，统计和分页直接查库，不走 Excel）
        明细.xlsx     结果工作簿（跑完/停止后生成）

为什么不上 PanWatch 自己的库
---------------------------
上游的 ``panwatch.db`` 是应用状态库（自选、AI 配置…），本功能是「一次跑几小时、
可随时删掉」的批量产物，混进去会让备份与迁移都变复杂。任务目录整块删掉即可。

为什么进度写在文件而不是 SQLite
------------------------------
进度要能在**进程被杀**之后原样读出来判断「跑到哪一天了」，而 SQLite 里的
``days`` 表天然就是断点（按着它有记录 = 那天完成了）。``meta.json`` 只额外记住
「有没有被要求停止」这类状态，两者都不会互相覆盖。
"""

from __future__ import annotations

import json
import os
import random
import sqlite3
import string
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from ..fork_screen import presets
from .models import FORWARD_DAYS, HORIZONS

#: src/modules/market/fork_analysis/store.py → 仓库根
PROJECT_ROOT = Path(__file__).resolve().parents[4]
RUNS_DIR = PROJECT_ROOT / "data" / "analysis_runs"

#: 涨幅列 r1..r30 + 触及列 t5..t30（组合成宽表：一条信号一行，统计用 SUM(CASE …)）
RETURN_COLUMNS: tuple[str, ...] = tuple(f"r{i}" for i in range(1, FORWARD_DAYS + 1))
#: 可执行口径（次日开盘买入）x1..x30 —— 与 r 并列存，Excel 仍用 r（格式不变）
EXEC_COLUMNS: tuple[str, ...] = tuple(f"x{i}" for i in range(1, FORWARD_DAYS + 1))
#: 入场假设敏感性（次日典型价 (O+H+C)/3 买入）v1..v30 —— 只用于「换一种成交假设
#: 结论还成不成立」，不参与主口径统计
VWAP_COLUMNS: tuple[str, ...] = tuple(f"v{i}" for i in range(1, FORWARD_DAYS + 1))
TOUCH_COLUMNS: tuple[str, ...] = tuple(f"t{horizon}" for horizon in HORIZONS)

#: 数据质量列（2026-10-23）：verif=0 的行统计时剔除，不是删掉 —— 要能数出「多少行
#: 因为长期停牌/退市/缺复权而不可验证」，这本身就是结论的一部分。
QUALITY_COLUMNS: dict[str, str] = {
    "entry_open": "REAL",     # 次日开盘价（不复权）
    "entry_days": "INTEGER",  # 第几个交易日建仓（停牌会推后）
    "verif": "INTEGER",       # 1 可用 / 0 不可验证
    "stale_days": "INTEGER",  # 最长连续顺延天数
    "unfillable": "INTEGER",  # 次日开盘涨停，买不进
    "adj_missing": "INTEGER",  # 复权因子缺失天数
}

#: 信号当天的快照列（用户在 2026-10-22 第 11 条要的「按不同变量分类」都要靠它们）。
#: 全部取自 d0 那一根 K 线 + ``stock_info``，不要在统计时回头查行情库 —— 一个任务
#: 几十万条、跨七年，回头查会变成几千次往返。
SNAPSHOT_COLUMNS: dict[str, str] = {
    "industry": "TEXT",       # 行业大类（stock_info.industry，数据同步写入）
    "industry_l1": "TEXT",    # 行业门类（stock_info.industry_l1）
    "mcap": "REAL",           # 总市值（亿元）
    "pe": "REAL",             # 市盈率 TTM（负值 = 亏损）
    "pb": "REAL",             # 市净率
    "turnover": "REAL",       # 换手率（%）
    "amount": "REAL",         # 成交额（亿元）
    "amplitude": "REAL",      # 振幅（%）
    "listed_days": "INTEGER",  # 上市交易日数（次新股识别）
    "breadth": "REAL",        # 当天全市场上涨家数占比（0–1，大盘环境）
    "crowd": "INTEGER",       # 当天命中数（拥挤度：同一天有多少只同时命中）
}

_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS days (
    d0          TEXT PRIMARY KEY,
    hits        INTEGER NOT NULL,
    control     INTEGER NOT NULL,
    elapsed_ms  INTEGER NOT NULL,
    coverage    INTEGER,
    usable      INTEGER,
    screen_ms   INTEGER,
    forward_ms  INTEGER
);
CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    d0          TEXT NOT NULL,
    code        TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    name        TEXT NOT NULL,
    board       TEXT NOT NULL,
    is_control  INTEGER NOT NULL,
    d0_close    REAL NOT NULL,
    avail       INTEGER NOT NULL,
    {", ".join(f"{name} REAL" for name in RETURN_COLUMNS)},
    {", ".join(f"{name} REAL" for name in EXEC_COLUMNS)},
    {", ".join(f"{name} REAL" for name in VWAP_COLUMNS)},
    {", ".join(f"{name} REAL" for name in TOUCH_COLUMNS)},
    {", ".join(f"{name} {kind}" for name, kind in QUALITY_COLUMNS.items())},
    {", ".join(f"{name} {kind}" for name, kind in SNAPSHOT_COLUMNS.items())}
);
CREATE INDEX IF NOT EXISTS idx_signals_code ON signals(code);
CREATE INDEX IF NOT EXISTS idx_signals_group ON signals(is_control);
CREATE INDEX IF NOT EXISTS idx_signals_d0 ON signals(d0);
"""

#: 方法 2 的窗口（与 ``methods.method2.WINDOWS`` 必须一致；这里写死是为了不在 import
#: 期把 methods → stats → store 串成环，测试里有一条断言两边相等）
M2_WINDOWS: tuple[int, ...] = (5, 10, 15, 20, 25, 35)

#: 方法 2 的事件表：一条信号一行，窗口极值直接存绝对价（后复权），统计时再除以买入价。
#: 存绝对价而不是涨幅，是因为「窗口内最高价」要能按任意窗口复算（规格第 10 节的可复算要求）。
_M2_SCHEMA = f"""
CREATE TABLE IF NOT EXISTS m2_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    d0            TEXT NOT NULL,
    code          TEXT NOT NULL,
    symbol        TEXT NOT NULL,
    name          TEXT NOT NULL,
    board         TEXT NOT NULL,
    is_control    INTEGER NOT NULL,
    buy_price     REAL NOT NULL,
    d0_close      REAL NOT NULL,
    avail         INTEGER NOT NULL,
    entry_days    INTEGER,
    valid         INTEGER NOT NULL,
    reason        TEXT,
    {", ".join(f"mh{window} REAL" for window in M2_WINDOWS)},
    {", ".join(f"ml{window} REAL" for window in M2_WINDOWS)},
    {", ".join(f"{name} {kind}" for name, kind in SNAPSHOT_COLUMNS.items())}
);
CREATE INDEX IF NOT EXISTS idx_m2_code ON m2_events(code);
CREATE INDEX IF NOT EXISTS idx_m2_d0 ON m2_events(d0);
CREATE INDEX IF NOT EXISTS idx_m2_group ON m2_events(is_control);
"""

#: 方法 2 产物目录（CSV + report.md，跑完/按需生成）
ARTIFACTS_DIRNAME = "artifacts"

_LOCK = threading.Lock()

STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_STOPPED = "stopped"
STATUS_FAILED = "failed"

_TERMINAL = {STATUS_DONE, STATUS_STOPPED, STATUS_FAILED}


class RunNotFound(LookupError):
    """任务 id 找不到（目录被删或 id 写错）。"""


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_run_id() -> str:
    """``20261022-153012-a1b2``：可按文件名排序 = 按创建时间排序。"""
    suffix = "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(4))
    return f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{suffix}"


def run_dir(preset: str, run_id: str) -> Path:
    return RUNS_DIR / presets.normalize_name(preset) / run_id


def db_path(preset: str, run_id: str) -> Path:
    return run_dir(preset, run_id) / "signals.db"


def excel_path(preset: str, run_id: str) -> Path:
    return run_dir(preset, run_id) / "明细.xlsx"


def artifacts_dir(preset: str, run_id: str) -> Path:
    """产物目录（方法 2 的 CSV/report.md；统一接口按名字从这里取文件）。"""
    return run_dir(preset, run_id) / ARTIFACTS_DIRNAME


def _write_json(path: Path, payload: Any) -> None:
    """临时文件 + ``os.replace``：进程中途被杀也不会留下半个 JSON。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".tmp-{path.name}")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


def save_meta(preset: str, meta: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        _write_json(run_dir(preset, meta["run_id"]) / "meta.json", meta)
    return meta


def load_meta(preset: str, run_id: str) -> dict[str, Any]:
    path = run_dir(preset, run_id) / "meta.json"
    if not path.is_file():
        raise RunNotFound(f"分析任务 {run_id} 不存在")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def patch_meta(preset: str, run_id: str, **fields: Any) -> dict[str, Any]:
    """读-改-写。单进程单写者（一个任务只有一个线程），加锁够用。"""
    with _LOCK:
        path = run_dir(preset, run_id) / "meta.json"
        if not path.is_file():
            raise RunNotFound(f"分析任务 {run_id} 不存在")
        with path.open(encoding="utf-8") as handle:
            meta = json.load(handle)
        meta.update(fields)
        _write_json(path, meta)
        return meta


def list_runs(preset: Optional[str] = None) -> list[dict[str, Any]]:
    """全部任务（新的在前）。读不懂的目录跳过，不让一个坏文件挡住列表。"""
    if preset is not None:
        roots = [RUNS_DIR / presets.normalize_name(preset)]
    else:
        roots = sorted([p for p in RUNS_DIR.glob("*") if p.is_dir()]) if RUNS_DIR.is_dir() else []
    items: list[dict[str, Any]] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in root.glob("*/meta.json"):
            try:
                with path.open(encoding="utf-8") as handle:
                    meta = json.load(handle)
            except (OSError, ValueError):
                continue
            if isinstance(meta, dict) and meta.get("run_id"):
                items.append(meta)
    items.sort(key=lambda item: (item.get("created_at") or "", item.get("run_id") or ""), reverse=True)
    return items


def find_run(run_id: str) -> tuple[str, dict[str, Any]]:
    """按 id 找任务 → ``(条件名, meta)``。id 全局唯一，所以扫一层子目录即可。"""
    if RUNS_DIR.is_dir():
        for root in RUNS_DIR.glob("*"):
            if not (root / run_id / "meta.json").is_file():
                continue
            with (root / run_id / "meta.json").open(encoding="utf-8") as handle:
                return root.name, json.load(handle)
    raise RunNotFound(f"分析任务 {run_id} 不存在")


def request_stop(preset: str, run_id: str) -> None:
    """放一个停止标记文件；主循环每跑完一天看一眼（选股单次要几秒，不必更细）。"""
    path = run_dir(preset, run_id) / "stop"
    path.write_text(_now(), encoding="utf-8")


def stop_requested(preset: str, run_id: str) -> bool:
    return (run_dir(preset, run_id) / "stop").exists()


def _migrate_signals(conn: sqlite3.Connection) -> None:
    """给老任务的 ``signals.db`` 补新列（2026-10-22/23 之前建的表没有这些列）。

    不重建表：老任务的 r1..r30 是几小时跑出来的，补列只加空列，值由
    ``backfill.fill_snapshots`` 按天回填（几秒钟一天）。老表没有 x / verif 列时，
    统计层会自动退回收盘口径（``significance.caliber_columns``），不会报错。
    """
    existing = {str(row[1]) for row in conn.execute("PRAGMA table_info(signals)")}
    added = False
    for name, kind in {**QUALITY_COLUMNS, **SNAPSHOT_COLUMNS,
                       **{n: "REAL" for n in (*EXEC_COLUMNS, *VWAP_COLUMNS)}}.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE signals ADD COLUMN {name} {kind}")
            added = True
    day_columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(days)")}
    for name, kind in (("coverage", "INTEGER"), ("usable", "INTEGER"),
                       ("screen_ms", "INTEGER"), ("forward_ms", "INTEGER")):
        if name not in day_columns:
            conn.execute(f"ALTER TABLE days ADD COLUMN {name} {kind}")
            added = True
    if added:
        conn.commit()


def open_db(preset: str, run_id: str) -> sqlite3.Connection:
    """读写连接（建表 + WAL）。WAL 让「跑着的同时前端能读进度/结果」。"""
    path = db_path(preset, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(_SCHEMA)
    conn.executescript(_M2_SCHEMA)
    _migrate_signals(conn)
    conn.commit()
    return conn


def open_db_readonly(preset: str, run_id: str) -> sqlite3.Connection:
    """只读连接：任务还没建库（0 天命中）时也能安全打开。

    老任务的 signals.db 可能缺快照列（v2 之前建的），只读连接改不了表结构，
    所以先探一次 PRAGMA：缺列就用读写连接补上，再回到只读。否则报告接口会报
    ``no such column: industry``。
    """
    path = db_path(preset, run_id)
    if not path.is_file():
        raise RunNotFound(f"分析任务 {run_id} 还没有数据")
    probe = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10.0)
    try:
        existing = {str(row[1]) for row in probe.execute("PRAGMA table_info(signals)")}
    finally:
        probe.close()
    if existing and any(name not in existing for name in (*SNAPSHOT_COLUMNS, *VWAP_COLUMNS)):
        open_db(preset, run_id).close()
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def insert_signals(conn: sqlite3.Connection, rows: Iterable[dict[str, Any]]) -> int:
    """批量写信号（一条 SQL，一条信号一行）。返回写入行数。"""
    payload = list(rows)
    if not payload:
        return 0
    columns = ["d0", "code", "symbol", "name", "board", "is_control", "d0_close", "avail",
               *RETURN_COLUMNS, *EXEC_COLUMNS, *VWAP_COLUMNS, *TOUCH_COLUMNS, *QUALITY_COLUMNS,
               *SNAPSHOT_COLUMNS]
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO signals ({', '.join(columns)}) VALUES ({placeholders})"
    conn.executemany(sql, [tuple(row.get(name) for name in columns) for row in payload])
    conn.commit()
    return len(payload)


def insert_m2_events(conn: sqlite3.Connection, rows: Iterable[dict[str, Any]]) -> int:
    """方法 2 的事件批量写入。"""
    payload = list(rows)
    if not payload:
        return 0
    columns = ["d0", "code", "symbol", "name", "board", "is_control", "buy_price", "d0_close",
               "avail", "entry_days", "valid", "reason",
               *[f"mh{window}" for window in M2_WINDOWS], *[f"ml{window}" for window in M2_WINDOWS],
               *SNAPSHOT_COLUMNS]
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO m2_events ({', '.join(columns)}) VALUES ({placeholders})"
    conn.executemany(sql, [tuple(row.get(name) for name in columns) for row in payload])
    conn.commit()
    return len(payload)


def update_snapshots(conn: sqlite3.Connection, d0: str, snapshots: dict[str, dict[str, Any]],
                     crowd: int, breadth: float | None) -> int:
    """把某一天的快照写回老信号（补列/回填共用）。"""
    if not snapshots:
        return 0
    columns = list(SNAPSHOT_COLUMNS)
    sql = (
        f"UPDATE signals SET {', '.join(f'{name} = ?' for name in columns)}, crowd = ?, breadth = ? "
        "WHERE d0 = ? AND code = ?"
    )
    payload = []
    for code, values in snapshots.items():
        payload.append(tuple(values.get(name) for name in columns) + (int(crowd), breadth, d0, code))
    conn.executemany(sql, payload)
    conn.commit()
    return len(payload)


def record_day(conn: sqlite3.Connection, d0: str, hits: int, control: int, elapsed_ms: int,
               coverage: int | None = None, usable: int | None = None,
               screen_ms: int | None = None, forward_ms: int | None = None) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO days (d0, hits, control, elapsed_ms, coverage, usable, "
        "screen_ms, forward_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (d0, int(hits), int(control), int(elapsed_ms), coverage, usable, screen_ms, forward_ms),
    )
    conn.commit()


def done_days(conn: sqlite3.Connection) -> list[str]:
    """已完成日期（断点续跑用：有记录的日子直接跳过）。"""
    return [str(row["d0"]) for row in conn.execute("SELECT d0 FROM days ORDER BY d0")]


def day_rows(conn: sqlite3.Connection, limit: int = 20) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT d0, hits, control, elapsed_ms FROM days ORDER BY d0 DESC LIMIT ?", (int(limit),)
    ).fetchall()
    return [dict(row) for row in rows]


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    total = conn.execute("SELECT COUNT(*) AS n FROM signals").fetchone()["n"]
    hits = conn.execute("SELECT COUNT(*) AS n FROM signals WHERE is_control = 0").fetchone()["n"]
    days = conn.execute("SELECT COUNT(*) AS n FROM days").fetchone()["n"]
    return {"signals": int(total), "hits": int(hits), "control": int(total) - int(hits), "days": int(days)}


def counts_for(conn: sqlite3.Connection, method: str = "stat_v1") -> dict[str, int]:
    """按方法数行数：方法 2 的数据在 ``m2_events``，用 ``counts`` 会一律读到 0。"""
    if method == "stat_v2":
        total = conn.execute("SELECT COUNT(*) AS n FROM m2_events").fetchone()["n"]
        hits = conn.execute("SELECT COUNT(*) AS n FROM m2_events WHERE is_control = 0").fetchone()["n"]
        days = conn.execute("SELECT COUNT(*) AS n FROM days").fetchone()["n"]
        return {"signals": int(total), "hits": int(hits), "control": int(total) - int(hits),
                "days": int(days)}
    return counts(conn)


def is_terminal(meta: dict[str, Any]) -> bool:
    return str(meta.get("status")) in _TERMINAL
