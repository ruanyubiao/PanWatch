"""验证对照组的市值匹配：抽若干天，比较命中股票与对照股票的市值档分布。

不依赖 signals.db 里的快照（对照组不写入 mcap），直接重跑当天的抽样函数。
"""
import datetime as dt
import sys
from collections import Counter

sys.path.insert(0, "/opt/PanWatch/app/src")
sys.path.insert(0, "/opt/PanWatch/app")

from modules.market.api import fork_market
from modules.market.fork_analysis import forward
from modules.market.fork_screen import presets
from modules.market.fork_screen.models import ScreenRequest
from modules.market.fork_screen.service import run_screen

record = presets.load("xg1")
request = ScreenRequest.model_validate(record["request"])
days = [dt.date(2020, 6, 1), dt.date(2021, 6, 1), dt.date(2022, 6, 1),
        dt.date(2023, 6, 1), dt.date(2024, 6, 3), dt.date(2025, 6, 3), dt.date(2026, 8, 3)]

EDGES = (30.0, 100.0, 300.0, 1000.0)


def tier(value):
    if value is None:
        return -1
    for index, edge in enumerate(EDGES):
        if value < edge:
            return index
    return len(EDGES)


conn = fork_market._connect()
for day in days:
    response = run_screen(request, asof=day)
    items = list(response.get("items") or [])
    codes = [str(item.get("code") or item.get("c")) for item in items]
    snaps = forward.fetch_snapshots(conn, day, codes)
    hit_mcaps = [snaps.get(code, {}).get("mcap") for code in codes]
    controls = forward.control_sample_matched(
        conn, day, 200, request.markets, bool(request.include_st),
        hit_mcaps=hit_mcaps, exclude=codes,
    )
    hit_tiers = Counter(tier(value) for value in hit_mcaps)
    ctl_tiers = Counter(tier(item.get("mcap")) for item in controls)
    hn, cn = max(1, sum(hit_tiers.values())), max(1, sum(ctl_tiers.values()))
    print(day, "hits", len(items), "controls", len(controls),
          "hits%", [round(hit_tiers[i] / hn * 100, 1) for i in range(5)],
          "ctl%", [round(ctl_tiers[i] / cn * 100, 1) for i in range(5)])
conn.close()
