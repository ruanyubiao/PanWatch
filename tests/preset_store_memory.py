"""测试用的内存版条件库（替代真实 MySQL）。

``tests/conftest.py`` 里有一个 autouse fixture 把 ``presets`` 的存储换成它，所以
单测永远不会去连 MySQL —— 也避免「本机没配库」把一批用例搞成 skipped。

行为要和 :class:`preset_store.MysqlPresetStore` 对齐：同名冲突、改名冲突、
按保存时间倒序、评分后缀解析，都照同一套规则。
"""

from __future__ import annotations

import copy
from datetime import datetime
from typing import Any

from src.modules.market.fork_screen import preset_store


class MemoryPresetStore:
    """进程内字典实现，接口与 ``MysqlPresetStore`` 一致。"""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        #: 每次 save/rename 递增，用来断言「保存时间会变新」
        self.tick = 0
        #: 置 True 后在调用时报 StoreError（测存储不可用的分支）
        self.broken = False

    # ------------------------------------------------------------------ 内部
    def _check(self) -> None:
        if self.broken:
            raise preset_store.StoreError("条件库不可用（测试注入）")

    def _stamp(self) -> str:
        self.tick += 1
        # 用递增的序号伪造时间，保证「后保存的更新」
        return f"2026-11-06T10:{self.tick // 60:02d}:{self.tick % 60:02d}"

    # ------------------------------------------------------------------ 接口
    def save(
        self,
        name: str,
        request: Any,
        *,
        overwrite: bool,
        note: str | None = None,
        saved_at: datetime | None = None,
    ) -> dict[str, Any]:
        self._check()
        if name in self.rows and not overwrite:
            raise preset_store.StoreExists(name)
        record = {
            "name": name,
            "saved_at": saved_at.isoformat(timespec="seconds") if saved_at else self._stamp(),
            "request": copy.deepcopy(request),
            "note": note,
        }
        self.rows[name] = record
        return self._public(record)

    def load(self, name: str) -> dict[str, Any]:
        self._check()
        if name not in self.rows:
            raise preset_store.StoreNotFound(name)
        return self._public(self.rows[name])

    def list_all(self) -> list[dict[str, Any]]:
        self._check()
        items = [self._public(row) for row in self.rows.values()]
        items.sort(key=lambda item: (item.get("saved_at") or "", item["name"]), reverse=True)
        return items

    def delete(self, name: str) -> None:
        self._check()
        if name not in self.rows:
            raise preset_store.StoreNotFound(name)
        del self.rows[name]

    def rename(self, old: str, new: str) -> dict[str, Any]:
        self._check()
        if old not in self.rows:
            raise preset_store.StoreNotFound(old)
        if new != old and new in self.rows:
            raise preset_store.StoreExists(new)
        record = self.rows.pop(old)
        record["name"] = new
        record["saved_at"] = self._stamp()
        self.rows[new] = record
        return self._public(record)

    def exists(self, name: str) -> bool:
        self._check()
        return name in self.rows

    # ------------------------------------------------------------------ 辅助
    @staticmethod
    def _public(record: dict[str, Any]) -> dict[str, Any]:
        return {
            "name": record["name"],
            "saved_at": record["saved_at"],
            "request": copy.deepcopy(record["request"]),
            "scores": preset_store.scores_from_name(record["name"]),
        }
