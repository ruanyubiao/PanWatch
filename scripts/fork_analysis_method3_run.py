"""方法 3 全历史任务：2020-01-01 起跑 xg1，跑完打印结论卡与五周期表。

在云端 setsid 跑（前台会被 420s 掐断）。日志 /tmp/m3_run.log。
"""
import datetime as dt
import json
import sys
import time

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.fork_analysis import methods, runner, store
from modules.market.fork_analysis.models import AnalysisCreate

payload = AnalysisCreate(preset="xg1", method="stat_v3", start_date=dt.date(2020, 1, 1))
meta = runner.create(payload)
run_id = meta["run_id"]
print("created", run_id, meta["start_date"], meta["end_date"], meta["days_total"],
      "forward_days", meta.get("forward_days"), flush=True)

last = None
while True:
    current = store.load_meta(meta["preset"], run_id)
    progress = current.get("progress") or {}
    line = (current["status"], progress.get("days_done"), progress.get("hits"),
            progress.get("avg_ms"), progress.get("eta_s"))
    if line != last:
        print(dt.datetime.now().strftime("%H:%M:%S"), *line, flush=True)
        last = line
    if current["status"] in ("done", "stopped", "failed"):
        break
    time.sleep(30)

print("finished", current["status"], "hits", current.get("hits"),
      "control", current.get("control"), "unverifiable", current.get("unverifiable"),
      "err", current.get("error"), flush=True)

conn = store.open_db("xg1", run_id)
report = methods.build("stat_v3", conn, {**current, "preset": "xg1"})
conn.close()

print("HEADLINE", json.dumps(report.headline.as_dict(), ensure_ascii=False), flush=True)
for table in report.tables:
    if table.key == "windows":
        for row in table.rows:
            print("WINDOW", json.dumps(row, ensure_ascii=False), flush=True)
    if table.key == "profile":
        usable = [row for row in table.rows if row["verdict"] == "有效"]
        print("USABLE", len(usable), flush=True)
        for row in usable[:25]:
            print("SEG", json.dumps(row, ensure_ascii=False), flush=True)
print("QUALITY", json.dumps(report.data_quality, ensure_ascii=False), flush=True)
print("RUN_ID", run_id, flush=True)
