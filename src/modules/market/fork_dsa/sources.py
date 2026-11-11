"""免 key 的公开数据面：公司公告 / 融资融券 / 财联社 7×24 快讯。

为什么单独一个文件
------------------
``data.py`` 负责「行情与主力资金」这类核心技术面；这里三块是**消息面与杠杆面**，
来源是东财数据中心与财联社，都**不需要任何 apikey**（财联社用网页签名
``MD5(SHA1(sorted(params)))``，不是账号密钥）。取数逻辑参照用户提供的
``stock_analysis_api``（``api/eastmoney.py`` 的 ``get_announcements`` /
``get_margin_trading``、``api/cailianpress.py`` 的 ``get_flash_news``），按本仓库
的写法重写成小函数 —— 不整包引入那个仓库，因为它 90% 的内容与 PanWatch 现有
采集重复。

模块清单（页面「数据源」面板）
------------------------------
``MODULE_CATALOG`` 是**唯一真相**：页面按它逐行显示每个模块的来源与状态。
状态三档：

- ``ok``           已接入且本次取到
- ``unavailable``  已接入但本次没取到（接口超时 / 当日无数据）
- ``unconfigured`` 本页不使用（需要付费源或第三方 apikey），页面显示「未配置」

为什么要把「未配置」也列出来
----------------------------
用户口径是「凡是需要外部 apikey 的模块，先用已有的替换，没有的就显示未配置」。
**显示成一行「未配置」比静默省略更诚实**：否则用户会以为报告已经覆盖了研报与
社交情绪，把「没查」当成「查过且没有」。
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import logging
import urllib.parse
from typing import Any, Optional

logger = logging.getLogger(__name__)

_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_TIMEOUT = 8


# ── 模块清单 ──────────────────────────────────────────────────────────────

#: 每个模块：key / 展示名 / 来源（None = 本页不接） / 是否必须 apikey / 未接入原因
MODULE_CATALOG: tuple[dict[str, Any], ...] = (
    {"key": "market", "label": "行情 / 均线 / 技术指标", "source": "本机行情库 MySQL", "requires_key": False},
    {"key": "boards", "label": "板块归属", "source": "东财公开接口", "requires_key": False},
    {"key": "capital_flow", "label": "主力资金流", "source": "东财公开接口", "requires_key": False},
    {"key": "news", "label": "个股新闻", "source": "东财新闻搜索", "requires_key": False},
    {"key": "announcements", "label": "公司公告", "source": "东财公告接口", "requires_key": False},
    {"key": "margin", "label": "融资融券", "source": "东财数据中心", "requires_key": False},
    {"key": "flash", "label": "7×24 快讯", "source": "财联社（网页签名，免 key）", "requires_key": False},
    {"key": "research", "label": "研报 / 机构评级", "source": "东财研报中心（免 key）", "requires_key": False},
    {"key": "billboard", "label": "龙虎榜", "source": "东财数据中心（免 key）", "requires_key": False},
    {
        "key": "popularity",
        "label": "社交情绪（东财股吧人气替代）",
        "source": "东财人气榜（免 key）",
        "requires_key": False,
        "note": "雪球 / Reddit 需第三方 apikey，本页用东财人气排名替代",
    },
    {
        "key": "northbound",
        "label": "北向资金（十大成交活跃股）",
        "source": "东财沪深港通 · 每日十大成交活跃股（免 key）",
        "requires_key": False,
        "empty_label": "未上榜",
        "note": "个股每日北向净买额自 2024-08-19 起交易所不再披露（港交所：持股明细改为季度），"
        "本页改用仍每日公布的「北向十大成交活跃股」看外资是否在积极买卖这只票",
    },
)


def module_status(availability: dict[str, Any]) -> list[dict[str, Any]]:
    """把「本次取数结果」映射成页面要的行（status: ok / empty / unavailable / unconfigured）。

    ``availability[key]`` 三态：``True`` 取到、``"empty"`` 接入了但这只票没有数据
    （例如没有任何机构覆盖、没进北向活跃榜）、``False``/缺失 接口失败。
    """
    rows: list[dict[str, Any]] = []
    for module in MODULE_CATALOG:
        key = module["key"]
        got = availability.get(key)
        if not module.get("source"):
            status = "unconfigured"
        elif got is True:
            status = "ok"
        elif got == "empty":
            status = "empty"
        else:
            status = "unavailable"
        rows.append(
            {
                "key": key,
                "label": module["label"],
                "source": module.get("source"),
                "requires_key": bool(module.get("requires_key")),
                "status": status,
                "note": module.get("note"),
                "empty_label": module.get("empty_label"),
            }
        )
    return rows


# ── HTTP ─────────────────────────────────────────────────────────────────


def _get_json(url: str, params: dict[str, Any], referer: str, timeout: int = _TIMEOUT) -> Any:
    import httpx

    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        resp = client.get(url, params=params, headers={"User-Agent": _UA, "Referer": referer})
        resp.raise_for_status()
        return resp.json()


def _post_json(url: str, body: dict[str, Any], referer: str, timeout: int = _TIMEOUT) -> Any:
    import httpx

    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        resp = client.post(url, json=body, headers={"User-Agent": _UA, "Referer": referer})
        resp.raise_for_status()
        return resp.json()


def _secid(code: str) -> str:
    return f"1.{code}" if code[:1] in ("6", "5", "9") else f"0.{code}"


# ── 公司公告 ─────────────────────────────────────────────────────────────


def load_announcements(code: str, limit: int = 8) -> dict[str, Any]:
    """个股公告（年报 / 季报 / 股东会 / 停复牌…）。东财 ``np-anotice-stock``，免费。"""
    try:
        payload = _get_json(
            "https://np-anotice-stock.eastmoney.com/api/security/ann",
            {
                "sr": "-1",
                "page_size": max(1, min(limit, 30)),
                "page_index": 1,
                "ann_type": "A",
                "stock_list": code,
                "f_node": 0,
                "s_node": 0,
            },
            referer="https://data.eastmoney.com/notices/",
        )
    except Exception as exc:  # noqa: BLE001 - 尽力而为，失败写进缺口
        logger.warning("取公告失败 %s：%s", code, exc)
        return {"available": False, "reason": f"公告接口不可用：{exc}"}

    items = ((payload or {}).get("data") or {}).get("list") or []
    rows = []
    for item in items:
        title = (item.get("title") or "").strip()
        if not title:
            continue
        rows.append(
            {
                "title": title,
                "date": (item.get("notice_date") or "")[:10],
                "event": classify_event(title),
                "url": f"https://data.eastmoney.com/notices/detail/{code}/{item.get('art_code') or ''}.html",
            }
        )
    return {"available": bool(rows), "items": rows[:limit]}


#: 事件分类：只用来给模型一个「这是什么性质的事」的粗标签，不做重要性打分。
_EVENT_RULES: tuple[tuple[str, str], ...] = (
    ("业绩预告", "业绩预告"),
    ("业绩快报", "业绩快报"),
    ("年报", "定期报告"),
    ("季报", "定期报告"),
    ("半年报", "定期报告"),
    ("减持", "减持"),
    ("增持", "增持"),
    ("回购", "回购"),
    ("质押", "股权质押"),
    ("定增", "再融资"),
    ("股东大会", "公司治理"),
    ("停牌", "停复牌"),
    ("复牌", "停复牌"),
    ("中标", "经营合同"),
    ("重大合同", "经营合同"),
    ("诉讼", "诉讼仲裁"),
    ("处罚", "监管处罚"),
    ("问询", "监管问询"),
)


def classify_event(title: str) -> str:
    for keyword, label in _EVENT_RULES:
        if keyword in title:
            return label
    return "其他"


# ── 融资融券 ─────────────────────────────────────────────────────────────


def load_margin(code: str) -> dict[str, Any]:
    """个股最新两融数据（东财 ``RPTA_WEB_RZRQ_GGMX``）。金额单位：元。"""
    try:
        payload = _get_json(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            {
                "reportName": "RPTA_WEB_RZRQ_GGMX",
                "columns": "ALL",
                "pageNumber": 1,
                "pageSize": 1,
                "sortColumns": "DATE",
                "sortTypes": -1,
                "source": "WEB",
                "client": "WEB",
                "filter": f'(SCODE="{code}")',
            },
            referer="https://data.eastmoney.com/rzrq/",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("取两融失败 %s：%s", code, exc)
        return {"available": False, "reason": f"两融接口不可用：{exc}"}

    rows = ((payload or {}).get("result") or {}).get("data") or []
    if not rows:
        # 不在两融标的范围内是**正常情况**（不是故障）—— 提示词据此不写入「两融为零」
        return {"available": False, "reason": "该标的没有两融数据（可能不是两融标的）"}

    row = rows[0]
    return {
        "available": True,
        "date": (row.get("DATE") or "")[:10],
        "financing_balance": row.get("RZYE"),
        "financing_buy": row.get("RZMRE"),
        "lending_balance": row.get("RQYE"),
        "total_balance": row.get("RZRQYE"),
    }


# ── 财联社 7×24 快讯 ──────────────────────────────────────────────────────


def _cls_sign(params: dict[str, Any]) -> str:
    """财联社网页签名：参数按 key 排序 → urlencode → sha1 → md5。**不是账号密钥。**"""
    raw = urllib.parse.urlencode(sorted(params.items(), key=lambda x: x[0]))
    return hashlib.md5(hashlib.sha1(raw.encode()).hexdigest().encode()).hexdigest()


def _stock_codes(item: dict[str, Any]) -> list[str]:
    """财联社的 ``stock_list`` 有时是 "600519,000858"，有时是 [{"StockID": ...}] 这类列表。"""
    raw = item.get("stock_list")
    if isinstance(raw, str):
        return [x for x in raw.split(",") if x]
    if isinstance(raw, list):
        codes = []
        for entry in raw:
            if isinstance(entry, str):
                codes.append(entry)
            elif isinstance(entry, dict):
                code = entry.get("StockID") or entry.get("code") or entry.get("RiseRange")
                if code:
                    codes.append(str(code))
        return codes
    return []


def load_flash_news(keyword: Optional[str], limit: int = 40) -> dict[str, Any]:
    """财联社电报。**全市场快讯**，按关键词（股票名）挑出相关的，挑不到就给重点栏目。

    返回结构里 ``matched`` 说明这批是不是提到这只票的：
    提到 → 消息面证据；没提到 → 只能当大盘情绪背景，提示词里会写清楚。
    """
    params: dict[str, Any] = {
        "appName": "CailianpressWeb",
        "os": "web",
        "sv": "7.7.5",
        "last_time": "",
        "refresh_type": 1,
        "rn": max(1, min(limit, 100)),
    }
    params["sign"] = _cls_sign(params)
    try:
        payload = _get_json(
            "https://www.cls.cn/v1/roll/get_roll_list",
            params,
            referer="https://www.cls.cn/",
            timeout=_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("取财联社快讯失败：%s", exc)
        return {"available": False, "reason": f"财联社快讯不可用：{exc}"}

    roll = ((payload or {}).get("data") or {}).get("roll_data") or []
    level_rank = {"A": 3, "B": 2, "C": 1}
    items = []
    for item in roll:
        title = (item.get("title") or item.get("brief") or "").strip()
        if not title:
            continue
        body = (item.get("content") or "").strip()
        stocks = _stock_codes(item)
        items.append(
            {
                "title": title,
                "summary": body[:120],
                "level": item.get("level") or "C",
                "importance": level_rank.get(item.get("level") or "C", 1),
                "ctime": item.get("ctime") or 0,
                "stocks": stocks,
            }
        )

    if not items:
        return {"available": False, "reason": "财联社快讯为空"}

    matched = []
    if keyword:
        matched = [x for x in items if keyword in x["title"] or keyword in (x["summary"] or "")]
    if matched:
        picked = matched[:6]
        mode = "stock"
    else:
        # 没有提到这只票：给重要性最高的几条，标注成「大盘背景」，不许写成个股消息
        picked = sorted(items, key=lambda x: (-x["importance"], -x["ctime"]))[:6]
        mode = "market"

    for item in picked:
        item["time"] = _fmt_ctime(item.pop("ctime"))
    return {"available": True, "mode": mode, "items": picked}


def _fmt_ctime(value: Any) -> str:
    try:
        stamp = int(value)
    except (TypeError, ValueError):
        return ""
    if stamp <= 0:
        return ""
    return _dt.datetime.fromtimestamp(stamp).strftime("%m-%d %H:%M")


def _float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "" or value == "-":
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


# ── 研报 / 机构评级（免 key）─────────────────────────────────────────────


def load_research(code: str, limit: int = 5) -> dict[str, Any]:
    """机构研报与评级（东财研报中心 ``reportapi``，免费、无 key）。

    窗口取**近三年**而不是近一年：小盘股的覆盖很稀疏（实测 600877 电科芯片全库只有
    2024 年一篇中航证券的点评，近一年窗口里 hits=0，页面就显示「本次未获取到」——
    看起来像接口坏了）。放宽到三年后这篇能进来，同时把「距今天数」一起返回，提示词
    与页面据此标明「最新一篇已是 N 个月前」，不会被当成新观点。

    零覆盖（三年内一篇都没有）返回 ``available=False, empty=True``：这是「这只票没有
    卖方覆盖」的**事实**，与接口故障是两回事，页面显示「无覆盖」而不是「未配置」。
    """
    today = _dt.date.today()
    begin = today - _dt.timedelta(days=365 * 3)
    params = {
        "industryCode": "*",
        "pageSize": max(1, min(limit, 20)),
        "industry": "*",
        "pageNo": 1,
        "qType": 0,
        "code": code,
        "beginTime": begin.isoformat(),
        "endTime": today.isoformat(),
    }
    try:
        payload = _get_json(
            "https://reportapi.eastmoney.com/report/list",
            params,
            referer="https://data.eastmoney.com/report/",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("取研报失败 %s：%s", code, exc)
        return {"available": False, "reason": f"研报接口不可用：{exc}"}

    rows = (payload or {}).get("data") or []
    if not rows:
        return {"available": False, "empty": True, "reason": "近三年无机构研报覆盖"}

    items = []
    ratings: dict[str, int] = {}
    for row in rows:
        rating = str(row.get("emRatingName") or "").strip()
        if rating:
            ratings[rating] = ratings.get(rating, 0) + 1
        items.append(
            {
                "date": str(row.get("publishDate") or "")[:10],
                "org": row.get("orgSName") or row.get("orgName"),
                "title": str(row.get("title") or "").strip(),
                "rating": rating or None,
                "rating_change": str(row.get("ratingChange") or "").strip() or None,
                "target_price": _float(row.get("indvAimPriceT")),
                "pe_this_year": _float(row.get("predictThisYearPe")),
                "pe_next_year": _float(row.get("predictNextYearPe")),
            }
        )
    # 最新一篇距今多久：模型很容易把三年前的点评当成「最新观点」，这个数字直接给它。
    newest_age = _days_since(items[0]["date"], today) if items else None
    return {
        "available": True,
        "window_years": 3,
        "hits": (payload or {}).get("hits") or len(items),
        "items": items,
        "ratings": ratings,
        "newest_age_days": newest_age,
    }


def _days_since(value: str, today: _dt.date) -> Optional[int]:
    try:
        return (today - _dt.date.fromisoformat(value[:10])).days
    except (TypeError, ValueError):
        return None


# ── 龙虎榜（免 key）─────────────────────────────────────────────────────


def load_billboard(code: str, limit: int = 5) -> dict[str, Any]:
    """个股最近上榜记录（东财数据中心 ``RPT_DAILYBILLBOARD_DETAILS``，免费）。

    「近一年没上过榜」是正常结果，不是故障 —— 返回 ``available=False`` 并写明原因，
    这样模型不会把「没查」当成「查过且无异常」。
    """
    try:
        payload = _get_json(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            {
                "reportName": "RPT_DAILYBILLBOARD_DETAILS",
                "columns": "ALL",
                "pageNumber": 1,
                "pageSize": max(1, min(limit, 10)),
                "sortColumns": "TRADE_DATE",
                "sortTypes": -1,
                "source": "WEB",
                "client": "WEB",
                # 限定近一年：不加日期会翻出 2007 年的上榜记录，模型会把十几年前
                # 的异动当成近期证据（实测 600519 返回 2013/2007 两条）。
                "filter": (
                    f'(SECURITY_CODE="{code}")(TRADE_DATE>=\''
                    f'{(_dt.date.today() - _dt.timedelta(days=365)).isoformat()}\')'
                ),
            },
            referer="https://data.eastmoney.com/stock/lhb.html",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("取龙虎榜失败 %s：%s", code, exc)
        return {"available": False, "reason": f"龙虎榜接口不可用：{exc}"}

    rows = ((payload or {}).get("result") or {}).get("data") or []
    if not rows:
        return {"available": False, "empty": True, "reason": "近一年没有上过龙虎榜"}

    items = [
        {
            "date": str(row.get("TRADE_DATE") or "")[:10],
            "reason": str(row.get("EXPLANATION") or "").strip(),
            "note": str(row.get("EXPLAIN") or "").strip(),
            "net_buy": row.get("BILLBOARD_NET_AMT"),
            "buy": row.get("BILLBOARD_BUY_AMT"),
            "sell": row.get("BILLBOARD_SELL_AMT"),
            "change_pct": row.get("CHANGE_RATE"),
            "d5_return": row.get("D5_CLOSE_ADJCHRATE"),
        }
        for row in rows
    ]
    return {"available": True, "items": items}


# ── 北向资金：十大成交活跃股（替代「已停止披露的每日净买额」）─────────────


def load_northbound(code: str, limit: int = 10, lookback_days: int = 60) -> dict[str, Any]:
    """北向活跃度（东财 ``RPT_MUTUAL_TOP10DEAL``，免费、免 key、**每日更新**）。

    为什么不是「北向净买额」
    ------------------------
    港交所明示：自 2024-08-19 起沪深港通北向**持股明细改为按季度披露**，逐日个股
    净买额也随之停止——这个字段在免费源里已经不存在了，不是接入问题。但「北向十大
    成交活跃股」仍然每个交易日公布（含北向成交额、占该股成交额比例、当日排名），
    足以回答「外资这几天有没有在积极买卖这只票」。

    「近 N 个交易日没进过前十」是**正常结果**，返回 ``available=False, empty=True``：
    中小盘进前十很难，页面显示「未上榜」，提示词据此不得推断「外资在流出」。
    """
    today = _dt.date.today()
    begin = today - _dt.timedelta(days=lookback_days)
    try:
        payload = _get_json(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            {
                "reportName": "RPT_MUTUAL_TOP10DEAL",
                "columns": "SECURITY_CODE,SECURITY_NAME,TRADE_DATE,DEAL_AMT,DEAL_AMOUNT,"
                "MUTUAL_RATIO,RANK,CHANGE_RATE,CLOSE_PRICE",
                "pageNumber": 1,
                "pageSize": max(1, min(limit, 30)),
                "sortColumns": "TRADE_DATE",
                "sortTypes": -1,
                "source": "WEB",
                "client": "WEB",
                "filter": f'(SECURITY_CODE="{code}")(TRADE_DATE>=\'{begin.isoformat()}\')',
            },
            referer="https://data.eastmoney.com/hsgt/top10.html",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("取北向活跃股失败 %s：%s", code, exc)
        return {"available": False, "reason": f"北向活跃股接口不可用：{exc}"}

    rows = ((payload or {}).get("result") or {}).get("data") or []
    if not rows:
        return {
            "available": False,
            "empty": True,
            "reason": f"近 {lookback_days} 天没有进入北向十大成交活跃股",
            "note": "个股每日北向净买额自 2024-08-19 起不再披露；未上榜不代表外资在卖出",
        }

    items = [
        {
            "date": str(row.get("TRADE_DATE") or "")[:10],
            "rank": row.get("RANK"),
            # DEAL_AMT = 北向当日成交额（买+卖），DEAL_AMOUNT = 该股当日总成交额
            "northbound_deal": row.get("DEAL_AMT"),
            "stock_deal": row.get("DEAL_AMOUNT"),
            "ratio": row.get("MUTUAL_RATIO"),
            "change_pct": row.get("CHANGE_RATE"),
            "close": row.get("CLOSE_PRICE"),
        }
        for row in rows
    ]
    return {
        "available": True,
        "appearances": len(items),
        "latest": items[0],
        "items": items,
    }


# ── 人气排名（替代社交情绪）──────────────────────────────────────────────


def load_popularity(code: str) -> dict[str, Any]:
    """东财人气榜排名 —— 替代需要第三方 apikey 的雪球 / Reddit 社交情绪。

    榜单接口只公开**前 100 名**（``pageNo`` 传 2 返回空，实测），也没有按代码查的入口，
    所以只能在这一百名里找自己；找不到就写「未进入前 100」。这是真实信息（这只票
    不在当日热门榜上），不当成失败，也不能写成「情绪高涨」。
    """
    symbol = ("SH" if code[:1] in ("6", "5", "9") else "SZ") + code
    scope = 100
    rank: Optional[int] = None
    try:
        payload = _post_json(
            "https://emappdata.eastmoney.com/stockrank/getAllCurrentList",
            {
                "appId": "appId01",
                "globalId": "786e4c21-70dc-435a-93bb-38",
                "marketType": "",
                "pageNo": 1,
                "pageSize": scope,
            },
            referer="https://guba.eastmoney.com/",
        )
        for row in (payload or {}).get("data") or []:
            if str(row.get("sc") or "").upper() == symbol:
                rank = int(row.get("rk") or 0) or None
                break
    except Exception as exc:  # noqa: BLE001
        logger.warning("取人气榜失败 %s：%s", code, exc)
        return {"available": False, "reason": f"人气榜接口不可用：{exc}"}

    return {"available": True, "rank": rank, "scope": scope}

