#!/usr/bin/env python3
"""条件推理的常驻调度器：让云服务器 24 小时不停地「找条件」。

职责边界
--------
* ``tick``     —— 一次调度决策（cron 每 5 分钟调一次）：没任务就开一个；
                  卡死超过阈值就停掉再开；顺手把磁盘清一清。
* ``doctor``   —— 打印健康快照（本机 cron / 本地 Hermes 巡检都读它）。
* ``plan``     —— 只打印「下一次会开什么」，不创建（排错用）。
* ``prune``    —— 只清磁盘。
* ``install-cron`` —— 把本调度器自己的 cron 装上（幂等）。

两种起点交替（用户 2026-10-25 第 3 条）
--------------------------------------
* ``refine``  —— 从历史评分最好的一轮里取它第 1 名的条件，加一个「它还没有的」
                 补充条件当新的基础条件。这是「在好条件的基础上再次修改」。
* ``explore`` —— 从预设计种子条件里轮换取一个（含「等价无条件」的基准种子），
                 这是「从没有任何条件的基础上重新开始找」。

每 3 次里 2 次 refine、1 次 explore；还没有任何评分时全部 explore。

为什么不用 agent 做这件事
------------------------
一次 tick 的判断完全是确定性的（看状态、看分数、写文件），交给模型每小时
判断一次既慢又贵，而且模型看不到磁盘和线程。这里全用脚本，零 token。
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

API = "http://127.0.0.1:8000"
ROOT = "/opt/PanWatch"
DATA_DIR = os.path.join(ROOT, "data", "infer_runs")
ANALYSIS_DIR = os.path.join(ROOT, "data", "analysis_runs")
PRESET_DIR = os.path.join(ROOT, "data", "screen_presets")
STATE_FILE = os.path.join(DATA_DIR, ".scheduler.json")
LOG_FILE = os.path.join(DATA_DIR, "scheduler.log")
CRED_FILE = os.path.join(ROOT, "data", ".agent_api.json")
LOCK_FILE = "/tmp/infer_scheduler.lock"

#: 搜索区间（用户定的两段数据集）
TRAIN_START = "2024-01-01"
TRAIN_END = "2025-12-31"
VALID_START = "2026-01-01"
ITERATIONS = 1000
METHOD = "stat_v3"

#: 两段都 >= 60 算「能用的条件」，自动保存并优先围绕它继续优化
PASS_SCORE = 60.0
#: 单段 >= 这个分也值得保存（供人工复核），避免好条件被丢掉
SAVE_SCORE = 58.0
#: 云端硬性卡死阈值（软的 40 分钟由本地巡检负责，这里只兜底）
HARD_STALL_SEC = 2 * 3600
#: 24 小时最多开几次（一次约 5 小时；上限是防死循环把机器跑满）
MAX_STARTS_PER_DAY = 6
#: 磁盘下限
MIN_FREE_GB = 3.0
#: 保留最近多少轮推理（其余只裁 results.jsonl，历史记录不删 —— 见 prune）
KEEP_RUNS = 20
#: 基础条件体检用的统计窗口（与默认选股窗口一致）
SCREEN_DAYS = 250
#: 分析任务目录保留天数 / 最少份数
KEEP_ANALYSIS_DAYS = 21
KEEP_ANALYSIS_MIN = 5

#: 注意：**不要**在外面再包一层 flock —— 脚本自己用 /tmp/infer_scheduler.lock 做单实例锁，
#: 外面再锁一次会让 cron 先拿到锁、脚本内部的 flock -n 必然失败，于是每次都静默 exit 0，
#: 表现为「cron 装了但任务永远不启动」（2026-10-25 踩过）。
CRON_LINE = "*/5 * * * * {py} {script} tick >> {log} 2>&1"


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _login() -> str:
    with open(CRED_FILE, "r", encoding="utf-8") as fh:
        cred = json.load(fh)
    req = urllib.request.Request(
        API + "/api/auth/login",
        data=json.dumps(cred).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)["data"]["token"]


def _get(path: str, token: str) -> Any:
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)["data"]


def _post(path: str, payload: dict[str, Any], token: str, timeout: int = 60) -> Any:
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)["data"]


def _post_empty(path: str, token: str) -> Any:
    req = urllib.request.Request(
        API + path, data=b"", headers={"Authorization": f"Bearer {token}"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)["data"]


# --------------------------------------------------------------------------- #
# 状态 / 日志
# --------------------------------------------------------------------------- #
def _load_state() -> dict[str, Any]:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_state(state: dict[str, Any]) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_FILE)


def _log(line: str) -> None:
    """追加一行日志；超过 1MB 只留最后 300 行。长期跑不能无限涨。"""
    try:
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 1_000_000:
            with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as fh:
                tail = fh.readlines()[-300:]
            with open(LOG_FILE, "w", encoding="utf-8") as fh:
                fh.writelines(tail)
    except OSError:
        pass
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    # 日志写不进去（目录被清、盘满、权限）不能把整轮 tick 干掉：
    # 这条路径在 cron 里跑，抛异常等于调度器静默停摆。
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(f"{stamp} {line}\n")
    except OSError:
        pass


# --------------------------------------------------------------------------- #
# 确定性小工具
# --------------------------------------------------------------------------- #
def _cond(name: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"type": "condition", "id": str(uuid.uuid4()), "name": name, "params": params}


def _rule(*conds: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "group",
        "id": str(uuid.uuid4()),
        "operator": "AND",
        "children": list(conds),
    }


def _flatten(node: Any) -> list[dict[str, Any]]:
    """把规则树摊平成条件列表（用于「这条条件里已经有什么」）。"""
    out: list[dict[str, Any]] = []
    if isinstance(node, dict):
        if node.get("type") == "condition":
            out.append({"name": node.get("name"), "params": dict(node.get("params") or {})})
        for child in node.get("children") or []:
            out.extend(_flatten(child))
    return out


def _preset_name(prefix: str, state: dict[str, Any]) -> str:
    """已保存条件的名字上限 10 个字符，所以用「前缀+月日时分」。"""
    stamp = datetime.now().strftime("%m%d%H%M")
    base = f"{prefix}{stamp}"
    name, i = base, 1
    while os.path.exists(os.path.join(PRESET_DIR, f"{name}.json")):
        name = f"{prefix}{stamp}"[:9] + str(i % 10)
        i += 1
    return name[:10]


def _write_preset(name: str, rule: dict[str, Any], note: str) -> str:
    os.makedirs(PRESET_DIR, exist_ok=True)
    record = {
        "name": name,
        "saved_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "note": note,
        "request": {
            "trading_days": 30,
            "markets": ["sh", "sz", "cyb", "kcb"],
            "include_st": True,
            "market_cap": None,
            "rule": rule,
            "asof": None,
        },
    }
    path = os.path.join(PRESET_DIR, name + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)
    return name


# --------------------------------------------------------------------------- #
# 预设计种子条件（「从零开始」的起点）
# --------------------------------------------------------------------------- #
#: 每一条都是「一个完整选股思路」，不含额外量价过滤 —— 过滤交给搜索去加。
#: 顺序即轮换顺序；第 0 条等价于「无基础条件」。
SEEDS: tuple[tuple[str, dict[str, Any], str], ...] = (
    ("e0", _rule(_cond("more_bullish_candles", {"n": 1, "m": 0})),
     "基准：1 日内阳线多于阴线（等价无条件起点）"),
    ("e1", _rule(_cond("new_high", {"m": 20, "n": 1}),
                 _cond("vol_ratio_single", {"n": 1, "min": 1.5, "max": 5.0, "window": 5})),
     "放量突破 20 日新高"),
    ("e2", _rule(_cond("ma_bullish", {"periods": [5, 10, 20], "n": 1, "m": 1}),
                 _cond("change_pct", {"n": 1, "min": -2.0, "max": 2.0}),
                 _cond("close_above_ma", {"period": 20, "n": 1, "m": 1})),
     "多头排列里回踩不破（当日振幅 ±2%）"),
    ("e3", _rule(_cond("vol_ratio_single", {"n": 1, "min": 0.0, "max": 0.8, "window": 5}),
                 _cond("change_pct", {"n": 1, "min": -3.0, "max": 1.0})),
     "缩量整理（量比 <0.8 且当日不大跌）"),
    ("e4", _rule(_cond("vol_ratio_consecutive",
                       {"start": 1, "days": 2, "min": 1.2, "max": 10.0, "window": 5}),
                 _cond("change_pct", {"n": 1, "min": 2.0, "max": 9.9})),
     "连续两日放量上攻"),
    ("e5", _rule(_cond("market_cap", {"op": "lte", "value": 50.0, "n": 1}),
                 _cond("turnover_single", {"n": 1, "min": 3.0, "max": 15.0})),
     "小市值（≤50 亿）活跃股"),
    ("e6", _rule(_cond("consecutive_falling", {"start": 1, "days": 2}),
                 _cond("close_above_ma", {"period": 5, "n": 1, "m": 1})),
     "连跌两日后收复 5 日线（反转）"),
    ("e7", _rule(_cond("close_above_ma", {"period": 60, "n": 1, "m": 1}),
                 _cond("ma_bullish", {"periods": [10, 20, 60], "n": 1, "m": 1})),
     "中期趋势（站上 60 日线且均线多头）"),
    ("e8", _rule(_cond("turnover_single", {"n": 1, "min": 0.0, "max": 1.0}),
                 _cond("amount_single", {"n": 1, "min": 0.5, "max": 2.0})),
     "极度冷门（换手 <1%、成交额 0.5~2 亿）"),
)

#: 基础条件最多叠多少条（再多就改成拆条件）
MAX_BASE_LEAVES = 8
#: refine 时给「已有条件」补的那一条（轮换）。只挑经济含义明确、且不与常见条件冲突的。
HINTS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("close_above_ma", {"period": 20, "n": 1, "m": 1}),
    ("change_pct", {"n": 1, "min": 2.0, "max": 9.9}),
    ("turnover_single", {"n": 1, "min": 0.0, "max": 5.0}),
    ("vol_ratio_single", {"n": 1, "min": 1.2, "max": 3.0, "window": 5}),
    ("ma_bullish", {"periods": [5, 10], "n": 1, "m": 1}),
    ("amount_single", {"n": 1, "min": 2.0, "max": 100.0}),
    ("new_high", {"m": 10, "n": 1}),
    ("consecutive_rising", {"start": 1, "days": 2}),
)


# --------------------------------------------------------------------------- #
# 任务视图
# --------------------------------------------------------------------------- #
def _score(item: dict[str, Any]) -> tuple[Optional[float], Optional[float]]:
    return item.get("score_train"), item.get("score_test")


def _combined(item: dict[str, Any]) -> Optional[float]:
    """综合分：两段取较小值 —— 只有一段好的条件不算好（训练/测试集的基本纪律）。"""
    tr, te = _score(item)
    if tr is None or te is None:
        return None
    return min(float(tr), float(te))


def _latest(runs: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    return runs[0] if runs else None


def _alive(item: Optional[dict[str, Any]]) -> bool:
    return bool(item and item.get("alive") and str(item.get("status")) in ("running", "pending"))


def _progress_age(item: dict[str, Any]) -> Optional[float]:
    """这条任务多久没有写入进展（秒）。

    meta.json 每推进一个变体就被重写，所以它的 mtime 就是「最后一次进展」——
    比 API 里的 elapsed_s 更可靠（elapsed_s 在 loading 阶段也会涨，看起来像在动）。
    """
    run_id = str(item.get("run_id") or "")
    if not run_id:
        return None
    path = os.path.join(DATA_DIR, run_id, "meta.json")
    try:
        return max(0.0, time.time() - os.path.getmtime(path))
    except OSError:
        return None


# --------------------------------------------------------------------------- #
# plan：决定下一次开什么
# --------------------------------------------------------------------------- #
def _best_run(runs: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    scored = [(r, _combined(r)) for r in runs]
    scored = [(r, s) for r, s in scored if s is not None]
    if not scored:
        return None
    scored.sort(key=lambda pair: pair[1], reverse=True)
    return scored[0][0]


def _finished(runs: list[dict[str, Any]], need_score: bool = True) -> list[dict[str, Any]]:
    out = []
    for item in runs:
        if _alive(item):
            continue
        if str(item.get("status")) not in ("done", "interrupted", "error", "stopped"):
            continue
        if need_score and _combined(item) is None:
            continue
        out.append(item)
    return out


def _refine_rule(best: dict[str, Any], state: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """取最好的一轮的第 1 名条件，再补一个它还没有的补充条件。"""
    run_id = str(best.get("run_id"))
    path = os.path.join(DATA_DIR, run_id, "finalists.json")
    rule: Optional[dict[str, Any]] = None
    desc = ""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        if rows:
            rule = (rows[0] or {}).get("rule")
            desc = str((rows[0] or {}).get("desc") or "")
    except (OSError, json.JSONDecodeError):
        rule = None
    if not isinstance(rule, dict):
        # 没有 finalists（老任务/被清理），退回这一轮的基础条件
        rule = (best.get("base_rule") or {}) if isinstance(best.get("base_rule"), dict) else None
        desc = str(best.get("base_summary") or "")
    if not isinstance(rule, dict) or not rule:
        seed_name, seed_rule, seed_desc = SEEDS[0]
        return seed_rule, f"退回种子 {seed_name}（{seed_desc}）"

    have = {c.get("name") for c in _flatten(rule)}
    # 已经叠了 8 条以上就别再加了：refine 一路加条件会把基础条件压到「选不出股票」，
    # 2026-11-02 的空跑轮次（0 次评估）就是这么来的。这时改成「拆一条」，让搜索空间重新打开。
    leaves = _flatten(rule)
    if len(leaves) >= MAX_BASE_LEAVES and isinstance(rule.get("children"), list):
        kept_children = rule["children"][:-1]
        if kept_children:
            opened = {**rule, "children": kept_children}
            removed_name = str((leaves[-1] or {}).get("name") or "")
            return opened, f"拆开 {run_id} 的第 1 名：去掉 {removed_name}（条件已过窄）"
    idx = int(state.get("hint_index") or 0)
    picked: Optional[tuple[str, dict[str, Any]]] = None
    for step in range(len(HINTS)):
        cand = HINTS[(idx + step) % len(HINTS)]
        if cand[0] not in have:
            picked = cand
            state["hint_index"] = (idx + step + 1) % len(HINTS)
            break
    if picked is None:
        return rule, f"沿用 {run_id} 的第 1 名：{desc}（没有可补的条件了）"

    new_rule = {
        "type": "group",
        "id": str(uuid.uuid4()),
        "operator": "AND",
        "children": [rule, _cond(picked[0], picked[1])],
    }
    return new_rule, f"改良 {run_id} 的第 1 名（{desc}）＋ {picked[0]}"


def build_plan(runs: list[dict[str, Any]], state: dict[str, Any]) -> dict[str, Any]:
    """返回 {mode, preset_rule, preset_note, seed, log}。不写文件、不调接口。"""
    starts = int(state.get("total_starts") or 0)
    best = _best_run(runs)
    best_score = _combined(best) if best else None

    # 已有及格条件 → 一直围绕它改良（仍在跑，不会让机器闲着）
    force_refine = bool(best_score is not None and best_score >= PASS_SCORE)
    mode = "refine" if force_refine else ("explore" if (best is None or starts % 3 == 2) else "refine")

    if mode == "refine" and best is not None:
        rule, note = _refine_rule(best, state)
    else:
        mode = "explore"
        idx = int(state.get("seed_index") or 0) % len(SEEDS)
        name, rule, seed_desc = SEEDS[idx]
        state["seed_index"] = (idx + 1) % len(SEEDS)
        note = f"种子 {name}：{seed_desc}"

    seed_value = int(state.get("next_seed") or 20260101)
    return {
        "mode": mode,
        "rule": rule,
        "note": note,
        "seed": seed_value,
        "best": {"run_id": (best or {}).get("run_id"), "score": best_score},
    }


# --------------------------------------------------------------------------- #
# 启动 / 停止
# --------------------------------------------------------------------------- #
def _starts_today(state: dict[str, Any], runs: Optional[list[dict[str, Any]]] = None) -> int:
    """24 小时内已经启动了多少轮。

    **空跑的失败轮不计入预算**（2026-11-02）：基础条件过窄的轮次几秒钟就
    ``failed``，但它们照样吃掉 6 个名额，结果 13:40 之后整台机器空转，
    与「不能让服务器闲着」直接冲突。失败轮只消耗分钟级时间，不该占预算。
    """
    cutoff = time.time() - 86400
    status_of = {str(item.get("run_id")): str(item.get("status") or "")
                 for item in (runs or [])}
    count = 0
    for item in (state.get("starts") or []):
        if float(item.get("ts") or 0) < cutoff:
            continue
        run_id = str(item.get("run_id") or "")
        if run_id and status_of.get(run_id) == "failed":
            continue
        count += 1
    return count


def _free_gb() -> float:
    return shutil.disk_usage("/").free / 1024 ** 3


def _base_signal_count(token: str, rule: dict[str, Any]) -> Optional[int]:
    """这个基础条件今天能选出多少只股票（0 = 条件过窄，跑下去只会空转）。

    2026-11-02 的 0 评估空跑（r11020315）就是基础条件被 refine 叠到没有信号，
    搜索 2 分 49 秒后 done=0、没评分。开任务前花 3 秒验一次，比白占 5 小时便宜。
    """
    # 口径必须和真正跑的那一轮一致：``_write_preset`` 写进去的是 trading_days=30 +
    # include_st=True。2026-11-04 之前这里用的是 250 天 + 不含 ST，
    # 体检通过不代表真跑有信号（反之会白白退回种子）。
    payload = {"trading_days": 30, "markets": ["sh", "sz", "cyb", "kcb"],
               "include_st": True, "rule": rule}
    try:
        # W=250 的选股本身就要 8 秒；有推理轮在跑时实测 61 秒（同一进程里抢 GIL + 内存压紧），
        # 所以超时给 180 秒。60 秒会让体检长期「skipped」，等于没有体检。
        data = _post("/api/stocks/screen", payload, token, timeout=180)
    except Exception as exc:  # noqa: BLE001 - 验不了就放行，由任务自己报错
        _log(f"base check skipped {type(exc).__name__}: {exc}")
        return None
    try:
        return int(data.get("total") or 0)
    except (TypeError, ValueError):
        return None


def start_new(token: str, runs: list[dict[str, Any]], state: dict[str, Any],
              dry: bool = False, force: bool = False) -> str:
    plan = build_plan(runs, state)
    # 先判「这一轮到底要不要开」，再花 60 秒去体检基础条件。
    # 顺序颠倒的后果（2026-11-02 实测）：有轮次在跑时每 5 分钟白打一次 W=250 的选股
    # （有推理线程时 61 秒 > 60 秒超时），日志里连续刷 "base check skipped TimeoutError"。
    if not dry and not force:
        if _alive(_latest(runs)):
            return "busy"
        if _free_gb() < MIN_FREE_GB:
            _log(f"skip start: free={_free_gb():.1f}G < {MIN_FREE_GB}G")
            return "low_disk"
        if _starts_today(state, runs) >= MAX_STARTS_PER_DAY:
            _log("skip start: 24h 内已达启动上限")
            return "rate_limited"
    # 开任务前先体检基础条件：0 只股票 = 抽样窗口里所有变体都会失败（空跑）。
    # 退回预设种子，最多换 3 次；都不行就这轮跳过，等下一个 tick。
    if not dry:
        count = _base_signal_count(token, plan["rule"])
        swaps = 0
        while count == 0 and swaps < 3:
            idx = int(state.get("seed_index") or 0) % len(SEEDS)
            seed_name, seed_rule, seed_desc = SEEDS[idx]
            state["seed_index"] = (idx + 1) % len(SEEDS)
            plan = {"mode": "explore", "rule": seed_rule,
                    "note": f"种子 {seed_name}：{seed_desc}（原基础条件无信号，已退回）",
                    "seed": plan.get("seed"), "best": None}
            count = _base_signal_count(token, seed_rule)
            swaps += 1
        if count == 0:
            _log("skip start: 基础条件与种子都选不出股票")
            return "base_empty"
        if swaps:
            _log(f"base check: 换种子 {swaps} 次后可用（{count} 只）")
    name = _preset_name("r" if plan["mode"] == "refine" else "e", state)
    payload = {
        "preset": name,
        "method": METHOD,
        "train_start": TRAIN_START,
        "train_end": TRAIN_END,
        "valid_start": VALID_START,
        "valid_end": None,
        "iterations": ITERATIONS,
        "seed": plan["seed"],
    }
    if dry:
        print(json.dumps({"preset": name, "mode": plan["mode"], "note": plan["note"],
                          "best": plan["best"], "payload": payload},
                         ensure_ascii=False, indent=1))
        return "dry"

    if _alive(_latest(runs)) and not force:
        return "busy"
    if _free_gb() < MIN_FREE_GB:
        _log(f"skip start: free={_free_gb():.1f}G < {MIN_FREE_GB}G")
        return "low_disk"
    if _starts_today(state, runs) >= MAX_STARTS_PER_DAY and not force:
        _log("skip start: 24h 内已达启动上限")
        return "rate_limited"

    _write_preset(name, plan["rule"], plan["note"])
    try:
        created = _post("/api/stocks/infer/runs", payload, token)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        _log(f"start FAILED http={exc.code} {detail} preset={name} note={plan['note']}")
        return f"failed:{exc.code}"
    except Exception as exc:  # noqa: BLE001
        _log(f"start FAILED {type(exc).__name__}: {exc} preset={name}")
        return "failed"

    run_id = str((created.get("item") or {}).get("run_id") or "")
    state["total_starts"] = int(state.get("total_starts") or 0) + 1
    state["next_seed"] = int(plan["seed"]) + 7919
    state["run_id"] = run_id
    state["done"] = 0
    state["ts"] = time.time()
    state.setdefault("starts", []).append({
        "ts": time.time(), "run_id": run_id, "preset": name,
        "mode": plan["mode"], "seed": plan["seed"], "note": plan["note"],
    })
    state["starts"] = state["starts"][-60:]
    _save_state(state)
    _log(f"start OK run={run_id} preset={name} mode={plan['mode']} seed={plan['seed']} | {plan['note']}")
    print(f"已创建 {run_id}（{plan['mode']} · {name}）{plan['note']}")
    return "started"


def _worker_pid(run_id: str) -> Optional[int]:
    try:
        with open(os.path.join(DATA_DIR, run_id, "worker.pid"), "r", encoding="utf-8") as fh:
            return int(fh.read().strip())
    except (OSError, ValueError):
        return None


def _force_kill(run_id: str, wait_s: float = 8.0) -> bool:
    """推理跑在独立进程里（2026-11-03），所以「停止」不能只写个标记文件。

    主循环每跑完一个变体才看一次停止标记（几十秒），正常情况下这就够了；
    但如果工作进程卡在数据库查询里，它永远不会去看标记 —— 那时只能发信号。
    先 TERM（工作进程会把它转成「停止」标记再退出），等 ``wait_s`` 秒还在就 KILL。
    """
    pid = _worker_pid(run_id)
    if not pid:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    deadline = time.time() + wait_s
    while time.time() < deadline:
        time.sleep(0.5)
        try:
            os.kill(pid, 0)
        except OSError:
            return True
    try:
        os.kill(pid, signal.SIGKILL)
        _log(f"worker KILL run={run_id} pid={pid}（TERM 后 {wait_s}s 没有退出）")
    except OSError:
        pass
    return True


def _alive_pid(run_id: str) -> bool:
    pid = _worker_pid(run_id)
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def stop_run(token: str, run_id: str, grace_s: float = 45.0) -> bool:
    """停止一轮：先请它自己收工（写标记），等 ``grace_s`` 秒还在就强制收掉。

    为什么要等而不是直接 kill：正常路径下工作进程会在当前变体跑完后自己退出，
    状态、结果、Excel 都能写完整。只有卡死（例如数据库查询不返回）才需要信号，
    而那种情况下它永远占着单任务槽 —— 用户看到的现象就是「机器闲着但建不了新任务」。
    """
    try:
        _post_empty(f"/api/stocks/infer/runs/{run_id}/stop", token)
        _log(f"stop OK run={run_id}")
    except Exception as exc:  # noqa: BLE001
        _log(f"stop FAILED run={run_id} {type(exc).__name__}: {exc}")
        return _force_kill(run_id)
    deadline = time.time() + grace_s
    while time.time() < deadline:
        if not _alive_pid(run_id):
            return True
        time.sleep(1.0)
    _log(f"worker 超过 {int(grace_s)}s 没退出，强制收掉 run={run_id}")
    return _force_kill(run_id)


# --------------------------------------------------------------------------- #
# 自动保存 / 清理
# --------------------------------------------------------------------------- #
def _best_variant_index(run_id: str) -> Optional[int]:
    """这一轮「第 1 名」在 results.jsonl 里的序号（/save 接口按序号存）"""
    base = os.path.join(DATA_DIR, run_id)
    desc = ""
    try:
        with open(os.path.join(base, "finalists.json"), "r", encoding="utf-8") as fh:
            rows = json.load(fh)
        if rows:
            desc = str((rows[0] or {}).get("desc") or "")
    except (OSError, json.JSONDecodeError):
        pass
    best_index: Optional[int] = None
    best_trial: Optional[float] = None
    try:
        with open(os.path.join(base, "results.jsonl"), "r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                idx = row.get("index")
                if desc and row.get("desc") == desc and isinstance(idx, int):
                    return idx
                trial = row.get("trial_score")
                if isinstance(idx, int) and isinstance(trial, (int, float)):
                    if best_trial is None or trial > best_trial:
                        best_trial, best_index = trial, idx
    except OSError:
        return None
    return best_index


def auto_save(token: str, runs: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """自动保存够格的条件（每轮只存一次）。

    用户 2026-11-03 第 3/4 条定的两条保留线：

    * **通用**：推理分或验证分至少一个 ≥ 60（``PASS_SCORE``）——
      以前要求「两段都 ≥58」，把「训练好看、测试也不错」的轮次全漏掉了。
    * **个股**：某只股票在任一数据段拿到 ≥80 分 —— 这种条件整条可能不及格，
      但对特定个股很准，正是用户说的「就算只对某一些票有效也可以」。

    两条满足任意一条就存；存的是这一轮排名第 1 的变体。
    """
    saved = set(state.get("saved") or [])
    for item in _finished(runs):
        run_id = str(item.get("run_id"))
        tr, te = _score(item)
        scores = [value for value in (tr, te) if value is not None]
        best = max(scores) if scores else None
        general = best is not None and best >= PASS_SCORE
        stock_best = item.get("stock_best_score")
        stock = stock_best is not None and float(stock_best) >= 80.0
        if not (general or stock):
            continue
        if run_id in saved:
            continue
        index = _best_variant_index(run_id)
        if index is None:
            _log(f"autosave SKIP run={run_id}：找不到最优变体序号")
            continue
        name = _preset_name("p", state)
        try:
            _post_empty(f"/api/stocks/infer/runs/{run_id}/save?index={index}&name={name}", token)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:200]
            _log(f"autosave FAILED run={run_id} http={exc.code} {detail}")
            continue
        except Exception as exc:  # noqa: BLE001
            _log(f"autosave FAILED run={run_id} {type(exc).__name__}: {exc}")
            continue
        saved.add(run_id)
        scope = "通用" if general else "个股"
        _log(f"autosave OK run={run_id} -> {name} （{tr}/{te}，{scope}，序号 {index}）")
    state["saved"] = sorted(saved)


#: 名字末尾的评分后缀：``_999_778`` / ``_716``（和 fork_infer.search 保持一致）。
SCORE_SUFFIX_RE = re.compile(r"(?:_\d{2,4}){1,2}$")


def _score_suffix_text(item: dict[str, Any]) -> str:
    """这一轮的两个评分 ×10 取整数部分（``_716_491``）。没有分就没后缀。"""
    parts: list[str] = []
    for key in ("score_train", "score_test"):
        value = item.get(key)
        if value is None:
            continue
        try:
            parts.append(str(int(float(value) * 10)))
        except (TypeError, ValueError):
            continue
    return "_" + "_".join(parts) if parts else ""


def rename_preset_with_scores(runs: list[dict[str, Any]], state: dict[str, Any]) -> None:
    """轮次跑完后，把这一轮用的基础条件名补上评分（用户 2026-11-05 第 1/2 条）。

    调度器开轮前写下的 ``r11050610`` 这类条件名本身没有分数 —— 分数只有跑完才有。
    这里在轮次结束后把文件改名成 ``r11050610_716_491``，并回写文件内的 name，
    这样「新推理出来的条件」在已保存条件里也带着两个评分。
    """
    by_run = {str(entry.get("run_id")): str(entry.get("preset") or "")
              for entry in (state.get("starts") or [])}
    renamed = dict(state.get("renamed") or {})
    changed = False
    for item in _finished(runs):
        run_id = str(item.get("run_id"))
        preset = by_run.get(run_id) or ""
        if not preset or run_id in renamed:
            continue
        suffix = _score_suffix_text(item)
        if not suffix:
            continue
        old_path = os.path.join(PRESET_DIR, preset + ".json")
        new_name = preset + suffix
        if SCORE_SUFFIX_RE.search(preset) or not os.path.exists(old_path):
            renamed[run_id] = preset
            changed = True
            continue
        new_path = os.path.join(PRESET_DIR, new_name + ".json")
        try:
            with open(old_path, "r", encoding="utf-8") as handle:
                record = json.load(handle)
            if not isinstance(record, dict):
                record = {}
            record["name"] = new_name
            temp = os.path.join(PRESET_DIR, f".rename-{new_name}.json")
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(record, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temp, new_path)
            os.remove(old_path)
        except OSError as exc:
            _log(f"preset rename FAILED {preset} -> {new_name}: {exc}")
            continue
        renamed[run_id] = new_name
        changed = True
        _log(f"preset rename {preset} -> {new_name}（run={run_id}）")
    if changed:
        state["renamed"] = renamed


def prune(state: dict[str, Any], dry: bool = False) -> dict[str, Any]:
    """清磁盘但**不删历史记录**（用户 2026-11-02 第 2 条）。

    之前是「只留最近 20 轮、其余整目录删掉」，后果是历史记录跟着消失 ——
    用户只能看到最近一两天的任务。现在分两层：

    * ``meta.json`` / ``finalists.json``（几 KB）**永久保留**，历史记录永远在；
    * 只有体量大的 ``results.jsonl`` 会被清掉：最近 ``KEEP_RUNS`` 轮保留全量，
      更早的只留前 200 行（看榜单够用），再老的整个文件删掉。

    分析任务同理：老任务删 ``signals.db`` / ``明细.xlsx`` / ``artifacts``，留 ``meta.json``。
    """
    protected = set(state.get("protect") or [])
    dirs: list[tuple[float, str]] = []
    if os.path.isdir(DATA_DIR):
        for name in os.listdir(DATA_DIR):
            path = os.path.join(DATA_DIR, name)
            if not os.path.isdir(path) or name.startswith("."):
                continue
            try:
                with open(os.path.join(path, "meta.json"), "r", encoding="utf-8") as fh:
                    meta = json.load(fh)
            except (OSError, json.JSONDecodeError):
                meta = {}
            scores = meta.get("scores") or {}
            tr = (scores.get("train") or {}).get("score")
            te = (scores.get("test") or {}).get("score")
            if tr is not None and te is not None and min(tr, te) >= SAVE_SCORE:
                protected.add(name)
            dirs.append((os.path.getmtime(path), name))
    dirs.sort(reverse=True)

    trimmed: list[str] = []
    for i, (_, name) in enumerate(dirs):
        if i < KEEP_RUNS or name in protected:
            continue
        # 老轮次：只裁 results.jsonl，meta / finalists 留着（历史记录要用）
        path = os.path.join(DATA_DIR, name, "results.jsonl")
        if not os.path.exists(path):
            continue
        trimmed.append(name)
        if dry:
            continue
        try:
            if i < KEEP_RUNS * 3:
                keep_lines(path, RESULTS_KEEP_LINES)
            else:
                os.remove(path)
        except OSError:
            pass

    # 老的分析任务：删重产物（signals.db / Excel / artifacts），meta.json 留着
    analysed: list[tuple[float, str]] = []
    if os.path.isdir(ANALYSIS_DIR):
        for preset in os.listdir(ANALYSIS_DIR):
            pdir = os.path.join(ANALYSIS_DIR, preset)
            if not os.path.isdir(pdir):
                continue
            for name in os.listdir(pdir):
                path = os.path.join(pdir, name)
                if os.path.isdir(path):
                    analysed.append((os.path.getmtime(path), path))
    analysed.sort(reverse=True)
    cutoff = time.time() - KEEP_ANALYSIS_DAYS * 86400
    for i, (mtime, path) in enumerate(analysed):
        if i < KEEP_ANALYSIS_MIN or mtime >= cutoff:
            continue
        trimmed.append(os.path.basename(path))
        if not dry:
            prune_analysis_dir(path)

    state["protect"] = sorted(protected)[-60:]
    return {"trimmed": trimmed[:20], "trimmed_count": len(trimmed),
            "runs": len(dirs), "free_gb": round(_free_gb(), 1)}


def keep_lines(path: str, limit: int) -> None:
    """只保留 jsonl 的前 ``limit`` 行（原子替换，避免半截文件）。"""
    with open(path, "r", encoding="utf-8") as fh:
        head = [next(fh, "") for _ in range(limit)]
    text = "".join(line for line in head if line)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


#: 老轮次保留多少行 results.jsonl（够看榜单，又不至于占盘）
RESULTS_KEEP_LINES = 200


def prune_analysis_dir(path: str) -> None:
    """分析任务目录：删重产物、留 meta.json（历史记录靠它）。"""
    for name in os.listdir(path):
        if name == "meta.json":
            continue
        target = os.path.join(path, name)
        try:
            if os.path.isdir(target):
                shutil.rmtree(target, ignore_errors=True)
            else:
                os.remove(target)
        except OSError:
            continue
    # 标记一下，任务详情里能据此提示「明细已清理」，而不是报「不存在」
    meta_path = os.path.join(path, "meta.json")
    try:
        with open(meta_path, "r", encoding="utf-8") as fh:
            meta = json.load(fh)
        meta["artifacts_pruned"] = True
        with open(meta_path, "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=1)
    except (OSError, json.JSONDecodeError):
        pass


# --------------------------------------------------------------------------- #
# 命令
# --------------------------------------------------------------------------- #
def _runs(token: str) -> list[dict[str, Any]]:
    data = _get("/api/stocks/infer/runs?limit=200", token)
    return data.get("items") or data.get("runs") or []


def cmd_tick(args: argparse.Namespace) -> int:
    token = _login()
    runs = _runs(token)
    state = _load_state()
    latest = _latest(runs)

    # 1) 卡死兜底：线程还在但两小时没动 → 停掉
    if _alive(latest):
        age = _progress_age(latest)
        if age is not None and age > HARD_STALL_SEC:
            _log(f"stalled run={latest.get('run_id')} age={int(age)}s → stop")
            stop_run(token, str(latest.get("run_id")))
            time.sleep(3)
            runs = _runs(token)

    # 2) 进程重启过（部署 / OOM）留下的中断任务：先续跑，别从零开新一轮。
    #    只在「已经跑出东西」且同一轮没连续续跑失败过 2 次时尝试，防止崩循环。
    resumed = _resume_interrupted(token, runs, state)
    if resumed:
        runs = _runs(token)

    # 3) 跑完的轮次自动保存 + 补评分后缀 + 清盘
    auto_save(token, runs, state)
    rename_preset_with_scores(runs, state)
    auto_save_pr = prune(state)
    state["last_tick"] = time.time()
    state["last_prune"] = auto_save_pr
    _save_state(state)

    # 4) 开新任务
    result = start_new(token, runs, state, dry=args.dry)
    print(f"tick {result} free={_free_gb():.1f}G runs={len(runs)}")
    return 0


def _resume_interrupted(token: str, runs: list[dict[str, Any]],
                        state: dict[str, Any]) -> bool:
    """把最近一个中断的任务续跑起来（返回是否真的发起了续跑）。"""
    if not runs:
        return False
    latest = runs[0]
    if str(latest.get("status")) != "interrupted":
        return False
    done = int(latest.get("done_iterations") or 0)
    if done <= 0:
        return False
    attempts = dict(state.get("resume_attempts") or {})
    run_id = str(latest.get("run_id") or "")
    if int(attempts.get(run_id) or 0) >= 2:
        return False
    attempts[run_id] = int(attempts.get(run_id) or 0) + 1
    state["resume_attempts"] = attempts
    try:
        _post(f"/api/stocks/infer/runs/{run_id}/resume", {}, token)
        _log(f"resume interrupted run={run_id} done={done} attempt={attempts[run_id]}")
        print(f"已续跑中断任务 {run_id}（从 {done} 次继续）")
        return True
    except Exception as exc:  # noqa: BLE001
        _log(f"resume FAILED run={run_id} {type(exc).__name__}: {exc}")
        return False


def cmd_plan(args: argparse.Namespace) -> int:
    token = _login()
    runs = _runs(token)
    state = _load_state()
    return 0 if start_new(token, runs, state, dry=True) == "dry" else 0


def cmd_doctor(args: argparse.Namespace) -> int:
    state = _load_state()
    info: dict[str, Any] = {
        "api": "down", "service": "unknown", "cron": 0, "free_gb": round(_free_gb(), 1),
        "latest": {}, "starts_today": _starts_today(state),
        "last_tick_age_s": int(time.time() - float(state.get("last_tick") or 0)),
    }
    try:
        info["service"] = subprocess.run(
            ["systemctl", "is-active", "panwatch"], capture_output=True, text=True,
            timeout=10).stdout.strip() or "unknown"
    except Exception:  # noqa: BLE001
        pass
    try:
        cron = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=10).stdout
        info["cron"] = 1 if "infer_scheduler.py tick" in cron else 0
    except Exception:  # noqa: BLE001
        pass
    try:
        token = _login()
        info["api"] = "up"
        runs = _runs(token)
        # 失败的空跑轮不计入预算（与 start_new 用同一口径，doctor 才不会报虚高的数）
        info["starts_today"] = _starts_today(state, runs)
        latest = _latest(runs) or {}
        info["latest"] = {
            "run_id": latest.get("run_id"),
            "status": latest.get("status"),
            "alive": bool(latest.get("alive")),
            "done": int((latest.get("progress") or {}).get("done_iterations")
                        or latest.get("done_iterations") or 0),
            "iterations": int(latest.get("iterations") or 0),
            "phase": (latest.get("progress") or {}).get("phase"),
            "idle_s": _progress_age(latest),
            "score_train": latest.get("score_train"),
            "score_test": latest.get("score_test"),
        }
    except Exception as exc:  # noqa: BLE001
        info["api_error"] = f"{type(exc).__name__}: {exc}"[:200]

    if args.shell:
        for key in ("service", "api", "cron", "free_gb", "starts_today", "last_tick_age_s"):
            print(f"{key.upper()}={info[key]}")
        latest = info.get("latest") or {}
        print(f"RUN_ID={latest.get('run_id') or ''}")
        print(f"RUN_STATUS={latest.get('status') or ''}")
        print(f"RUN_ALIVE={1 if latest.get('alive') else 0}")
        print(f"RUN_DONE={latest.get('done') or 0}")
        print(f"RUN_ITERS={latest.get('iterations') or 0}")
        print(f"RUN_IDLE={int(latest.get('idle_s') or 0)}")
        print(f"RUN_SCORE_TRAIN={latest.get('score_train')}")
        print(f"RUN_SCORE_TEST={latest.get('score_test')}")
    else:
        print(json.dumps(info, ensure_ascii=False, indent=1))
    return 0


def cmd_prune(args: argparse.Namespace) -> int:
    state = _load_state()
    out = prune(state, dry=args.dry)
    _save_state(state)
    print(json.dumps(out, ensure_ascii=False))
    return 0


def cmd_seeds(args: argparse.Namespace) -> int:
    """把预设计种子写成条件文件（不启动任务），便于在界面里直接选。"""
    state = _load_state()
    made = []
    for name, rule, desc in SEEDS:
        preset = "s" + name[1:]  # s0 / s1 ...
        _write_preset(preset, rule, desc)
        made.append(preset)
    _save_state(state)
    print(json.dumps({"seeds": made}, ensure_ascii=False))
    return 0


def cmd_install_cron(args: argparse.Namespace) -> int:
    py = os.path.join(ROOT, "venv", "bin", "python")
    script = os.path.join(ROOT, "scripts", "infer_scheduler.py")
    line = CRON_LINE.format(py=py, script=script, log=LOG_FILE)
    current = subprocess.run(["crontab", "-l"], capture_output=True, text=True).stdout
    kept = [ln for ln in current.splitlines() if "infer_scheduler.py" not in ln]
    kept.append(line)
    body = "\n".join(kept).strip() + "\n"
    subprocess.run(["crontab", "-"], input=body, text=True, check=True)
    print("cron 已安装：\n" + line)
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    token = _login()
    runs = _runs(token)
    latest = _latest(runs) or {}
    if _alive(latest):
        stop_run(token, str(latest.get("run_id")))
        time.sleep(8)
        runs = _runs(token)
    if args.start:
        state = _load_state()
        print(f"stop+start: {start_new(token, runs, state)}")
    else:
        print("stopped")
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    token = _login()
    latest = _latest(_runs(token))
    if not latest or str(latest.get("status")) != "paused":
        print("not_paused")
        return 0
    try:
        _post_empty(f"/api/stocks/infer/runs/{latest.get('run_id')}/resume", token)
        _log(f"resume OK run={latest.get('run_id')}")
        print(f"resumed {latest.get('run_id')}")
    except Exception as exc:  # noqa: BLE001
        _log(f"resume FAILED {type(exc).__name__}: {exc}")
        print("resume_failed")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    token = _login()
    runs = _runs(token)
    state = _load_state()
    print(f"start: {start_new(token, runs, state, dry=args.dry, force=args.force)}")
    return 0


def cmd_main() -> int:
    ap = argparse.ArgumentParser(description="条件推理常驻调度器")
    sub = ap.add_subparsers(dest="cmd", required=True)

    tick = sub.add_parser("tick", help="一次调度（cron 每 5 分钟）")
    tick.add_argument("--dry", action="store_true")
    tick.set_defaults(func=cmd_tick)

    plan = sub.add_parser("plan", help="只打印下一次会开什么")
    plan.set_defaults(func=cmd_plan)

    doctor = sub.add_parser("doctor", help="健康快照")
    doctor.add_argument("--shell", action="store_true", help="输出 KEY=VALUE（bash 好解析）")
    doctor.set_defaults(func=cmd_doctor)

    pr = sub.add_parser("prune", help="清旧轮次")
    pr.add_argument("--dry", action="store_true")
    pr.set_defaults(func=cmd_prune)

    sd = sub.add_parser("seeds", help="写入预设计种子条件")
    sd.set_defaults(func=cmd_seeds)

    ic = sub.add_parser("install-cron", help="安装本调度器的 cron（幂等）")
    ic.set_defaults(func=cmd_install_cron)

    stp = sub.add_parser("stop", help="停掉当前轮（--start 顺便开下一轮）")
    stp.add_argument("--start", action="store_true")
    stp.set_defaults(func=cmd_stop)

    rsm = sub.add_parser("resume", help="恢复被暂停的轮次")
    rsm.set_defaults(func=cmd_resume)

    st = sub.add_parser("start", help="立即开一轮（不管上一轮）")
    st.add_argument("--dry", action="store_true")
    st.add_argument("--force", action="store_true")
    st.set_defaults(func=cmd_start)

    args = ap.parse_args()
    try:
        return args.func(args)
    except urllib.error.URLError as exc:
        print(f"api_unreachable:{exc.reason}")
        return 2
    except Exception as exc:  # noqa: BLE001
        _log(f"ERROR {type(exc).__name__}: {exc}")
        print(f"scheduler_error:{type(exc).__name__}: {str(exc)[:120]}")
        return 3


@contextlib.contextmanager
def _locked() -> Any:
    """cron 重叠时静默退出（不产生噪音告警）。"""
    fh = open(LOCK_FILE, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        yield False
        return
    try:
        yield True
    finally:
        fcntl.flock(fh, fcntl.LOCK_UN)
        fh.close()


if __name__ == "__main__":
    with _locked() as got:
        if not got:
            sys.exit(0)
        sys.exit(cmd_main())
