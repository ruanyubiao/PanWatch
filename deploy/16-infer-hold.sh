#!/usr/bin/env bash
# ============================================================
#  发布配套：代理发布期间「停掉条件推理、发完再恢复」
#
#  用法（服务器）：
#      bash /opt/PanWatch/app/deploy/16-infer-hold.sh hold      # 发布前：暂停调度 + 停单元
#      bash /opt/PanWatch/app/deploy/16-infer-hold.sh release   # 发布后：续跑 + 恢复调度
#      bash /opt/PanWatch/app/deploy/16-infer-hold.sh status    # 只看当前状态
#
#  也可以从本机喂脚本执行（首次发布时远端还没有这个文件）：
#      ssh ... 'bash -s hold' < deploy/16-infer-hold.sh
#
#  为什么需要它（两次真事故）：
#   1. 10-publish.sh 会 `find app -mindepth 1 -delete`，正在跑的 worker 后续
#      import 失败只是运气问题 —— 必须先把单元停掉。
#   2. 调度 cron 每 5 分钟 tick 一次，上一分钟查空、下一分钟就可能新起一轮
#      （实测 15:37 空、15:40:08 就拉起一跑）。所以要连带把 tick 那行注释掉，
#      只在发布窗口内，发布完立刻恢复原样。
#
#  续跑语义：停单元不写 stop/pause 标记，meta 里仍是 running，工作进程已死；
#  POST /api/stocks/infer/runs/<id>/resume 对这种「僵死的 running」是允许的
#  （src/modules/market/fork_infer/search.py: resume），worker 按 results.jsonl
#  跳过已完成的变体，所以续跑是幂等的、进度不丢。
#
#  状态文件：/opt/PanWatch/data/.infer_hold.json —— release 靠它知道该续哪几轮；
#  恢复失败的会留在文件里，下一次 release 继续重试（不会静默丢任务）。
# ============================================================
set -euo pipefail

ROOT=/opt/PanWatch
MODE=${1:-status}
/opt/PanWatch/venv/bin/python - "$ROOT" "$MODE" <<'PYEOF'
import json
import os
import subprocess
import sys
import time

ROOT, MODE = sys.argv[1], sys.argv[2]
DATA = os.path.join(ROOT, "data")
STATE = os.path.join(DATA, ".infer_hold.json")
UNIT_PREFIX = "panwatch-infer-"
CRON_MARK = "#DEPLOY-HOLD "
CRON_HIT = "infer_scheduler.py tick"


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def units_running():
    """正在跑的 panwatch-infer-* 单元（没匹配时 systemctl 退出码非 0，忽略）。"""
    done = run(["systemctl", "list-units", "panwatch-infer-*", "--all",
                "--no-legend", "--plain"])
    out = []
    for line in (done.stdout or "").splitlines():
        parts = line.split()
        if len(parts) < 4 or not parts[0].startswith(UNIT_PREFIX):
            continue
        if parts[2] == "active" and parts[3] == "running":
            out.append(parts[0])
    return out


def unit_active(unit):
    done = run(["systemctl", "is-active", unit])
    return (done.stdout or "").strip() == "active"


