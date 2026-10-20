"""条件选股「已保存条件」的磁盘存储（用户反馈 2026-10-20 第 1 条）。

一个条件一个 JSON 文件，**文件名就是用户输入的名字**（≤10 字符），落在
``data/screen_presets/<名字>.json``。用文件而不是数据库，是因为用户明确要求
「名字就是文件名规则」—— 他在目录里看到的文件名，就是下拉菜单里列出来的名字。

文件名安全：
- 只拒绝会破坏路径或文件系统的字符（``/ \\ : * ? " < > |`` 与控制字符）；
- 拒绝以 ``.`` 开头（``..`` 之类）和 Windows 保留名（``CON`` / ``NUL`` …）；
- 长度按**字符**算（中文一个字算一个），上限 10。

写入是「临时文件 + ``os.replace``」：覆盖同名条件时，进程中途被杀也不会留下
半个 JSON 文件。目录里读不懂的文件（手改坏了）直接跳过并记一条 debug —— 一个
坏文件不该让整个下拉菜单打不开。
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: src/modules/market/fork_screen/presets.py → 仓库根
PROJECT_ROOT = Path(__file__).resolve().parents[4]
PRESET_DIR = PROJECT_ROOT / "data" / "screen_presets"

#: 名字长度上限（字符）。
NAME_MAX_LEN = 10

#: 文件名里不允许出现的字符（路径分隔符、Windows 保留字符、控制字符）。
_FORBIDDEN_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

#: Windows 保留设备名（大小写不敏感）。这些名字在 Windows 上建不出文件。
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

#: 单进程只跑一个 uvicorn worker（见 application.py），模块级锁足够。
_LOCK = threading.Lock()


class PresetError(Exception):
    """已保存条件的存储层错误基类。"""


class PresetNameInvalid(PresetError):
    """名字为空、超长或含有不能进文件名的字符。"""


class PresetExists(PresetError):
    """同名条件已存在，且调用方没有要求覆盖。"""


class PresetNotFound(PresetError):
    """条件不存在（或名字非法 —— 不会去猜）。"""


def normalize_name(raw: str) -> str:
    """校验并返回可以当文件名的名字。非法时抛 :class:`PresetNameInvalid`。"""
    name = (raw or "").strip()
    if not name:
        raise PresetNameInvalid("条件名称不能为空")
    if len(name) > NAME_MAX_LEN:
        raise PresetNameInvalid(f"条件名称最多 {NAME_MAX_LEN} 个字符")
    if _FORBIDDEN_CHARS.search(name):
        raise PresetNameInvalid('条件名称不能包含 / \\ : * ? " < > | 等字符')
    if name.startswith("."):
        raise PresetNameInvalid("条件名称不能以 . 开头")
    if name.endswith("."):
        raise PresetNameInvalid("条件名称不能以 . 结尾")
    if name.lower() in _RESERVED_NAMES:
        raise PresetNameInvalid("该名称是系统保留名，换一个")
    return name


def preset_path(name: str) -> Path:
    """名字 → 文件路径。名字会先过 :func:`normalize_name`（防目录穿越）。"""
    return PRESET_DIR / f"{normalize_name(name)}.json"


def _now_text() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _record(name: str, request: Any, saved_at: str | None = None) -> dict[str, Any]:
    return {"name": name, "saved_at": saved_at or _now_text(), "request": request}


def save(name: str, request: Any, *, overwrite: bool = False) -> dict[str, Any]:
    """保存一个条件。同名已存在时，``overwrite=False`` 抛 :class:`PresetExists`。"""
    safe = normalize_name(name)
    path = PRESET_DIR / f"{safe}.json"
    with _LOCK:
        if path.exists() and not overwrite:
            raise PresetExists(f"已存在同名的条件「{safe}」")
        PRESET_DIR.mkdir(parents=True, exist_ok=True)
        record = _record(safe, request)
        fd, temp_name = tempfile.mkstemp(dir=str(PRESET_DIR), prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp_name, path)
        except BaseException:
            # 失败时别把临时文件留在数据目录里
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
    logger.info("保存选股条件：%s", safe)
    return record


def load(name: str) -> dict[str, Any]:
    path = preset_path(name)
    if not path.is_file():
        raise PresetNotFound(f"条件「{name}」不存在")
    try:
        with path.open(encoding="utf-8") as handle:
            record = json.load(handle)
    except (OSError, ValueError) as exc:
        raise PresetNotFound(f"条件「{name}」读不出来：{exc}") from exc
    return _as_record(record, path.stem)


def _as_record(payload: Any, stem: str) -> dict[str, Any]:
    """把文件内容收敛成 ``{name, saved_at, request}``；文件名才是权威名字。"""
    if not isinstance(payload, dict):
        raise ValueError("条件文件不是 JSON 对象")
    return {
        "name": stem,
        "saved_at": payload.get("saved_at") if isinstance(payload.get("saved_at"), str) else None,
        "request": payload.get("request"),
    }


def list_all() -> list[dict[str, Any]]:
    """全部已保存条件，按保存时间倒序（最新的排在最前面）。"""
    if not PRESET_DIR.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for path in sorted(PRESET_DIR.glob("*.json")):
        try:
            with path.open(encoding="utf-8") as handle:
                record = _as_record(json.load(handle), path.stem)
        except (OSError, ValueError) as exc:
            logger.debug("跳过读不懂的条件文件 %s：%s", path.name, exc)
            continue
        if record["request"] is None:
            logger.debug("跳过没有 request 的条件文件 %s", path.name)
            continue
        items.append(record)
    items.sort(key=lambda item: (item.get("saved_at") or "", item["name"]), reverse=True)
    return items


def delete(name: str) -> None:
    path = preset_path(name)
    with _LOCK:
        if not path.is_file():
            raise PresetNotFound(f"条件「{name}」不存在")
        path.unlink()
    logger.info("删除选股条件：%s", name)
