"""取数层：本机 MySQL（行情/技术面）+ 东财公开接口（板块/资金流/新闻）。

分工为什么是这样
----------------
- 行情与均线：本机 ``stock`` 库已有 5573 只票的日线、后复权 ``maN``、``tech_*``
  技术指标，一个外网请求都不用发（与 ``api/fork_market.py`` 同一套凭据）。
- 板块归属 / 主力资金流 / 个股新闻：库里没有，只能走东财公开接口（免费、无 key）。
  这三块都是**尽力而为**：拿不到就记进 ``limitations``，让页面与提示词都明确写出
  「本次未纳入」，而不是用空字符串混过去。

复权口径（最容易出错的一条）
---------------------------
库里 ``maN`` / ``tech_support`` / ``tech_resistance`` 是**后复权空间**的值，
``close/high/low`` 是不复权价。直接把 ma5 和现价放在一起会得出「均线远高于股价」
这种假结论，所以这里统一除以 ``adj_factor`` 还原（与 ``fork_market.map_row`` 一致）。
"""

from __future__ import annotations

import datetime as _dt
import logging
import os
from typing import Any, Optional

from . import calendar

logger = logging.getLogger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_NEWS_TIMEOUT = 8
_QUOTE_TIMEOUT = 6


class MarketDataUnavailable(RuntimeError):
    """MySQL 未配置或连不上 —— 端点转 503。"""


# ── MySQL ────────────────────────────────────────────────────────────────


def _db_config() -> dict[str, Any]:
    user = os.getenv("STOCK_DB_RO_USER")
    password = os.getenv("STOCK_DB_RO_PASSWORD")
    if not user or password is None:
        raise MarketDataUnavailable(
            "未配置只读行情库：需要环境变量 STOCK_DB_RO_USER / STOCK_DB_RO_PASSWORD"
            "（来源 /opt/stock/.env，由 systemd 的 EnvironmentFile 注入）"
        )
    raw_port = os.getenv("STOCK_DB_PORT") or "3306"
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise MarketDataUnavailable(f"STOCK_DB_PORT 不是合法端口：{raw_port}") from exc
    return {
        "host": os.getenv("STOCK_DB_HOST") or "127.0.0.1",
        "port": port,
        "user": user,
        "password": password,
        "database": os.getenv("STOCK_DB_NAME") or "stock",
        "charset": "utf8mb4",
    }


def _connect() -> Any:
    try:
        import pymysql
        from pymysql.cursors import DictCursor
    except ImportError as exc:  # pragma: no cover
        raise MarketDataUnavailable("缺少 MySQL 驱动 pymysql") from exc
    try:
        return pymysql.connect(
            cursorclass=DictCursor, connect_timeout=5, read_timeout=30, **_db_config()
        )
    except MarketDataUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001
        raise MarketDataUnavailable(f"连接行情库失败：{exc}") from exc


def _f(value: Any) -> Optional[float]:
    """Decimal/str/None → float；非数字给 None（不要给 0，0 会被读成真实值）。"""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


_BAR_COLUMNS = """
    d.trade_date, d.open, d.high, d.low, d.close, d.pre_close, d.change_pct,
    d.volume, d.amount, d.turnover_rate, d.pe_ttm, d.pb,
    d.total_market_cap, d.circulating_market_cap,
    d.ma5, d.ma10, d.ma20, d.ma60, d.adj_factor,
    d.tech_score, d.tech_trend, d.tech_macd, d.tech_rsi, d.tech_kdj,
    d.tech_boll, d.tech_volume, d.tech_support, d.tech_resistance, d.traded
"""


def resolve_name(code: str) -> Optional[str]:
    """只查股票名字（``stock_info.name``），不碰日线。

    用途：页面地址里不再带 ``?name=`` 之后（用户口径：代码已经能唯一确定标的），
    头部、队列、历史列表仍然要显示「山金国际」而不是「000975」。取不到就给
    ``None`` —— 名字只是显示用，**绝不能因为它把页面打成 500**。
    """
    try:
        conn = _connect()
    except MarketDataUnavailable:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM stock_info WHERE code = %s LIMIT 1", (code,))
            row = cur.fetchone()
    except Exception as exc:  # noqa: BLE001 - 名字取不到不该让接口失败
        logger.debug("resolve_name failed: %s", exc)
        return None
    finally:
        conn.close()
    return (row or {}).get("name") or None


