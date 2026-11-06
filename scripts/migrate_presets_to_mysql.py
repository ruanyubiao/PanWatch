#!/usr/bin/env python3
"""把 ``data/screen_presets/*.json`` 迁移进 MySQL（用户 2026-11-06 第 3 条）。

老版本一个条件一个 JSON 文件；存储改到 ``panwatch.screen_preset`` 之后，这些文件
不会自动出现，必须迁一次。脚本是幂等的：同名已存在就覆盖（``overwrite=True``），
所以中断后可以重跑，不会产生重复行。原始 ``saved_at`` 会被保留，列表顺序不变。

用法::

    python3 scripts/migrate_presets_to_mysql.py            # 只看计划
    python3 scripts/migrate_presets_to_mysql.py --apply    # 真正写库

迁移完文件**不删**（``data/screen_presets/`` 留作回滚副本），代码已不再读它。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if os.environ.get("PANWATCH_ROOT"):
    ROOT = Path(os.environ["PANWATCH_ROOT"])
sys.path.insert(0, str(ROOT))

from src.modules.market.fork_screen import preset_store  # noqa: E402

PRESET_DIR = ROOT / "data" / "screen_presets"


def parse_saved_at(raw) -> datetime | None:
    if not isinstance(raw, str) or not raw:
        return None
    try:
        return datetime.fromisoformat(raw).replace(tzinfo=None, microsecond=0)
    except ValueError:
        return None


def iter_files() -> list[Path]:
    if not PRESET_DIR.is_dir():
        return []
    return sorted(PRESET_DIR.glob("*.json"))


def main() -> int:
    parser = argparse.ArgumentParser(description="把已保存条件从 JSON 文件迁到 MySQL")
    parser.add_argument("--apply", action="store_true", help="真正写库（默认只打印计划）")
    args = parser.parse_args()

    files = iter_files()
    print(f"条件目录：{PRESET_DIR}")
    print(f"文件数：{len(files)}")

    rows: list[dict] = []
    broken: list[tuple[str, str]] = []
    for path in files:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            broken.append((path.name, str(exc)))
            continue
        if not isinstance(payload, dict) or not isinstance(payload.get("request"), dict):
            broken.append((path.name, "没有 request"))
            continue
        rows.append(
            {
                "name": path.stem,
                "request": payload["request"],
                "note": payload.get("note"),
                "saved_at": parse_saved_at(payload.get("saved_at")),
                "scores": preset_store.scores_from_name(path.stem),
            }
        )

    for row in rows:
        score_text = " ".join(f"{value:g}" for value in row["scores"]) or "-"
        print(f"  {row['name']:<32} 分数 {score_text:<12} 保存于 {row['saved_at'] or '-'}")
    for name, reason in broken:
        print(f"  跳过 {name}：{reason}")

    if not args.apply:
        print("\n只看了计划。加 --apply 才写库。")
        return 0

    store = preset_store.MysqlPresetStore()
    store.ensure_schema()
    written = 0
    for row in rows:
        store.save(
            row["name"],
            row["request"],
            overwrite=True,
            note=row["note"],
            saved_at=row["saved_at"],
        )
        written += 1
    print(f"\n已写入 {written} 条；跳过 {len(broken)} 条。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
