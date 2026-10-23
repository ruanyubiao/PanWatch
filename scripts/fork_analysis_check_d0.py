"""检查 d0_close 存的是收盘价还是开盘价（并用 run_screen 的同一套库）。"""
import sys

import sqlite3

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.api import fork_market

RUN = sys.argv[1] if len(sys.argv) > 1 else "20261023-103101-7rcp"
conn = sqlite3.connect(f"/opt/PanWatch/data/analysis_runs/xg1/{RUN}/signals.db")
conn.row_factory = sqlite3.Row
rows = conn.execute(
    "SELECT d0, code, d0_close, entry_open FROM signals WHERE is_control = 0 "
    "AND d0 BETWEEN '2024-06-03' AND '2024-06-04' LIMIT 5"
).fetchall()
db = fork_market._connect()
for row in rows:
    with db.cursor() as cur:
        cur.execute(
            "SELECT trade_date, open, close FROM stock_daily WHERE code = %(code)s AND trade_date = %(d0)s",
            {"code": row["code"], "d0": row["d0"]},
        )
        print(dict(row), cur.fetchone())
db.close()
conn.close()