def load_market_snapshot(code: str, bars: int = 130, as_of: Optional[str] = None) -> dict[str, Any]:
    """个股行情 + 均线 + 技术面 + 近期统计（全部来自 MySQL）。

    ``code`` 是 6 位纯数字代码（``stock_info.code``）；库里 ``symbol`` 带 sh/sz 前缀。
    返回的 ``available=False`` 表示库里没有这只票（新股未入仓或代码不存在）。

    ``as_of``（``YYYY-MM-DD``）：只读到这一天为止的日线，且**不叠加实时快照**。
    用途是给旧报告「复原当时的技术面」—— 报告里没存技术面块时，按它自己的
    基准日重读那一根日线，看到的仍是当天的数，而不是今天的。默认 ``None``
    保持原行为（读到最新 + 盘中补实时价）。
    """
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT code, symbol, exchange, name, status FROM stock_info WHERE code = %s LIMIT 1",
                (code,),
            )
            info = cur.fetchone()
            if not info:
                return {"available": False, "code": code, "reason": "行情库里没有这个代码"}
            if as_of:
                cur.execute(
                    f"SELECT {_BAR_COLUMNS} FROM stock_daily d "
                    "WHERE d.symbol = %s AND d.trade_date <= %s "
                    "ORDER BY d.trade_date DESC LIMIT %s",
                    (info["symbol"], as_of, int(bars)),
                )
            else:
                cur.execute(
                    f"SELECT {_BAR_COLUMNS} FROM stock_daily d "
                    "WHERE d.symbol = %s ORDER BY d.trade_date DESC LIMIT %s",
                    (info["symbol"], int(bars)),
                )
            rows = cur.fetchall() or []
    finally:
        conn.close()

    if not rows:
        return {
            "available": False,
            "code": code,
            "name": info.get("name"),
            "reason": "这只票在行情库里没有日线数据",
        }

    rows.reverse()  # 升序，最后一根是最新
    latest = rows[-1]
    adj = _f(latest.get("adj_factor")) or 1.0
    if adj <= 0:
        adj = 1.0

    def unadj(value: Any) -> Optional[float]:
        raw = _f(value)
        return None if raw is None else round(raw / adj, 4)

    closes = [x for x in (_f(r.get("close")) for r in rows) if x is not None]
    highs = [x for x in (_f(r.get("high")) for r in rows) if x is not None]
    lows = [x for x in (_f(r.get("low")) for r in rows) if x is not None]
    volumes = [x for x in (_f(r.get("volume")) for r in rows) if x is not None]

    bar_price = closes[-1] if closes else None
    asof = str(latest["trade_date"])
    high_20 = max(highs[-20:]) if len(highs) >= 20 else (max(highs) if highs else None)
    low_20 = min(lows[-20:]) if len(lows) >= 20 else (min(lows) if lows else None)

    # 盘中：库里最新一根是上一交易日，价格/当日量额要靠实时快照补上，
    # 否则页面会把昨天的收盘价和昨天的涨跌幅当成今天的行情。
    # 按历史日期复原（``as_of``）时不取实时价：那会拿今天的价去配历史的技术面。
    if as_of:
        quote: dict[str, Any] = {"available": False, "reason": "按报告基准日复原，不叠加实时快照"}
    else:
        quote = load_realtime_quote(code)
    intraday = bool(
        quote.get("available")
        and quote.get("price") is not None
        and (quote.get("quote_date") or "") > asof
    )
    price = quote["price"] if intraday else bar_price
    day_fields = {
        "price": price,
        "open": quote.get("open") if intraday else _f(latest.get("open")),
        "high": quote.get("high") if intraday else _f(latest.get("high")),
        "low": quote.get("low") if intraday else _f(latest.get("low")),
        "pre_close": quote.get("pre_close") if intraday else _f(latest.get("pre_close")),
        "change_pct": quote.get("change_pct") if intraday else _f(latest.get("change_pct")),
        "volume": quote.get("volume") if intraday else _f(latest.get("volume")),
        "amount": quote.get("amount") if intraday else _f(latest.get("amount")),
        "turnover_rate": quote.get("turnover_rate") if intraday else _f(latest.get("turnover_rate")),
    }


    def ret(n: int) -> Optional[float]:
        if price is None or len(closes) <= n:
            return None
        base = closes[-1 - n]
        if not base:
            return None
        return round((price - base) / base * 100, 2)

    # 量比（日线口径近似）：今日量 / 前 5 日均量。真正的量比是「每分钟均量」对比，
    # 日线上拿不到分钟量，所以这里明确按日线口径算，并在提示词里标注是近似值。
    volume_ratio = None
    if len(volumes) >= 6:
        prev = volumes[-6:-1]
        avg = sum(prev) / len(prev) if prev else 0
        if avg > 0:
            volume_ratio = round(volumes[-1] / avg, 2)

    ma5, ma10, ma20, ma60 = (unadj(latest.get(k)) for k in ("ma5", "ma10", "ma20", "ma60"))
    alignment = None
    if (
        price is not None
        and ma5 is not None
        and ma10 is not None
        and ma20 is not None
    ):
        if ma5 > ma10 > ma20 and price > ma5:
            alignment = "多头排列"
        elif ma5 < ma10 < ma20 and price < ma5:
            alignment = "空头排列"
        else:
            alignment = "均线缠绕"
    bias_ma5 = None
    if price is not None and ma5:
        bias_ma5 = round((price - ma5) / ma5 * 100, 2)

    return {
        "available": True,
        "code": code,
        "symbol": info["symbol"],
        "name": info.get("name"),
        "exchange": info.get("exchange"),
        "asof": asof,  # 技术面基准日：库里最新一根已收盘日线
        "as_of_requested": as_of,  # 非空 = 按历史日期复原（页面据此标注）
        "bar_close": bar_price,
        "intraday": intraday,  # True = 现价与当日量额来自实时快照
        "quote_date": quote.get("quote_date") if intraday else None,
        "quote_time": quote.get("quote_time") if intraday else None,
        "quote_reason": None if intraday else quote.get("reason"),
        "price": round(price, 4) if price is not None else None,
        "open": day_fields["open"],
        "high": day_fields["high"],
        "low": day_fields["low"],
        "pre_close": day_fields["pre_close"],
        "change_pct": day_fields["change_pct"],
        "volume": day_fields["volume"],
        "amount": day_fields["amount"],
        "turnover_rate": day_fields["turnover_rate"],
        "pe_ttm": _f(latest.get("pe_ttm")),
        "pb": _f(latest.get("pb")),
        "total_market_cap": _f(latest.get("total_market_cap")),
        "circulating_market_cap": _f(latest.get("circulating_market_cap")),
        "ma5": ma5,
        "ma10": ma10,
        "ma20": ma20,
        "ma60": ma60,
        "ma_alignment": alignment,
        "bias_ma5": bias_ma5,
        "volume_ratio": volume_ratio,
        "volume_ratio_asof": asof,  # 量比按已收盘日线口径：始终对应 asof 那一天
        "high_20": high_20,
        "low_20": low_20,
        "ret_5d": ret(5),
        "ret_20d": ret(20),
        "ret_60d": ret(60),
        "tech": {
            "score": latest.get("tech_score"),
            "trend": latest.get("tech_trend"),
            "macd": latest.get("tech_macd"),
            "rsi": latest.get("tech_rsi"),
            "kdj": latest.get("tech_kdj"),
            "boll": latest.get("tech_boll"),
            "volume": latest.get("tech_volume"),
            "support": unadj(latest.get("tech_support")),
            "resistance": unadj(latest.get("tech_resistance")),
        },
    }


