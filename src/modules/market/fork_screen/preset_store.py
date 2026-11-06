"""已保存条件的 MySQL 存储（用户 2026-11-06 第 3 条）。

为什么不再用文件
----------------
上一版一个条件一个 JSON 文件（``data/screen_presets/<名字>.json``），名字就是
文件名。用户 2026-11-06 要求**改到 MySQL**：文件改名要靠 ``os.replace``、列表要
把整目录读一遍、并发写只能靠进程内的一把锁，而且「条件列表」页要按分数/时间
排序过滤时，只能把全部条件读进内存再排。

表结构（``panwatch.screen_preset``）
------------------------------------
======================  ====================================================
name                    条件名（唯一），也仍然是用户看到的标识
request                 完整选股请求（JSON：统计窗口 / 市场 / ST / 条件树 / 截止日）
note                    调度器写的中文备注（人工建的条件为 NULL）
score1 / score2         名字后缀里的两段评分（各 ×10 取整后的原值除以 10）
saved_at / updated_at   保存时间 / 最后覆盖时间
======================  ====================================================

评分不另存字段来源：名字后缀（``_716_458``）本来就是唯一权威 —— 推理与补分脚本
都按它改名，所以这里在写入时解析一次、落到列上，列表页按列排序即可。

凭据零复制
----------
口令唯一来源仍是 ``/opt/stock/.env``：systemd 用 ``EnvironmentFile=`` 注入，
cron 里的脚本直接解析同一个文件（:func:`load_env_file`）。两者读的是同一份，
不在代码或数据库里出现第二份口令。
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Protocol

logger = logging.getLogger(__name__)

#: 默认库名。表名固定 —— 一个库只放本应用自己的表，不碰 ``stock``（行情库）。
DEFAULT_DB_NAME = "panwatch"
DEFAULT_TABLE = "screen_preset"

#: 建表语句（幂等）。字符集用 utf8mb4：条件名里会有中文。
DDL = """
CREATE TABLE IF NOT EXISTS {table} (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  request JSON NOT NULL,
  note VARCHAR(255) DEFAULT NULL,
  score1 DECIMAL(5,1) DEFAULT NULL,
  score2 DECIMAL(5,1) DEFAULT NULL,
  saved_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_{table}_name (name),
  KEY idx_{table}_saved (saved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
"""

#: 和 ``fork_infer.search.SCORE_SUFFIX_RE`` 完全一致：2–4 位数字、1–2 段。
#: 只认 2 位以上，避免把 ``base_1`` 这种自带数字的名字误判成已带评分。
SCORE_SUFFIX_RE = re.compile(r"(?:_\d{2,4}){1,2}$")

#: 从环境变量读的键名。全都缺 = 没配置条件库（不是「用默认值连一下试试」）。
ENV_KEYS = ("PRESET_DB_HOST", "PRESET_DB_USER", "PRESET_DB_PASSWORD", "PRESET_DB_NAME")


class StoreError(Exception):
    """存储层错误基类（连不上、SQL 失败）。由 ``presets`` 包成对外的错误。"""


class StoreExists(StoreError):
    """同名条件已存在。"""


class StoreNotFound(StoreError):
    """条件不存在。"""


def scores_from_name(name: str) -> tuple[float, ...]:
    """名字后缀 → 评分（``xg_999_778`` → ``(99.9, 77.8)``）。

    后缀由 ``int(score * 10)`` 生成，所以反解是除以 10。没有后缀返回空元组。
    """
    match = SCORE_SUFFIX_RE.search(name or "")
    if not match:
        return ()
    return tuple(round(int(part) / 10, 1) for part in re.findall(r"\d{2,4}", match.group(0)))


def load_env_file(path: str | os.PathLike[str]) -> dict[str, str]:
    """读 ``KEY=VALUE`` 形式的 .env（注释、空行、两端引号都处理）。

    cron 里的脚本没有 systemd 的 ``EnvironmentFile``，用同一个文件补齐 —— 口令
    仍然只有一份。
    """
    values: dict[str, str] = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw = line.partition("=")
        values[key.strip()] = raw.strip().strip('"').strip("'")
    return values


def db_config(env_path: str | None = None) -> dict[str, Any]:
    """从环境变量（其次 ``/opt/stock/.env``）取连接参数。缺项抛 :class:`StoreError`。"""
    file_values = load_env_file(env_path or os.environ.get("PANWATCH_ENV_FILE") or "/opt/stock/.env")

    def get(key: str, default: str | None = None) -> str | None:
        return os.environ.get(key) or file_values.get(key) or default

    missing = [key for key in ENV_KEYS if not get(key)]
    if missing:
        raise StoreError(f"未配置条件库（缺 {', '.join(missing)}）")
    return {
        "host": get("PRESET_DB_HOST"),
        "port": int(get("PRESET_DB_PORT", "3306") or 3306),
        "user": get("PRESET_DB_USER"),
        "password": get("PRESET_DB_PASSWORD"),
        "database": get("PRESET_DB_NAME", DEFAULT_DB_NAME),
        "table": get("PRESET_DB_TABLE", DEFAULT_TABLE),
    }


class PresetStore(Protocol):
    """存储接口（测试注入内存实现，线上注入 :class:`MysqlPresetStore`）。"""

    def save(self, name: str, request: Any, *, overwrite: bool, note: str | None = None) -> dict[str, Any]: ...

    def load(self, name: str) -> dict[str, Any]: ...

    def list_all(self) -> list[dict[str, Any]]: ...

    def delete(self, name: str) -> None: ...

    def rename(self, old: str, new: str) -> dict[str, Any]: ...

    def exists(self, name: str) -> bool: ...


class MysqlPresetStore:
    """``screen_preset`` 表的读写。每次操作短连接 —— 条件是低频写入，不需要池。"""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self._config = config or db_config()
        self._ready = False

    # ------------------------------------------------------------ 连接
    @property
    def table(self) -> str:
        return str(self._config.get("table") or DEFAULT_TABLE)

    def _connect(self):
        try:
            import pymysql
            from pymysql.cursors import DictCursor
        except ImportError as exc:  # pragma: no cover - 依赖缺失才会走到
            raise StoreError("缺少 pymysql，无法连接条件库") from exc
        try:
            return pymysql.connect(
                host=self._config["host"],
                port=int(self._config.get("port") or 3306),
                user=self._config["user"],
                password=self._config["password"],
                database=self._config["database"],
                charset="utf8mb4",
                cursorclass=DictCursor,
                autocommit=True,
                connect_timeout=5,
                read_timeout=15,
                write_timeout=15,
            )
        except Exception as exc:  # pymysql 的异常类型随版本变化，统一包一层
            raise StoreError(f"连不上条件库：{exc}") from exc

    def ensure_schema(self) -> None:
        if self._ready:
            return
        with self._connect() as conn, conn.cursor() as cursor:
            cursor.execute(DDL.format(table=self.table))
        self._ready = True

    # ------------------------------------------------------------ 行映射
    @staticmethod
    def _row_to_record(row: dict[str, Any]) -> dict[str, Any]:
        request = row.get("request")
        if isinstance(request, (bytes, bytearray)):
            request = request.decode("utf-8")
        if isinstance(request, str):
            try:
                request = json.loads(request)
            except ValueError:
                request = None
        saved_at = row.get("saved_at")
        if isinstance(saved_at, datetime):
            saved_at = saved_at.isoformat(timespec="seconds")
        return {
            "name": row.get("name"),
            "saved_at": saved_at,
            "request": request,
            "scores": scores_from_name(str(row.get("name") or "")),
        }

    # ------------------------------------------------------------ CRUD
    def save(
        self,
        name: str,
        request: Any,
        *,
        overwrite: bool,
        note: str | None = None,
        saved_at: datetime | None = None,
    ) -> dict[str, Any]:
        self.ensure_schema()
        scores = scores_from_name(name)
        score1 = scores[0] if len(scores) > 0 else None
        score2 = scores[1] if len(scores) > 1 else None
        payload = json.dumps(request, ensure_ascii=False)
        now = datetime.now().replace(microsecond=0)
        # saved_at 只在迁移老文件时由调用方指定（保留原始保存时间）
        stamp = (saved_at or now).replace(microsecond=0)
        sql = (
            f"INSERT INTO {self.table} (name, request, note, score1, score2, saved_at, updated_at)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)"
        )
        if overwrite:
            sql += (
                " ON DUPLICATE KEY UPDATE request = VALUES(request), note = VALUES(note),"
                " score1 = VALUES(score1), score2 = VALUES(score2),"
                " saved_at = VALUES(saved_at), updated_at = VALUES(updated_at)"
            )
        try:
            with self._connect() as conn, conn.cursor() as cursor:
                cursor.execute(sql, (name, payload, note, score1, score2, stamp, now))
        except Exception as exc:
            if getattr(exc, "args", (None,))[0] == 1062:
                raise StoreExists(name) from exc
            raise StoreError(f"写入条件失败：{exc}") from exc
        return {
            "name": name,
            "saved_at": stamp.isoformat(timespec="seconds"),
            "request": request,
            "scores": scores,
        }

    def load(self, name: str) -> dict[str, Any]:
        self.ensure_schema()
        with self._connect() as conn, conn.cursor() as cursor:
            cursor.execute(
                f"SELECT name, request, saved_at FROM {self.table} WHERE name = %s", (name,)
            )
            row = cursor.fetchone()
        if not row:
            raise StoreNotFound(name)
        return self._row_to_record(row)

    def list_all(self) -> list[dict[str, Any]]:
        self.ensure_schema()
        with self._connect() as conn, conn.cursor() as cursor:
            cursor.execute(
                f"SELECT name, request, saved_at FROM {self.table}"
                " ORDER BY saved_at DESC, name DESC"
            )
            rows = cursor.fetchall() or []
        items = []
        for row in rows:
            record = self._row_to_record(row)
            if record["request"] is None:
                logger.debug("跳过没有 request 的条件 %s", record["name"])
                continue
            items.append(record)
        return items

    def delete(self, name: str) -> None:
        self.ensure_schema()
        with self._connect() as conn, conn.cursor() as cursor:
            affected = cursor.execute(f"DELETE FROM {self.table} WHERE name = %s", (name,))
        if not affected:
            raise StoreNotFound(name)

    def rename(self, old: str, new: str) -> dict[str, Any]:
        self.ensure_schema()
        scores = scores_from_name(new)
        score1 = scores[0] if len(scores) > 0 else None
        score2 = scores[1] if len(scores) > 1 else None
        now = datetime.now().replace(microsecond=0)
        try:
            with self._connect() as conn, conn.cursor() as cursor:
                affected = cursor.execute(
                    f"UPDATE {self.table} SET name = %s, score1 = %s, score2 = %s, updated_at = %s"
                    " WHERE name = %s",
                    (new, score1, score2, now, old),
                )
        except Exception as exc:
            if getattr(exc, "args", (None,))[0] == 1062:
                raise StoreExists(new) from exc
            raise StoreError(f"改名失败：{exc}") from exc
        if not affected:
            raise StoreNotFound(old)
        return self.load(new)

    def exists(self, name: str) -> bool:
        self.ensure_schema()
        with self._connect() as conn, conn.cursor() as cursor:
            cursor.execute(f"SELECT 1 FROM {self.table} WHERE name = %s LIMIT 1", (name,))
            return cursor.fetchone() is not None
