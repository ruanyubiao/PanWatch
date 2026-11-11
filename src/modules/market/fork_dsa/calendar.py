"""交易日历：本机行情库里出现过的日期 = 真实开过市的日期。

为什么不再用「工作日 = 交易日」
-------------------------------
五一/国庆/春节这类长假会让「工作日近似」把休市日说成「盘中」，摘要里就会凭空写出
「今日盘中主力流出」这种背景。行情库每天收盘后落一根日线（``stock_daily_recent``
保留最近 90 个交易日），**某一天在库里出现过就等于那天真的开过市** —— 这是最便宜
也最准的日历，不用拉第三方日历接口，也不用逐年维护节假日表。

库里还没有的那一天（今天，收盘前采集任务还没跑），用东财上证指数快照的时间戳
（``push2`` 的 ``f86``）兜底：

- 快照日期 == 今天            → 今天开市（盘中 / 午休 / 收盘竞价都能判）
- 快照日期 <  今天 且已过 09:30 → 今天休市（长假）
- 快照日期 <  今天 且未到 09:30 → 开盘前无法确认，按开市处理（此时标签只会是「盘前」）

三种来源用 ``source`` 区分，``service`` 只在 ``approx`` 时写进「数据缺口」，
避免在日历已经准确的情况下还挂着一条假的缺口。
"""

from __future__ import annotations

import datetime as _dt
import logging
import threading
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_INDEX_SECID = "1.000001"  # 上证指数
_QUOTE_TIMEOUT = 6
_CACHE_TTL_SECONDS = 300  # 5 分钟：盘中足够准，又不至于每次分析都打一次行情库

_CACHE: dict[str, Any] = {}
_LOCK = threading.Lock()


def _connect() -> Any:
    """复用 ``data._connect``：凭据只有一份（STOCK_DB_RO_*），不在这里重复读环境变量。"""
    from . import data as _data

    return _data._connect()


def _db_last_trade_date(conn: Any) -> Optional[_dt.date]:
    with conn.cursor() as cur:
        cur.execute("SELECT MAX(trade_date) AS d FROM stock_daily_recent")
        row = cur.fetchone()
    value = (row or {}).get("d")
    if isinstance(value, _dt.datetime):
        return value.date()
    return value if isinstance(value, _dt.date) else None


def _db_has(conn: Any, day: _dt.date) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 AS x FROM stock_daily_recent WHERE trade_date = %s LIMIT 1", (day,))
        return cur.fetchone() is not None


def _index_last_trade_date() -> Optional[_dt.date]:
    """上证指数快照对应的日期（东财 push2，免 key）。失败给 None。"""
    try:
        import httpx

        with httpx.Client(timeout=_QUOTE_TIMEOUT, follow_redirects=True) as client:
            resp = client.get(
                "https://push2.eastmoney.com/api/qt/stock/get",
                params={"secid": _INDEX_SECID, "fields": "f57,f58,f86"},
                headers={"User-Agent": _UA, "Referer": "https://quote.eastmoney.com/"},
            )
            resp.raise_for_status()
            stamp = ((resp.json() or {}).get("data") or {}).get("f86")
        if not stamp:
            return None
        return _dt.datetime.fromtimestamp(int(stamp)).date()
    except Exception as exc:  # noqa: BLE001 - 日历兜底失败不该让整条分析失败
        logger.warning("取指数快照失败，交易日历退回工作日近似：%s", exc)
        return None


def _resolve_uncached(now: _dt.datetime) -> dict[str, Any]:
    day = now.date()
    last: Optional[_dt.date] = None
    try:
        conn = _connect()
        try:
            last = _db_last_trade_date(conn)
            if last is not None and day <= last:
                # 库里已覆盖这一天：出现过 = 开过市，没出现 = 休市（周末 / 长假）
                return {
                    "is_trading_day": _db_has(conn, day),
                    "source": "db",
                    "last_trade_date": last,
                }
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读行情库日历失败：%s", exc)

    # 库里还没有今天（收盘前没跑采集），用指数快照兜底
    index_day = _index_last_trade_date()
    if index_day is not None:
        if index_day >= day:
            return {"is_trading_day": True, "source": "live", "last_trade_date": index_day}
        if now.time() < _dt.time(9, 30):
            # 开盘前快照还没更新，今天是否开市无法确认；此时阶段只会显示「盘前」
            return {"is_trading_day": True, "source": "preopen", "last_trade_date": index_day}
        if day.weekday() < 5:
            # 工作日但指数没交易 → 长假休市
            return {"is_trading_day": False, "source": "live", "last_trade_date": index_day}

    # 两个来源都拿不到：退回工作日近似，并让 service 把它写进数据缺口
    return {
        "is_trading_day": day.weekday() < 5,
        "source": "approx",
        "last_trade_date": last or index_day,
    }


def resolve(now: Optional[_dt.datetime] = None) -> dict[str, Any]:
    """今天的交易日状态：``is_trading_day`` / ``source`` / ``last_trade_date``。

    ``source``：``db``（行情库日历，最准）/ ``live``（指数快照）/ ``preopen``（开盘前）/
    ``approx``（两个来源都不可用，退回工作日近似）。
    """
    now = now or _dt.datetime.now()
    key = now.strftime("%Y-%m-%dT%H:%M")[:-1]  # 10 分钟一档，避免盘中反复查库
    with _LOCK:
        cached = _CACHE.get("value")
        if cached and cached.get("key") == key and time.time() - cached.get("ts", 0) < _CACHE_TTL_SECONDS:
            return dict(cached["data"])

    data = _resolve_uncached(now)
    with _LOCK:
        _CACHE["value"] = {"key": key, "ts": time.time(), "data": data}
    return dict(data)