def market_phase(now: Optional[_dt.datetime] = None) -> dict[str, Any]:
    """A 股市场阶段（盘中/午休/收盘集合竞价/盘后/非交易日）。

    交易日判定走 ``calendar.resolve``：行情库里出现过的日期最准，今天用指数快照兜底，
    只有两个来源都拿不到才退回「工作日 = 交易日」，并在返回里 ``calendar="approx"``
    标明，提示词与「数据缺口」据此降低置信度。
    """
    now = now or _dt.datetime.now()
    resolved = calendar.resolve(now)
    is_trading_day = bool(resolved.get("is_trading_day"))
    calendar_source = str(resolved.get("source") or "approx")

    t = now.time()
    if not is_trading_day:
        phase, label = "non_trading", "非交易日"
    elif t < _dt.time(9, 15):
        phase, label = "premarket", "盘前"
    elif t < _dt.time(9, 30):
        phase, label = "premarket", "开盘集合竞价"
    elif t < _dt.time(11, 30):
        phase, label = "intraday", "盘中"
    elif t < _dt.time(13, 0):
        phase, label = "lunch_break", "午间休市"
    elif t < _dt.time(14, 57):
        phase, label = "intraday", "盘中"
    elif t < _dt.time(15, 0):
        phase, label = "closing_auction", "收盘集合竞价"
    else:
        phase, label = "postmarket", "盘后"

    last_trade_date = resolved.get("last_trade_date")
    return {
        "phase": phase,
        "label": label,
        "market_local_time": now.strftime("%Y-%m-%d %H:%M"),
        "is_trading_day": is_trading_day,
        "calendar": calendar_source,
        "last_trade_date": last_trade_date.isoformat() if isinstance(last_trade_date, _dt.date) else None,
    }


