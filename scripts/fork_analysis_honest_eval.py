import glob, json, os, sqlite3, sys
sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")
from modules.market.fork_analysis import significance

roots = sorted(glob.glob("/opt/PanWatch/data/analysis_runs/*/*/signals.db"))
print("runs:", len(roots))
for path in roots:
    meta_path = os.path.join(os.path.dirname(path), "meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    n = conn.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
    print("\n===", path.replace("/opt/PanWatch/data/analysis_runs/", ""), "signals", n,
          "status", meta.get("status"), meta.get("start_date"), meta.get("end_date"))
    if n == 0:
        continue
    prefix, caliber = significance.caliber_columns(conn)
    print("caliber:", caliber)
    tests, _ = significance.tests(conn, [5, 10, 15, 20, 25, 30])
    print(f"{'H':>3} {'days':>5} {'n_eff':>6} {'mean':>7} {'ci_low':>7} {'ci_high':>7} {'nw_t':>6} {'t':>6} {'pooled':>7} {'ret':>7}")
    for row in tests:
        print(f"{row['horizon']:>3} {row['days']:>5} {row['n_eff']:>6} "
              f"{row['mean_excess_pp']:>7.2f} {row['ci_low_pp']:>7.2f} {row['ci_high_pp']:>7.2f} "
              f"{row['nw_t'] if row['nw_t'] is not None else 0:>6.2f} {row['t'] if row['t'] is not None else 0:>6.2f} "
              f"{row['pooled_excess_pp']:>7.2f} {row['mean_return_excess_pp']:>7.2f}")
    print("conclusion:", json.dumps(significance.conclusion(tests), ensure_ascii=False))
    conn.close()