def meta_of(run_id):
    path = os.path.join(DATA, "infer_runs", run_id, "meta.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def done_of(run_id):
    prog = meta_of(run_id).get("progress") or {}
    try:
        return int(prog.get("done_iterations") or 0)
    except (TypeError, ValueError):
        return 0


def cron_lines():
    done = run(["crontab", "-l"])
    if done.returncode != 0:
        return []
    return (done.stdout or "").splitlines()


def cron_write(lines):
    payload = "\n".join(lines) + "\n"
    done = subprocess.run(["crontab", "-"], input=payload, capture_output=True, text=True)
    if done.returncode != 0:
        raise SystemExit(f"crontab 写入失败: {(done.stderr or '').strip()[:200]}")


def cron_pause():
    """注释掉调度 tick 那行；返回被注释的行（已经是注释的不动）。"""
    lines = cron_lines()
    touched = []
    out = []
    for line in lines:
        if CRON_HIT in line and not line.lstrip().startswith("#"):
            out.append(CRON_MARK + line)
            touched.append(line)
        else:
            out.append(line)
    if touched:
        cron_write(out)
    return touched


def cron_restore():
    """把带标记的行原样放回去，其它行不动（发布窗口内别人改 crontab 也不会被覆盖）。"""
    lines = cron_lines()
    restored = 0
    out = []
    for line in lines:
        if line.startswith(CRON_MARK):
            out.append(line[len(CRON_MARK):])
            restored += 1
        else:
            out.append(line)
    if restored:
        cron_write(out)
    return restored


def load_state():
    try:
        with open(STATE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE)


def api_resume(run_id):
    """复用调度器的登录/请求；返回 (ok, 说明)。"""
    sys.path.insert(0, os.path.join(ROOT, "app", "scripts"))
    import infer_scheduler as sched  # noqa: WPS433 - 延迟导入，路径在上面

    token = sched._login()
    sched._post(f"/api/stocks/infer/runs/{run_id}/resume", {}, token)
    return True, "resume 已提交"


if MODE == "hold":
    state = load_state()
    held = {item["run_id"]: item for item in (state.get("runs") or [])}
    touched = cron_pause()
    units = units_running()
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    print(f"HOLD_MODE held_at={now}")
    print(f"  cron 暂停行数: {len(touched)}")
    for unit in units:
        run_id = unit[len(UNIT_PREFIX):]
        if run_id.endswith(".service"):
            run_id = run_id[: -len(".service")]
        done_before = done_of(run_id)
        stopped = run(["sudo", "-n", "systemctl", "stop", unit])
        ok = stopped.returncode == 0
        for _ in range(30):
            if not unit_active(unit):
                break
            time.sleep(0.5)
        still = unit_active(unit)
        print(f"  stop {unit}: rc={stopped.returncode} active={still} "
              f"done_before={done_before}")
        if stopped.returncode != 0:
            print(f"    stderr: {(stopped.stderr or '').strip()[:200]}")
        held[run_id] = {
            "run_id": run_id,
            "unit": unit,
            "done_before": done_before,
            "stopped_at": now,
            "active_before": True,
        }
    state["runs"] = list(held.values())
    state.setdefault("held_at", now)
    state["cron_touched"] = bool(state.get("cron_touched")) or bool(touched)
    save_state(state)
    print(f"HOLD_OK runs={len(state['runs'])} state={STATE}")

elif MODE == "release":
    state = load_state()
    runs = state.get("runs") or []
    if not runs:
        restored = cron_restore()
        print(f"RELEASE_NOTHING_TO_DO cron_restored={restored}")
        if os.path.exists(STATE):
            os.remove(STATE)
        raise SystemExit(0)
    pending = []
    print(f"RELEASE_MODE runs={len(runs)}")
    for item in runs:
        run_id = item["run_id"]
        unit = item.get("unit") or (UNIT_PREFIX + run_id + ".service")
        done_before = int(item.get("done_before") or 0)
        meta = meta_of(run_id)
        status = str(meta.get("status") or "")
        if meta.get("finished_at") or status in ("done", "error", "stopped"):
            print(f"  skip {run_id}: 已结束 status={status}（无需续跑）")
            continue
        try:
            ok, why = api_resume(run_id)
        except Exception as exc:  # noqa: BLE001
            print(f"  resume {run_id}: 失败 {type(exc).__name__}: {exc}")
            pending.append(item)
            continue
        active = False
        for _ in range(60):
            if unit_active(unit):
                active = True
                break
            time.sleep(0.5)
        done_after = done_of(run_id)
        print(f"  resume {run_id}: {why} unit_active={active} "
              f"done {done_before}->{done_after}")
        if not active:
            pending.append(item)
    restored = cron_restore()
    print(f"  cron 恢复行数: {restored}")
    if pending:
        state["runs"] = pending
        state["cron_touched"] = False
        save_state(state)
        print(f"RELEASE_PARTIAL 未恢复 {len(pending)} 轮，状态文件保留，"
              f"可重跑 release 重试：{[p['run_id'] for p in pending]}")
        raise SystemExit(1)
    if os.path.exists(STATE):
        os.remove(STATE)
    print("RELEASE_OK")

elif MODE == "status":
    state = load_state()
    units = units_running()
    print("units_running:", units or "（无）")
    print("hold_state:", json.dumps(state, ensure_ascii=False) if state else "（无）")
    marked = [line for line in cron_lines() if CRON_HIT in line]
    print("cron:", marked or "（无 tick 行）")
    print("STATUS_OK")

else:
    raise SystemExit(f"未知模式 {MODE}（hold|release|status）")
PYEOF