# ── 东财公开接口 ─────────────────────────────────────────────────────────


def _http_get(url: str, params: dict[str, Any], referer: str, timeout: int) -> Any:
    import httpx

    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        resp = client.get(url, params=params, headers={"User-Agent": _UA, "Referer": referer})
        resp.raise_for_status()
        return resp


def _secid(code: str) -> str:
    """6 位代码 → 东财 secid（1=沪、0=深）。"""
    return f"1.{code}" if code[:1] in ("6", "5", "9") else f"0.{code}"


_QUOTE_FIELDS = "f43,f44,f45,f46,f47,f48,f57,f58,f60,f86,f168,f169,f170"
_CST = _dt.timezone(_dt.timedelta(hours=8))


def _px(value: Any) -> Optional[float]:
    """东财价格字段（×100 的整数）→ 元；停牌时是 ``-``，给 None。"""
    raw = _f(value)
    return None if raw is None else round(raw / 100, 2)


def load_realtime_quote(code: str) -> dict[str, Any]:
    """实时快照（东财 push2，免 key）：现价 / 涨跌 / 当日开高低 / 成交量额。

    为什么必须有这一层
    ------------------
    ``stock_daily`` 只装**已收盘**的日线，当天的 K 线要等收盘后的采集任务才入库。
    盘中分析时库里最新一根是上一交易日，拿它当「现价」就会把昨天的收盘价、昨天的
    涨跌幅当成今天的行情。价格取快照、技术指标仍用已收盘日线，两者在提示词里分开
    标注，才不会互相污染。

    取不到（停牌 / 接口异常）返回 ``available=False``，调用方退回日线，不抛异常。
    """
    try:
        resp = _http_get(
            "https://push2.eastmoney.com/api/qt/stock/get",
            {"secid": _secid(code), "fields": _QUOTE_FIELDS, "ut": "fa5fd1943c7b386f172d6893dbfba10b"},
            referer="https://quote.eastmoney.com/",
            timeout=_QUOTE_TIMEOUT,
        )
        payload = (resp.json() or {}).get("data") or {}
    except Exception as exc:  # noqa: BLE001 - 快照失败不该让整条分析失败
        logger.warning("取实时快照失败（%s），本次退回日线口径：%s", code, exc)
        return {"available": False, "reason": f"实时快照取数失败：{exc}"}

    if not payload:
        return {"available": False, "reason": "实时快照无数据（可能停牌或代码不存在）"}

    price = _px(payload.get("f43"))
    if price is None:
        return {"available": False, "reason": "实时快照没有现价（停牌或集合竞价前）"}

    stamp = payload.get("f86")
    quote_dt: Optional[_dt.datetime] = None
    if stamp not in (None, "", "-"):
        try:
            quote_dt = _dt.datetime.fromtimestamp(int(stamp), _CST)
        except (TypeError, ValueError, OSError):
            quote_dt = None

    volume_lots = _f(payload.get("f47"))
    return {
        "available": True,
        "code": str(payload.get("f57") or code),
        "name": payload.get("f58"),
        "price": price,
        "change": _px(payload.get("f169")),
        "change_pct": _px(payload.get("f170")),
        "open": _px(payload.get("f46")),
        "high": _px(payload.get("f44")),
        "low": _px(payload.get("f45")),
        "pre_close": _px(payload.get("f60")),
        # 东财成交量单位是「手」，库里 stock_daily.volume 是「股」，统一换成股
        "volume": None if volume_lots is None else round(volume_lots * 100, 0),
        "amount": _f(payload.get("f48")),
        "turnover_rate": _px(payload.get("f168")),
        "quote_date": quote_dt.date().isoformat() if quote_dt else None,
        "quote_time": quote_dt.strftime("%Y-%m-%d %H:%M:%S") if quote_dt else None,
    }


