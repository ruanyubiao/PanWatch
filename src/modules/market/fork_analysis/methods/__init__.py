"""统计分析方法的注册表。

2026-10-24 起**只有一套方法**：``stat_v3``（条件适用面 + 评分）。用户的原话是
「三个统计方法，那几个是不需要的废弃的，可以删除了」——方法 1（收盘胜率按日等权）
和方法 2（最高价达成率）都不再出现在界面与创建接口里：

* 方法 2 的「窗口内摸到 X%」在 A 股高度饱和（0% 目标对条件组 97.7%、对随机 97.6%，
  差 0.08pp），判不出好坏，已废弃。
* 方法 1 的按日等权口径只回答「随便哪天买一篮子」，与「我照这个条件买一笔」不是
  同一个问题；它想回答的东西已由方法 3 的「按笔加权 + 按日聚类检验」覆盖。

两个旧模块文件保留，只为**老任务**还能打开看报告（``LEGACY_METHODS``）。新任务
一律用 ``stat_v3``，接口不再返回旧方法，界面也没有下拉了。
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from . import method3
from .contracts import SCHEMA_VERSION, MethodSpec, StandardReport

#: 可选方法（界面/接口只认这里面的）
_MODULES = (method3,)

#: 老任务兼容：这两个 id 还能渲染，但不能再被创建
LEGACY_METHODS: dict[str, Any] = {}
try:  # 旧模块被裁剪掉也不影响启动
    from . import method1 as _legacy_method1
    from . import method2 as _legacy_method2

    LEGACY_METHODS = {"stat_v1": _legacy_method1, "stat_v2": _legacy_method2}
except Exception:  # noqa: BLE001
    LEGACY_METHODS = {}

#: 老任务（2026-10-23 之前创建）的 meta 里没有 ``method`` 字段 → 按新方法算
DEFAULT_METHOD = method3.METHOD.id

_BY_ID: dict[str, Any] = {module.METHOD.id: module for module in _MODULES}
_ALL: dict[str, Any] = {**_BY_ID, **LEGACY_METHODS}


class UnknownMethod(ValueError):
    """请求里给了一个没注册的方法 id。"""


def list_specs() -> list[MethodSpec]:
    return [module.METHOD for module in _MODULES]


def specs_payload() -> list[dict[str, Any]]:
    return [{**module.METHOD.as_dict(), "schema_version": SCHEMA_VERSION,
             "default": module.METHOD.id == DEFAULT_METHOD}
            for module in _MODULES]


def normalize(method_id: Optional[str]) -> str:
    """空值 → 默认方法；已下线的旧方法直接拒绝（不静默换口径）。"""
    if not method_id:
        return DEFAULT_METHOD
    if method_id in _BY_ID:
        return method_id
    if method_id in LEGACY_METHODS:
        raise UnknownMethod("该方法已下线，请用「条件评估」（stat_v3）")
    raise UnknownMethod(f"未知的统计分析方法：{method_id}")


def spec(method_id: Optional[str]) -> MethodSpec:
    return _ALL[normalize(method_id)].METHOD


def module(method_id: Optional[str]) -> Any:
    return _ALL[normalize(method_id)]


def method_of(meta: dict[str, Any]) -> str:
    """任务属于哪个方法（老任务没有这个字段 → 默认）。老任务的 id 照样认。"""
    value = meta.get("method")
    return str(value) if value in _ALL else DEFAULT_METHOD


def build(method_id: Optional[str], conn: sqlite3.Connection, meta: dict[str, Any]) -> StandardReport:
    """按方法算统一报告。未知方法抛 :class:`UnknownMethod`。"""
    return module(method_id).build(conn, meta)
