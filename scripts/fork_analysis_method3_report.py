"""只重算报告（不重跑选股）：读 m3_events → 出表格 → 打结论。

用法：./venv/bin/python scripts/fork_analysis_method3_report.py <run_id>
"""
import json
import sys
import time

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.fork_analysis import methods, runner, store

run_id = sys.argv[1]
meta = store.load_meta("xg1", run_id)
started = time.perf_counter()
names = runner.write_method3_artifacts("xg1", run_id)
elapsed = time.perf_counter() - started
print("artifacts", names, "elapsed_s", round(elapsed, 1), flush=True)

conn = store.open_db("xg1", run_id)
report = methods.build("stat_v3", conn, {**store.load_meta("xg1", run_id), "preset": "xg1"})
conn.close()

print("HEADLINE", json.dumps(report.headline.as_dict(), ensure_ascii=False), flush=True)
for table in report.tables:
    if table.key == "windows":
        for row in table.rows:
            print("WINDOW", json.dumps({key: (round(value, 3) if isinstance(value, float) else value)
                                        for key, value in row.items()}, ensure_ascii=False), flush=True)
    if table.key == "profile":
        usable = [row for row in table.rows if row["verdict"] == "有效"]
        print("USABLE", len(usable), "of", table.total_rows, flush=True)
        for row in usable[:30]:
            print("SEG", json.dumps({key: (round(value, 3) if isinstance(value, float) else value)
                                     for key, value in row.items()}, ensure_ascii=False), flush=True)
        tops = [row for row in table.rows if row["verdict"] in ("无优势", "不显著")][:10]
        for row in tops:
            print("SEG_TOP", json.dumps({key: (round(value, 3) if isinstance(value, float) else value)
                                         for key, value in row.items()}, ensure_ascii=False), flush=True)
    if table.key == "buckets":
        for row in table.rows[:12]:
            print("BUCKET", json.dumps({key: (round(value, 3) if isinstance(value, float) else value)
                                        for key, value in row.items()}, ensure_ascii=False), flush=True)
    if table.key == "stocks":
        print("STOCKS_TOTAL", table.total_rows, flush=True)
        for row in table.rows[:12]:
            print("STOCK", json.dumps({key: (round(value, 2) if isinstance(value, float) else value)
                                       for key, value in row.items()}, ensure_ascii=False), flush=True)
print("QUALITY", json.dumps(report.data_quality, ensure_ascii=False), flush=True)