def load_boards(code: str) -> dict[str, Any]:
    """行业 / 地区 / 概念板块（东财 ``push2 stock/get`` 的 f127/f128/f129）。"""
    try:
        resp = _http_get(
            "https://push2.eastmoney.com/api/qt/stock/get",
            {
                "secid": _secid(code),
                "fields": "f57,f58,f127,f128,f129",
                "ut": "fa5fd1943c7b386f172d6893dbfba10b",
            },
            referer="https://quote.eastmoney.com/",
            timeout=_QUOTE_TIMEOUT,
        )
        data = (resp.json() or {}).get("data") or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("取板块失败 %s：%s", code, exc)
        return {"available": False, "reason": f"板块数据不可用：{exc}"}

    industry = (data.get("f127") or "").strip()
    region = (data.get("f128") or "").strip()
    concepts = [x.strip() for x in (data.get("f129") or "").split(",") if x.strip()]
    tags = [x for x in ([industry, region] + concepts) if x]
    return {
        "available": bool(tags),
        "industry": industry or None,
        "region": region or None,
        "concepts": concepts,
        "tags": tags,
    }


def load_capital_flow(code: str, days: int = 5) -> dict[str, Any]:
    """主力资金流（东财 fflow daykline）。单位为元，**不做单位换算**，由提示词格式化。"""
    try:
        resp = _http_get(
            "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get",
            {
                "secid": _secid(code),
                "lmt": "0",
                "klt": "101",
                "fields1": "f1,f2,f3,f7",
                "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
                "ut": "b2884a393a59ad64002292a3e90d46a5",
            },
            referer="https://quote.eastmoney.com/",
            timeout=_QUOTE_TIMEOUT,
        )
        klines = ((resp.json() or {}).get("data") or {}).get("klines") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("取资金流失败 %s：%s", code, exc)
        return {"available": False, "reason": f"资金流不可用：{exc}"}
    if not klines:
        return {"available": False, "reason": "资金流为空"}

    def row(line: str) -> dict[str, Any]:
        parts = line.split(",")
        return {
            "date": parts[0],
            "main_net": _f(parts[1]),
            "small_net": _f(parts[2]),
            "mid_net": _f(parts[3]),
            "large_net": _f(parts[4]),
            "super_large_net": _f(parts[5]),
            "main_net_pct": _f(parts[6]) if len(parts) > 6 else None,
        }

    recent = [row(x) for x in klines[-max(days, 1):]]
    total = sum(x["main_net"] or 0 for x in recent)
    return {"available": True, "latest": recent[-1], "recent": recent, "sum_main_net": total}


def load_news(keyword: str, count: int = 12) -> dict[str, Any]:
    """东财新闻搜索（JSONP 接口，去掉包装后按 JSON 解析）。"""
    import json as _json

    param = _json.dumps(
        {
            "uid": "",
            "keyword": keyword,
            "type": ["cmsArticleWebOld"],
            "client": "web",
            "clientType": "web",
            "clientVersion": "curr",
            "param": {
                "cmsArticleWebOld": {
                    "searchScope": "default",
                    "sort": "time",
                    "pageIndex": 1,
                    "pageSize": min(count, 30),
                    "preTag": "",
                    "postTag": "",
                }
            },
        }
    )
    try:
        resp = _http_get(
            "https://search-api-web.eastmoney.com/search/jsonp",
            {"cb": "jQuery", "param": param},
            referer="https://so.eastmoney.com/",
            timeout=_NEWS_TIMEOUT,
        )
        text = resp.text.strip()
        if text.startswith("jQuery("):
            text = text[len("jQuery("):]
        if text.endswith(")"):
            text = text[:-1]
        payload = _json.loads(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("取新闻失败 %s：%s", keyword, exc)
        return {"available": False, "reason": f"新闻搜索不可用：{exc}"}

    items = ((payload.get("result") or {}).get("cmsArticleWebOld")) or []
    news = [
        {
            "title": (it.get("title") or "").strip(),
            "summary": (it.get("content") or "").strip()[:200],
            "date": (it.get("date") or "").strip(),
            "url": it.get("url") or "",
        }
        for it in items
        if (it.get("title") or "").strip()
    ][:count]
    return {"available": bool(news), "items": news}
