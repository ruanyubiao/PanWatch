#!/usr/bin/env python3
"""给已保存条件补上评分后缀（用户 2026-11-05 第 1 条）。

名字里的分数从两处来：

* ``data/infer_runs/<run>/meta.json`` —— 条件推理轮次。``meta.preset`` 就是这一轮
  用的基础条件名，``meta.scores.train/test`` 是两段评分。
* ``data/analysis_runs/<preset>/<run>/meta.json`` —— 数据分析任务。只有一段
  （``meta.scores.train``），后缀只有一位数字。

后缀格式 ``_999_778`` / ``_716``（和 ``fork_infer.search._score_suffix`` 一致）。
已经带后缀的名字不会再补一次；没有分数的条件保持原样，只报告。

用法::

    python scripts/preset_scores.py            # 只看计划，不动文件
    python scripts/preset_scores.py --apply    # 真改名
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if os.environ.get("PANWATCH_ROOT"):
    ROOT = Path(os.environ["PANWATCH_ROOT"])
PRESET_DIR = ROOT / "data" / "screen_presets"
INFER_DIR = ROOT / "data" / "infer_runs"
ANALYSIS_DIR = ROOT / "data" / "analysis_runs"

#: 和 fork_infer.search.SCORE_SUFFIX_RE 保持一致（2–4 位数字，1–2 段）。
SCORE_SUFFIX_RE = re.compile(r"(?:_\d{2,4}){1,2}$")


def _read_json(path: Path) -> dict | None:
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _suffix(scores: dict) -> str:
    parts: list[str] = []
    for key in ("train", "test"):
        value = (scores.get(key) or {}).get("score")
        if value is None:
            continue
        try:
            parts.append(str(int(float(value) * 10)))
        except (TypeError, ValueError):
            continue
    return "_" + "_".join(parts) if parts else ""


def infer_scores() -> dict[str, tuple[dict, str]]:
    """preset 名 → (scores, run_id)。同一条件多轮时取 ``finished_at`` 最新的一轮。"""
    found: dict[str, tuple[dict, str, str]] = {}
    for meta_path in sorted(INFER_DIR.glob("*/meta.json")):
        meta = _read_json(meta_path)
        if not meta:
            continue
        preset = str(meta.get("preset") or "").strip()
        scores = meta.get("scores") or {}
        if not preset or not scores:
            continue
        stamp = str(meta.get("finished_at") or meta.get("created_at") or "")
        current = found.get(preset)
        if current is None or stamp > current[2]:
            found[preset] = (scores, meta_path.parent.name, stamp)
    return {name: (item[0], item[1]) for name, item in found.items()}


def analysis_scores() -> dict[str, tuple[dict, str]]:
    """preset 名 → (scores, run_id)，只取跑完且有分的那次。"""
    found: dict[str, tuple[dict, str, str]] = {}
    if not ANALYSIS_DIR.is_dir():
        return {}
    for preset_dir in sorted(ANALYSIS_DIR.iterdir()):
        if not preset_dir.is_dir():
            continue
        for meta_path in sorted(preset_dir.glob("*/meta.json")):
            meta = _read_json(meta_path)
            if not meta:
                continue
            scores = meta.get("scores") or {}
            if not scores:
                continue
            if str(meta.get("status")) not in ("done", "completed", "finished"):
                continue
            stamp = str(meta.get("finished_at") or meta.get("created_at") or "")
            name = preset_dir.name
            current = found.get(name)
            if current is None or stamp > current[2]:
                found[name] = (scores, meta_path.parent.name, stamp)
    return {name: (item[0], item[1]) for name, item in found.items()}


def plan() -> tuple[list[dict], list[dict]]:
    """返回 (要改名的, 没有分数的)。"""
    infer = infer_scores()
    analysis = analysis_scores()
    todo: list[dict] = []
    unknown: list[dict] = []
    taken = {path.stem for path in PRESET_DIR.glob("*.json")}
    for path in sorted(PRESET_DIR.glob("*.json")):
        old = path.stem
        if SCORE_SUFFIX_RE.search(old):
            continue
        source = "infer"
        scores, run_id = infer.get(old, ({}, ""))
        if not scores:
            source = "analysis"
            scores, run_id = analysis.get(old, ({}, ""))
        suffix = _suffix(scores)
        if not suffix:
            unknown.append({"name": old, "reason": "没有可用的评分记录"})
            continue
        new = f"{old}{suffix}"
        bump = 2
        while new in taken:
            new = f"{old}{suffix}_{bump}"
            bump += 1
        taken.add(new)
        todo.append({"old": old, "new": new, "source": source, "run_id": run_id,
                     "path": path})
    return todo, unknown


def apply(items: list[dict]) -> list[dict]:
    done: list[dict] = []
    for item in items:
        path: Path = item["path"]
        record = _read_json(path) or {}
        record["name"] = item["new"]
        temp = path.with_name(f".rename-{item['new']}.json")
        with temp.open("w", encoding="utf-8") as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp, PRESET_DIR / f"{item['new']}.json")
        path.unlink(missing_ok=True)
        done.append(item)
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description="给已保存条件补评分后缀")
    parser.add_argument("--apply", action="store_true", help="真改文件名（默认只看）")
    args = parser.parse_args()

    todo, unknown = plan()
    if not todo:
        print("没有需要改名的条件。")
    for item in todo:
        print(f"{item['old']} -> {item['new']}  ({item['source']} {item['run_id']})")
    if unknown:
        print(f"\n{len(unknown)} 个条件没有评分记录，保持原名：")
        for item in unknown:
            print(f"  {item['name']}")
    if args.apply and todo:
        done = apply(todo)
        print(f"\n已改名 {len(done)} 个。")
    elif todo:
        print(f"\n共 {len(todo)} 个待改名；加 --apply 执行。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
