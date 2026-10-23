"""统计分析方法：统一输入/输出契约。

为什么要有这一层
----------------
原来只有一套统计（口径 v4），公式、表名、接口字段都是为它量身定的。用户 2026-10-23
要求「新增一套统计方法，且不同方法的输入输出 API 与输出文档要统一」，于是把「方法」
抽成可注册的插件：

* 每个方法一个文件（``method1.py`` / ``method2.py``），只放**算法**，不碰 HTTP、不碰 UI。
* 方法的输入统一是「一个任务目录里的 signals 数据 + 任务 meta」，输出统一是
  :class:`StandardReport`（结论卡 + 若干表格 + 产物清单 + 数据质量 + 局限说明）。
* 前端只有一个渲染器读 ``StandardReport``，新增方法不需要再写一套界面。

字段命名约定
------------
* 率一律用**百分数**（45.2 表示 45.2%），差值用 ``pp`` 后缀（百分点），
  与既有报告一致 —— 混用「小数比率」和「百分数」是这类报表最常见的错。
* 每张表都带 ``columns`` 描述（``kind`` 决定前端格式化方式），前端不猜字段含义。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Optional

#: 统一输出的契约版本：字段增删要 +1（前端按它决定能不能渲染）
SCHEMA_VERSION = "1"


@dataclass(frozen=True)
class ParamSpec:
    """方法自己的参数（创建表单按它生成控件）。"""

    key: str
    label: str
    kind: str  # "int" | "bool" | "choice"
    default: Any
    hint: str = ""
    minimum: Optional[int] = None
    maximum: Optional[int] = None
    choices: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "kind": self.kind,
            "default": self.default,
            "hint": self.hint,
            "min": self.minimum,
            "max": self.maximum,
            "choices": list(self.choices),
        }


@dataclass(frozen=True)
class MethodSpec:
    """一个统计分析方法的静态说明（``/api/stocks/analysis/methods`` 直接返回它）。"""

    id: str
    name: str
    version: str
    summary: str
    #: 需要多少根前瞻 K 线（决定结束日上限与 Excel 列数）
    forward_days: int
    #: 统计窗口（天）；方法 1 由验证天数决定，这里给默认全集
    windows: tuple[int, ...]
    #: 涨幅目标（小数）；方法 1 不用
    targets: tuple[float, ...] = ()
    params: tuple[ParamSpec, ...] = ()
    #: 产物文件名（相对任务目录 artifacts/）
    outputs: tuple[str, ...] = ()
    #: 一句话口径说明，报告页顶部展示
    caliber: str = ""
    #: 建仓假设（回测是否扣成本、第几天买）
    entry: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "summary": self.summary,
            "forward_days": self.forward_days,
            "windows": list(self.windows),
            "targets": list(self.targets),
            "params": [param.as_dict() for param in self.params],
            "outputs": list(self.outputs),
            "caliber": self.caliber,
            "entry": self.entry,
        }


@dataclass
class Column:
    """表格列定义（前端按 ``kind`` 格式化，不猜含义）。"""

    key: str
    label: str
    kind: str = "text"  # text | int | number | percent | pp | money | bool
    hint: str = ""
    width: Optional[int] = None

    def as_dict(self) -> dict[str, Any]:
        return {"key": self.key, "label": self.label, "kind": self.kind,
                "hint": self.hint, "width": self.width}


@dataclass
class Table:
    key: str
    title: str
    columns: list[Column]
    rows: list[dict[str, Any]]
    hint: str = ""
    #: 只在这里标注的总行数（UI 截断时用）
    total_rows: Optional[int] = None
    #: 默认排序
    sort_key: Optional[str] = None
    sort_order: str = "desc"

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "title": self.title,
            "hint": self.hint,
            "columns": [column.as_dict() for column in self.columns],
            "rows": self.rows,
            "total_rows": self.total_rows if self.total_rows is not None else len(self.rows),
            "sort": {"key": self.sort_key, "order": self.sort_order} if self.sort_key else None,
        }


@dataclass
class Headline:
    """结论卡：一句话讲完「能不能用、最好几天、样本够不够」。"""

    verdict: str  # usable | worse | mixed | no_edge | insufficient | unrated
    title: str
    detail: str = ""
    metrics: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"verdict": self.verdict, "title": self.title,
                "detail": self.detail, "metrics": self.metrics}


@dataclass
class Artifact:
    """可下载产物。``url`` 由接口层填（它知道路由前缀）。"""

    name: str
    kind: str  # csv | md | xlsx | zip
    size: int = 0
    label: str = ""
    url: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "kind": self.kind, "size": self.size,
                "label": self.label or self.name, "url": self.url}


@dataclass
class StandardReport:
    """所有方法共用的输出信封。"""

    method: MethodSpec
    parameters: dict[str, Any]
    headline: Headline
    tables: list[Table]
    artifacts: list[Artifact] = field(default_factory=list)
    data_quality: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
    generated_at: str = ""
    schema_version: str = SCHEMA_VERSION

    def as_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "method": self.method.as_dict(),
            "parameters": self.parameters,
            "headline": self.headline.as_dict(),
            "tables": [table.as_dict() for table in self.tables],
            "artifacts": [artifact.as_dict() for artifact in self.artifacts],
            "data_quality": self.data_quality,
            "notes": list(self.notes),
            "generated_at": self.generated_at,
        }


#: 方法的执行入口签名：``(conn, meta) -> StandardReport``
Runner = Callable[[Any, dict[str, Any]], StandardReport]


def metric(key: str, label: str, value: Any, unit: str = "", hint: str = "") -> dict[str, Any]:
    """结论卡里的一项数字。"""
    return {"key": key, "label": label, "value": value, "unit": unit, "hint": hint}


def cap_rows(rows: Iterable[dict[str, Any]], limit: int) -> tuple[list[dict[str, Any]], int]:
    """表格进 UI 前截断（CSV 产物不截断）。返回 ``(rows, total)``。"""
    items = list(rows)
    return items[:limit], len(items)
