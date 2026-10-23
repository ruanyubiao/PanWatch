"""修补 d0_close（把误存的开盘价改回收盘价）并重建 Excel。

背景：build_forward 在 2026-10-23 那轮改动里把 d0 的「收盘价」解析成了开盘价
（Excel 的「信号日价格」列因此全是开盘价）。统计层不用这一列，所以只修数据 + 重出表。
"""
import sys

import sqlite3

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.api import fork_market
from modules.market.fork_analysis import excel, store

RUN = sys.argv[1] if len(sys.argv) > 1 else "20261023-103101-7rcp"
PRESET = "xg1"
db = store.open_db(PRESET, RUN)
days = [row["d0"] for row in db.execute("SELECT DISTINCT d0 FROM signals ORDER BY d0")]
print("days", len(days), flush=True)
mysql = fork_market._connect()
fixed = 0
for index, day in enumerate(days, start=1):
    with mysql.cursor() as cur:
        cur.execute("SELECT code, close FROM stock_daily WHERE trade_date = %(d0)s", {"d0": day})
        closes = {str(row["code"]): float(row["close"]) for row in (cur.fetchall() or [])
                  if row.get("close") is not None}
    if not closes:
        continue
    rows = db.execute("SELECT id, code FROM signals WHERE d0 = ?", (day,)).fetchall()
    payload = [(closes[row["code"]], row["id"]) for row in rows if row["code"] in closes]
    db.executemany("UPDATE signals SET d0_close = ? WHERE id = ?", payload)
    db.commit()
    fixed += len(payload)
    if index % 200 == 0:
        print("day", index, "rows", fixed, flush=True)
mysql.close()
print("fixed rows", fixed, flush=True)
print("rebuilding excel...", flush=True)
excel.write_workbook(db, PRESET, RUN)
print("done", flush=True)
db.close()
