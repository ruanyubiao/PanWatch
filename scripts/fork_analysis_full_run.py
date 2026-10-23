"""完整重跑：2020-01-01 起，v3 口径（可执行价格、市值配比对照、质量分层）。

在云端 setsid 跑，日志写 /tmp/full_run.log。进程退出 = 线程结束，所以这里
必须一直循环到任务落终态。
"""
import datetime as dt
import sys
import time

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.fork_analysis import runner, stats, store
from modules.market.fork_analysis.models import AnalysisCreate

payload = AnalysisCreate(preset="xg1", start_date=dt.date(2020, 1, 1), validate_days=30)
meta = runner.create(payload)
print("created", meta["run_id"], meta["start_date"], meta["end_date"], meta["days_total"],
      "caliber", meta.get("caliber"), flush=True)

last = None
while True:
    current = store.load_meta(meta["preset"], meta["run_id"])
    progress = current.get("progress") or {}
    line = (current["status"], progress.get("days_done"), progress.get("hits"),
            progress.get("avg_ms"), progress.get("eta_s"))
    if line != last:
        print(dt.datetime.now().strftime("%H:%M:%S"), *line, flush=True)
        last = line
    if current["status"] in ("done", "stopped", "failed"):
        break
    time.sleep(30)

print("finished", current["status"], "hits", current.get("hits"), "control", current.get("control"),
      "unverifiable", current.get("unverifiable"), "err", current.get("error"), flush=True)

conn = store.open_db(meta["preset"], meta["run_id"])
report = stats.build_report(conn, current)
print("verdict:", report["verdict"].get("honest"), flush=True)
for row in report["significance"]:
    print("honest", row["horizon"], row["days"], row["n_eff"], row["mean_excess_pp"],
          row["ci_low_pp"], row["ci_high_pp"], row["nw_t"], flush=True)
print("stability:", report["stability"]["design_excess_pp"], report["stability"]["validate_excess_pp"], flush=True)
print("quality:", {k: report["quality"][k] for k in ("rows", "unverifiable", "unfillable", "suspect_days_count")}, flush=True)
conn.close()
