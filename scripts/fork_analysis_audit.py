"""全量跑完后的体检：口径、显著性、匹配质量、分组结论。"""
import json
import sqlite3
import statistics
import sys

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.fork_analysis import stats, store

RUN = sys.argv[1] if len(sys.argv) > 1 else "20261023-103101-7rcp"
PRESET = "xg1"
conn = store.open_db(PRESET, RUN)
meta = store.load_meta(PRESET, RUN)
print("status", meta["status"], "days", meta["days_done"], "hits", meta["hits"],
      "control", meta["control"], "unverifiable", meta.get("unverifiable"), "caliber", meta.get("caliber"))
print("elapsed_s", meta.get("elapsed_s"), "dv", meta.get("data_version", {}).get("max_trade_date"))

row = conn.execute(
    "SELECT COUNT(*) n, SUM(COALESCE(verif,1)=0) unverif, SUM(COALESCE(unfillable,0)=1) unfill, "
    "AVG(COALESCE(stale_days,0)) stale, SUM(COALESCE(stale_days,0)>=5) stale5, "
    "AVG(COALESCE(adj_missing,0)) adjm FROM signals WHERE is_control = 0"
).fetchone()
print("rows", row["n"], "unverif", row["unverif"], "unfillable", row["unfill"], "stale_avg",
      round(row["stale"] or 0, 2), "stale>=5", row["stale5"], "adj_missing_avg", row["adjm"])

# 对照组与信号组的市值结构（匹配质量的直接证据）
for tag, cond in (("hits", "is_control = 0"), ("control", "is_control = 1")):
    rows = conn.execute(f"SELECT mcap FROM signals WHERE {cond} AND mcap IS NOT NULL").fetchall()
    values = sorted(float(r["mcap"]) for r in rows)
    if not values:
        continue
    tiers = [0, 0, 0, 0, 0]
    for value in values:
        if value < 30:
            tiers[0] += 1
        elif value < 100:
            tiers[1] += 1
        elif value < 300:
            tiers[2] += 1
        elif value < 1000:
            tiers[3] += 1
        else:
            tiers[4] += 1
    total = len(values)
    print(tag, "n", total, "median_mcap", round(statistics.median(values), 1),
          "tiers%", [round(t / total * 100, 1) for t in tiers])

report = stats.build_report(conn, meta)
print("caliber", report["caliber"], "cost", report["cost"])
print("honest verdict", json.dumps(report["verdict"].get("honest"), ensure_ascii=False))
print(f"{'H':>3} {'win%':>7} {'ctl%':>7} {'pooled':>8} {'day':>8} {'ci_low':>8} {'ci_high':>8} {'nw_t':>6} {'days':>5} {'neff':>5}")
for srow, hrow in zip(report["summary"], report["significance"]):
    print(f"{srow['horizon']:>3} {srow['signal']['win_rate']:>7} {srow['control']['win_rate']:>7} "
          f"{hrow['pooled_excess_pp']:>8} {hrow['mean_excess_pp']:>8} {hrow['ci_low_pp']:>8} "
          f"{hrow['ci_high_pp']:>8} {hrow['nw_t']:>6} {hrow['days']:>5} {hrow['n_eff']:>5}")
st = report["stability"]
print("design(2020-2023)", st["design_excess_pp"])
print("validate(2024-)  ", st["validate_excess_pp"])
print("quality", {k: report["quality"][k] for k in
                  ("rows", "unverifiable", "unfillable", "suspect_days_count", "max_stale_days")})
print("suspect sample", report["quality"]["suspect_days"][:5])

effective = [(block["label"], item["key"], item["win_rate"], item["edge_pp"],
              item.get("excess_vs_random_pp"), item["n"], item["q"])
             for block in report["groups"] for item in block["items"] if item.get("significant")]
print("special groups", len(effective))
print("  label/key/win/edge_vs_condition/edge_vs_random/n/q")
for item in sorted(effective, key=lambda x: -(x[3] or -99))[:12]:
    print("  ", item)

items = stats.by_stock(conn, stats.control_win_rates(report["summary"]), horizons=tuple(report["horizons"]),
                       cal=report["caliber"], cost=report["cost"])
top = items[0]
print("top stock", top["code"], top["name"], "n", top["n"], "win", top["win"], "shrunk", top["win_shrunk"])
print("sufficient stocks", sum(1 for i in items if i["sufficient"]), "of", len(items))
conn.close()
