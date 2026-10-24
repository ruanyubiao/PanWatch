"""方法 3 的表定义与写入（``m3_events``）。

一条信号一行，直接存**绝对价**（后复权）而不是涨幅，理由跟方法 2 一样：统计期口径改了
（成本模型、窗口、判定阈值）能从库里重算，不必重跑七年的选股。

列命名：``c5`` = 第 5 个交易日的收盘价（停牌顺延后），``mc5`` = 1..5 天内最高收盘价，
``mn5`` = 1..5 天内最低收盘价。三者都以**次日开盘价**为买入基准。
"""

from __future__ import annotations

from typing import Any, Iterable

#: 方法 3 的窗口（与 ``methods.method3.WINDOWS`` 必须一致）
M3_WINDOWS: tuple[int, ...] = (5, 10, 20, 25, 30)


def schema(snapshot_columns: dict[str, str]) -> str:
    """生成 ``m3_events`` 的建表语句。"""
    snapshot_ddl = ", ".join(f"{name} {kind}" for name, kind in snapshot_columns.items())
    return f"""
CREATE TABLE IF NOT EXISTS m3_events (
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
    {", ".join(f"c{window} REAL" for window in M3_WINDOWS)},
    {", ".join(f"mc{window} REAL" for window in M3_WINDOWS)},
    {", ".join(f"mn{window} REAL" for window in M3_WINDOWS)},
    {snapshot_ddl}
);
CREATE INDEX IF NOT EXISTS idx_m3_code ON m3_events(code);
CREATE INDEX IF NOT EXISTS idx_m3_d0 ON m3_events(d0);
CREATE INDEX IF NOT EXISTS idx_m3_group ON m3_events(is_control);
"""


INSERT_COLUMNS: tuple[str, ...] = (
    "d0", "code", "symbol", "name", "board", "is_control", "buy_price", "d0_close",
    "avail", "entry_days", "valid", "reason",
    *[f"c{window}" for window in M3_WINDOWS],
    *[f"mc{window}" for window in M3_WINDOWS],
    *[f"mn{window}" for window in M3_WINDOWS],
)


def insert_rows(conn: Any, rows: Iterable[dict[str, Any]],
                snapshot_columns: dict[str, str]) -> int:
    """批量写入方法 3 事件。"""
    payload = list(rows)
    if not payload:
        return 0
    columns = [*INSERT_COLUMNS, *snapshot_columns]
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO m3_events ({', '.join(columns)}) VALUES ({placeholders})"
    conn.executemany(sql, [tuple(row.get(name) for name in columns) for row in payload])
    conn.commit()
    return len(payload)
