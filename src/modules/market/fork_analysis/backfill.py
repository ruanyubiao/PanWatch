"""老任务补快照（口径 v2 上线时用一次）。

2026-10-22 之前的任务只有涨幅列，没有「信号日横截面」（行业/市值/PE/PB/换手/
成交额/振幅/上市年限/大盘环境/拥挤度）。这些值全都能从行情库按 ``d0`` 重查，
所以不必重跑几小时 —— 每天一次查询、一次 UPDATE，1646 天大约几分钟。

补完之后清掉分组缓存（``stats.invalidate_cache``），报告与 Excel 立刻用新维度。
"""

from __future__ import annotations

import datetime as _dt
import logging
from typing import Any, Optional

from ..api import fork_market
from . import excel as excel_module
from . import forward, stats, store

logger = logging.getLogger(__name__)


def fill_snapshots(preset_name: str, run_id: str, progress: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """按天回填快照列；返回 ``{days, rows}``。"""
    db = store.open_db(preset_name, run_id)
    conn = None
    days_done = 0
    rows_done = 0
    try:
        codes_by_day: dict[str, list[str]] = {}
        for row in db.execute("SELECT d0, code FROM signals WHERE is_control = 0"):
            codes_by_day.setdefault(str(row["d0"]), []).append(str(row["code"]))
        if not codes_by_day:
            return {"days": 0, "rows": 0}
        meta = store.load_meta(preset_name, run_id)
        conn = fork_market._connect()
        has_industry = forward.has_industry(conn)
        if not has_industry:
            logger.warning("stock_info 还没有 industry 列：行业维度这次只能留空")
        for index, (d0_text, codes) in enumerate(sorted(codes_by_day.items()), start=1):
            d0 = _dt.date.fromisoformat(d0_text)
            snapshots = forward.fetch_snapshots(conn, d0, codes)
            breadth = forward.market_breadth(conn, d0)
            rows_done += store.update_snapshots(db, d0_text, snapshots, len(codes), breadth)
            days_done += 1
            if progress is not None and index % 20 == 0:
                progress.update({"days_done": days_done, "rows_done": rows_done})
        store.patch_meta(
            preset_name,
            run_id,
            caliber="v2",
            validate_days=int(meta.get("validate_days") or 30),
            horizons=list(meta.get("horizons") or stats.horizons_for(int(meta.get("validate_days") or 30))),
            snapshots_filled_at=store._now(),
        )
        stats.invalidate_cache(db)
        return {"days": days_done, "rows": rows_done}
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        db.close()


def fill_vwap(preset_name: str, run_id: str, progress: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """按天补「次日典型价买入」的 v1..v30（入场假设敏感性用）。

    只重查行情、不重跑选股：每天一次 ``fetch_bars`` + 一次 ``executemany``，
    1600 天大约十分钟。老任务本来没有这组列，不补的话入场敏感性表里那一行
    会显示「不可用」而不是编一个数。
    """
    db = store.open_db(preset_name, run_id)
    market = None
    days_done = 0
    rows_done = 0
    try:
        codes_by_day: dict[str, list[tuple[str, str]]] = {}
        for row in db.execute("SELECT d0, code, symbol FROM signals WHERE is_control = 0"):
            codes_by_day.setdefault(str(row["d0"]), []).append((str(row["code"]), str(row["symbol"])))
        if not codes_by_day:
            return {"days": 0, "rows": 0}
        market = fork_market._connect()
        first = _dt.date.fromisoformat(min(codes_by_day))
        calendar = forward.trading_calendar(market, first, None)
        index = {day: position for position, day in enumerate(calendar)}
        columns = list(store.VWAP_COLUMNS)
        sql = (
            f"UPDATE signals SET {', '.join(f'{name} = ?' for name in columns)} "
            "WHERE d0 = ? AND code = ?"
        )
        for order, (d0_text, pairs) in enumerate(sorted(codes_by_day.items()), start=1):
            d0 = _dt.date.fromisoformat(d0_text)
            position = index.get(d0)
            if position is None:
                continue
            window = calendar[position + 1: position + 1 + forward.FORWARD_DAYS]
            if not window:
                continue
            symbols = [symbol for _code, symbol in pairs]
            bars, _missing = forward.fetch_bars(market, d0, symbols, window[-1])
            payload = []
            for code, symbol in pairs:
                series = bars.get(symbol) or []
                if not series or series[0][0] != d0:
                    continue
                result = forward.build_forward(series, window, forward.limit_pct(code, d0))
                if result is None:
                    continue
                values = list(result.vwap_returns) + [None] * (len(columns) - len(result.vwap_returns))
                payload.append(tuple(values[:len(columns)]) + (d0_text, code))
            if payload:
                db.executemany(sql, payload)
                db.commit()
                rows_done += len(payload)
            days_done += 1
            if progress is not None and order % 20 == 0:
                progress.update({"days_done": days_done, "rows_done": rows_done})
        store.patch_meta(preset_name, run_id, vwap_filled_at=store._now())
        stats.invalidate_cache(db)
        return {"days": days_done, "rows": rows_done}
    finally:
        if market is not None:
            try:
                market.close()
            except Exception:  # noqa: BLE001
                pass
        db.close()


def rebuild_excel(preset_name: str, run_id: str) -> str:
    db = store.open_db(preset_name, run_id)
    try:
        return excel_module.write_workbook(db, preset_name, run_id)
    finally:
        db.close()
