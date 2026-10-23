import datetime as dt
import json
import sys
import time

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.fork_analysis import runner, stats, store
from modules.market.fork_analysis.models import AnalysisCreate

payload = AnalysisCreate(
    preset="xg1",
    start_date=dt.date(2026, 8, 1),
    validate_days=30,
)
meta = runner.create(payload)
print("created", meta["run_id"], meta["start_date"], meta["end_date"], meta["days_total"],
      "caliber", meta.get("caliber"), "dv", meta.get("data_version"))
for _ in range(240):
    current = store.load_meta(meta["preset"], meta["run_id"])
    if current["status"] in ("done", "stopped", "failed"):
        break
    time.sleep(5)
current = store.load_meta(meta["preset"], meta["run_id"])
print("status", current["status"], "hits", current.get("hits"), "control", current.get("control"),
      "unverifiable", current.get("unverifiable"), "err", current.get("error"))

conn = store.open_db(meta["preset"], meta["run_id"])
report = stats.build_report(conn, current)
print("caliber:", report["caliber"], "cost:", report["cost"])
print("verdict:", json.dumps(report["verdict"], ensure_ascii=False)[:600])
print(f"{'H':>3} {'sig_win':>8} {'ctl_win':>8} {'excess':>7} {'ci_low':>7} {'ci_high':>7} {'sig?':>5} {'n':>7}")
for row in report["summary"]:
    print(f"{row['horizon']:>3} {row['signal']['win_rate']:>8} {row['control']['win_rate']:>8} "
          f"{row['excess_pp']:>7} {row['signal']['n']:>7}")
print("honest:")
for row in report["significance"]:
    print(f"{row['horizon']:>3} {row['days']:>5} {row['n_eff']:>4} {row['mean_excess_pp']:>7.2f} "
          f"{row['ci_low_pp']:>7.2f} {row['ci_high_pp']:>7.2f} {str(row['significant_up']):>5} "
          f"{row['ci_method'] if 'ci_method' in row else ''} nw_t={row['nw_t']}")
print("quality:", json.dumps(report["quality"], ensure_ascii=False)[:400])
print("stability:", json.dumps({k: report["stability"][k] for k in ("split", "design_excess_pp", "validate_excess_pp")}, ensure_ascii=False))
print("groups special:", sum(1 for g in report["groups"] for i in g["items"] if i.get("significant")))
conn.close()
