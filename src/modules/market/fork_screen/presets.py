"""条件选股「已保存条件」的存储入口。

2026-11-06 第 3 条：**存储从 JSON 文件改为 MySQL**（``panwatch.screen_preset``，
见 :mod:`preset_store`）。这个模块只保留两件事：

1. 名字的业务校验（仍要拦路径分隔符等 —— 条件名还会被拿去当
   ``data/analysis_runs/<条件名>/`` 的目录名，见 ``fork_analysis/store.py``）；
2. 把 ``save / load / list_all / delete / rename / exists`` 转给存储实现。

测试注入内存实现（``set_store``），线上用 :class:`preset_store.MysqlPresetStore`；
两边接口一致，所以调用方（``runner`` / ``search`` / ``ablation`` / 各 API）一行都不用改。
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Any

from . import preset_store
from .preset_store import PresetStore

logger = logging.getLogger(__name__)

#: 名字上限（字符）。2026-11-02 从 10 放开到 32：推理保存的条件要在名字里带两个评分
#: （``xg-999-778`` 就是 10 个字符），原来的 10 位放不下「基础名 + 评分」。
NAME_MAX_LEN = 32

#: 名字里不允许出现的字符。数据库列本身不怕这些，但条件名还是分析任务目录名，
#: 所以照旧拦（防止 ``..`` 之类跑出 data 目录）。
_FORBIDDEN_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')

#: Windows 保留设备名（大小写不敏感）。保留这条是为了兼容老条件名与导出文件。
_RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

_LOCK = threading.Lock()
_STORE: PresetStore | None = None


class PresetError(Exception):
    """已保存条件的存储层错误基类。"""


class PresetNameInvalid(PresetError):
    """名字为空、超长或含有不能用的字符。"""


class PresetExists(PresetError):
    """同名条件已存在，且调用方没有要求覆盖。"""


class PresetNotFound(PresetError):
    """条件不存在（或名字非法 —— 不会去猜）。"""


class PresetStorageError(PresetError):
    """条件库连不上 / SQL 失败。调用方按 5xx 处理，并带上原因。"""


def normalize_name(raw: str) -> str:
    """校验并返回合规的条件名。非法时抛 :class:`PresetNameInvalid`。"""
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


def get_store() -> PresetStore:
    """当前存储实现（默认惰性建 MySQL 连接参数，不在这里连库）。"""
    global _STORE
    if _STORE is None:
        with _LOCK:
            if _STORE is None:
                _STORE = preset_store.MysqlPresetStore()
    return _STORE


def set_store(store: PresetStore | None) -> None:
    """替换存储实现（测试用；传 None 恢复默认的 MySQL 实现）。"""
    global _STORE
    with _LOCK:
        _STORE = store


def _wrap(action: str):
    """把存储层错误翻成对外错误类型。"""

    def translate(exc: Exception) -> PresetError:
        if isinstance(exc, preset_store.StoreExists):
            return PresetExists(f"已存在同名的条件「{exc}」")
        if isinstance(exc, preset_store.StoreNotFound):
            return PresetNotFound(f"条件「{exc}」不存在")
        return PresetStorageError(f"{action}失败：{exc}")

    return translate


def scores_of(name: str) -> tuple[float, ...]:
    """名字后缀里的评分（``xg_999_778`` → ``(99.9, 77.8)``）。"""
    return preset_store.scores_from_name(name)


def save(
    name: str, request: Any, *, overwrite: bool = False, note: str | None = None
) -> dict[str, Any]:
    """保存一个条件。同名已存在时，``overwrite=False`` 抛 :class:`PresetExists`。"""
    safe = normalize_name(name)
    try:
        record = get_store().save(safe, request, overwrite=overwrite, note=note)
    except preset_store.StoreError as exc:
        raise _wrap("保存条件")(exc) from exc
    logger.info("保存选股条件：%s", safe)
    return record


def load(name: str) -> dict[str, Any]:
    safe = normalize_name(name)
    try:
        return get_store().load(safe)
    except preset_store.StoreError as exc:
        raise _wrap("读取条件")(exc) from exc


def list_all() -> list[dict[str, Any]]:
    try:
        return get_store().list_all()
    except preset_store.StoreError as exc:
        raise _wrap("读取条件列表")(exc) from exc


def delete(name: str) -> None:
    safe = normalize_name(name)
    try:
        get_store().delete(safe)
    except preset_store.StoreError as exc:
        raise _wrap("删除条件")(exc) from exc
    logger.info("删除选股条件：%s", safe)


def rename(old: str, new: str) -> dict[str, Any]:
    """改名（补评分后缀用它）。同名目标已存在时抛 :class:`PresetExists`。"""
    safe_old = normalize_name(old)
    safe_new = normalize_name(new)
    if safe_old == safe_new:
        return load(safe_old)
    try:
        record = get_store().rename(safe_old, safe_new)
    except preset_store.StoreError as exc:
        raise _wrap("条件改名")(exc) from exc
    logger.info("条件改名：%s → %s", safe_old, safe_new)
    return record


def exists(name: str) -> bool:
    try:
        return get_store().exists(normalize_name(name))
    except preset_store.StoreError as exc:
        raise _wrap("查询条件")(exc) from exc
