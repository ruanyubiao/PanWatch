"""统计分析方法的注册表。

新增一个方法只需要两步：写 ``methods/methodN.py``（暴露 ``METHOD`` 与 ``build(conn, meta)``），
在下面的 ``_MODULES`` 里加一行。接口 ``GET /api/stocks/analysis/methods``、创建表单的
下拉、报告页的渲染都会自动带上它 —— 这是用户 2026-10-23 第 6 条「不同方法输入输出统一」
的落地点。

方法 id 一旦发布就不要改：任务 ``meta.json`` 里存的是 id，改了老任务的报告就找不到算法。
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from . import method1, method2
from .contracts import SCHEMA_VERSION, MethodSpec, StandardReport

#: 注册顺序 = 界面下拉顺序（方法 1 在前，它是既有任务的默认口径）
_MODULES = (method1, method2)

#: 老任务（2026-10-23 之前创建）的 meta 里没有 ``method`` 字段，一律当方法 1
DEFAULT_METHOD = method1.METHOD.id

_BY_ID: dict[str, Any] = {module.METHOD.id: module for module in _MODULES}


class UnknownMethod(ValueError):
    """请求里给了一个没注册的方法 id。"""


def list_specs() -> list[MethodSpec]:
    return [module.METHOD for module in _MODULES]


def specs_payload() -> list[dict[str, Any]]:
    return [{**module.METHOD.as_dict(), "schema_version": SCHEMA_VERSION, "default": module.METHOD.id == DEFAULT_METHOD}
            for module in _MODULES]


def normalize(method_id: Optional[str]) -> str:
    """空值/未知值 → 默认方法；未知值不静默降级（那会让用户以为跑的是新方法）。"""
    if not method_id:
        return DEFAULT_METHOD
    if method_id not in _BY_ID:
        raise UnknownMethod(f"未知的统计分析方法：{method_id}")
    return method_id


def spec(method_id: Optional[str]) -> MethodSpec:
    return _BY_ID[normalize(method_id)].METHOD


def module(method_id: Optional[str]) -> Any:
    return _BY_ID[normalize(method_id)]


def method_of(meta: dict[str, Any]) -> str:
    """任务属于哪个方法（老任务没有这个字段）。"""
    value = meta.get("method")
    return value if value in _BY_ID else DEFAULT_METHOD


def build(method_id: Optional[str], conn: sqlite3.Connection, meta: dict[str, Any]) -> StandardReport:
    """按方法算统一报告。未知方法抛 :class:`UnknownMethod`。"""
    return module(method_id).build(conn, meta)
