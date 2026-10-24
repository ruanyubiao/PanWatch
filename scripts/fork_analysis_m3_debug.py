"""诊断：为什么真实数据上 delta 法的标准误大得离谱。"""
import sys

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

import math

from modules.market.fork_analysis import significance, store
from modules.market.fork_analysis.methods import method3

run_id = sys.argv[1]
conn = store.open_db("xg1", run_id)
events, reasons, dup = method3.load_events(conn)
conn.close()

valid = [row for row in events if row[10] and all(row[13 + i] is not None for i in range(5))]
signal = [row for row in valid if not row[9]]
base = [row for row in valid if row[9]]
print("signal", len(signal), "base", len(base))

index = 2
sd_ = method3._daily_series(signal, index)
bd_ = method3._daily_series(base, index)
ns = sum(n for _, n in sd_.values())
nb = sum(n for _, n in bd_.values())
ps = sum(w for w, _ in sd_.values()) / ns
pb = sum(w for w, _ in bd_.values()) / nb
print("days_sig", len(sd_), "days_base", len(bd_), "N_sig", ns, "N_base", nb, "p_sig", ps, "p_base", pb)

days = sorted(set(sd_) | set(bd_))
lag = min(19, len(days) - 1)
a = []
b = []
for day in days:
    w, c = sd_.get(day, (0, 0))
    a.append((w - ps * c) / ns)
    w, c = bd_.get(day, (0, 0))
    b.append((w - pb * c) / nb)
nw_a = significance.newey_west_se(a, lag)
nw_b = significance.newey_west_se(b, lag)
mean_a = sum(a) / len(a)
mean_b = sum(b) / len(b)
sd_a = (sum((x - mean_a) ** 2 for x in a) / (len(a) - 1)) ** 0.5
sd_b = (sum((x - mean_b) ** 2 for x in b) / (len(b) - 1)) ** 0.5
print("D", len(days), "lag", lag)
print("mean_a", mean_a, "sd_a", sd_a, "nw_se(a)", nw_a)
print("mean_b", mean_b, "sd_b", sd_b, "nw_se(b)", nw_b)
print("se_sig(sum)", nw_a * len(days), "se_base(sum)", nw_b * len(days))
print("delta_pp", (ps - pb) * 100)

ex = method3._cluster_excess(signal, base, index)
print("fn", {k: (round(v, 6) if isinstance(v, float) else v) for k, v in ex.items()})
