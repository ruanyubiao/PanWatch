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
    {
        "key": "margin",
        "label": "融资融券",
        "source": "东财数据中心（含标的名单判定）",
        "requires_key": False,
        "empty_label": "非两融标的",
        "note": "表里零记录 ＝ 从未纳入两融标的名单，是确定结论，不是取数失败",
    },
    {"key": "flash", "label": "7×24 快讯", "source": "财联社（网页签名，免 key）", "requires_key": False},
    {
        "key": "research",
        "label": "研报 / 机构评级",
        "source": "东财研报中心 + F10 机构预测（免 key）",
        "requires_key": False,
        "empty_label": "无券商覆盖",
    },
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
        "label": "北向资金（季度持股 + 十大活跃股）",
        "source": "东财沪深港通 · 季度持股 + 每日十大成交活跃股（免 key）",
        "requires_key": False,
        "empty_label": "无披露记录",
        "note": "个股每日北向净买额自 2024-08-19 起交易所不再披露（港交所：持股明细改为季度），"
        "本页改用「季度持股快照」看外资还剩多少，并用「十大成交活跃股」补当日活跃度",
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

#: 两融明细表里最新交易日（「截至哪天」要写进结论）；进程内缓存 6 小时。
_MARGIN_ASOF: dict[str, Any] = {"date": None, "ts": 0.0}
_MARGIN_ASOF_TTL = 6 * 3600


def _margin_asof(today: _dt.date) -> Optional[str]:
    """东财两融个股明细的最新交易日 —— 用来把「截至哪天」写进「是不是标的」的结论。"""
    now = _dt.datetime.now().timestamp()
    if _MARGIN_ASOF["date"] and now - _MARGIN_ASOF["ts"] < _MARGIN_ASOF_TTL:
        return _MARGIN_ASOF["date"]
    try:
        payload = _get_json(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            {
                "reportName": "RPTA_WEB_RZRQ_GGMX",
                "columns": "SCODE,DATE",
                "pageNumber": 1,
                "pageSize": 1,
                "sortColumns": "DATE",
                "sortTypes": -1,
                "source": "WEB",
                "client": "WEB",
            },
            referer="https://data.eastmoney.com/rzrq/",
        )
        rows = ((payload or {}).get("result") or {}).get("data") or []
        date = (rows[0].get("DATE") or "")[:10] if rows else None
    except Exception as exc:  # noqa: BLE001
        logger.warning("取两融最新日期失败：%s", exc)
        date = None
    if date:
        _MARGIN_ASOF.update({"date": date, "ts": now})
    return date or (today.isoformat() if not _MARGIN_ASOF["date"] else _MARGIN_ASOF["date"])


def load_margin(code: str) -> dict[str, Any]:
    """个股最新两融数据（东财 ``RPTA_WEB_RZRQ_GGMX``）。金额单位：元。

    「是不是两融标的」给**确定结论**，不再写「可能不是」
    ------------------------------------------------
    这张表**只装两融标的的逐日明细**：标的停牌只是当天没有新行，历史行仍在。所以
    「按代码查全历史零记录」可以判定为「从未纳入两融标的」，而不是接口没取到。
    实测 002196 方正电机：全历史 0 行，当日 4489 只标的名单里也没有它 → 确定为「否」。

    反过来的边界也标出来：有历史行、但最新一行落后于全市场最新交易日（>5 天），
    只说明「之后没有新数据」（可能停牌或已调出），不擅自断言「已调出」。
    """
    today = _dt.date.today()
    try:
        payload = _get_json(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            {
                "reportName": "RPTA_WEB_RZRQ_GGMX",
                "columns": "ALL",
                "pageNumber": 1,
                "pageSize": 5,
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
        return {"available": False, "is_target": None, "reason": f"两融接口不可用：{exc}"}

    rows = ((payload or {}).get("result") or {}).get("data") or []
    if not rows:
        asof = _margin_asof(today)
        return {
            "available": False,
            "is_target": False,
            "empty": True,
            "reason": f"该股不在两融标的名单（东财两融明细全历史无记录，截至 {asof}）",
        }

    row = rows[0]
    latest = (row.get("DATE") or "")[:10]
    out: dict[str, Any] = {
        "available": True,
        "is_target": True,
        "date": latest,
        "financing_balance": row.get("RZYE"),
        "financing_buy": row.get("RZMRE"),
        "lending_balance": row.get("RQYE"),
        "total_balance": row.get("RZRQYE"),
    }
    asof = _margin_asof(today)
    if asof and latest and latest < asof:
        try:
            gap = (_dt.date.fromisoformat(asof) - _dt.date.fromisoformat(latest)).days
        except ValueError:
            gap = 0
        if gap > 5:
            out["stale_days"] = gap
            out["note"] = (
                f"最近一次两融明细是 {latest}，比全市场最新交易日 {asof} 落后 {gap} 天"
                "（可能停牌，也可能已调出标的名单；不能断定是哪一种）"
            )
    return out


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


def load_forecast(code: str) -> dict[str, Any]:
    """东财 F10「机构评级 / 盈利预测」（免费、免 key）—— 研报库零覆盖时的兜底。

    为什么需要它：研报库（``reportapi``）只装**已发布的研报文章**。小盘股经常是
    「一篇报告都没有，但仍有券商在 F10 里给评级/盈利预测」。只看研报库就会得出
    「无机构覆盖」，把「没有文章」错当成「没有券商观点」。

    实测 600519：评级机构 30 家（买入 23 / 增持 7）、综合评级「买入」；
    002196 方正电机：``pjtj``/``jgyc`` 同时为空 → 这才是真正没有券商覆盖。
    """
    url = (
        "https://emweb.securities.eastmoney.com/PC_HSF10/ProfitForecast/PageAjax"
        f"?code={_market_prefix(code)}{code}"
    )
    try:
        payload = _get_json(url, {}, referer="https://emweb.securities.eastmoney.com/")
    except Exception as exc:  # noqa: BLE001
        logger.warning("取机构预测失败 %s：%s", code, exc)
        return {"available": False, "reason": f"机构预测接口不可用：{exc}"}

    stats = (payload or {}).get("pjtj") or []
    detail = (payload or {}).get("jgyc") or []
    if not stats and not detail:
        return {
            "available": False,
            "empty": True,
            "reason": "研报库与机构预测库都没有覆盖记录",
        }

    stat = stats[0] if stats else {}
    avg = next(
        (row for row in detail if str(row.get("ORG_NAME_ABBR") or "") == "近六月平均"),
        None,
    )
    orgs = sorted(
        {
            str(row.get("ORG_NAME_ABBR"))
            for row in detail
            if row.get("ORG_NAME_ABBR") and row.get("ORG_NAME_ABBR") != "近六月平均"
        }
    )
    # 盈利预测：取近六月平均那一行，按「今年/明年」给 EPS 与 PE
    estimates = []
    if avg:
        for idx in (1, 2, 3):
            year = avg.get(f"YEAR{idx}")
            if not year:
                continue
            estimates.append(
                {
                    "year": year,
                    "mark": avg.get(f"YEAR_MARK{idx}"),
                    "eps": _float(avg.get(f"EPS{idx}")),
                    "pe": _float(avg.get(f"PE{idx}")),
                }
            )
    return {
        "available": True,
        "window": stat.get("DATE_TYPE") or "近一月",
        "rating": stat.get("COMPRE_RATING"),
        "score": _float(stat.get("COMPRE_RATING_NUM")),
        "org_num": stat.get("RATING_ORG_NUM"),
        "buy_num": stat.get("RATING_BUY_NUM"),
        "add_num": stat.get("RATING_ADD_NUM"),
        "neutral_num": stat.get("RATING_NEUTRAL_NUM"),
        "reduce_num": stat.get("RATING_REDUCE_NUM"),
        "sale_num": stat.get("RATING_SALE_NUM"),
        "estimates": estimates,
        "orgs": orgs[:8],
        "org_count": len(orgs),
    }


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
        # 研报库空 ≠ 没有券商观点：再看 F10 机构评级/盈利预测，两边都空才是「真无覆盖」。
        forecast = load_forecast(code)
        if forecast.get("available"):
            return {
                "available": True,
                "window_years": 3,
                "hits": 0,
                "items": [],
                "ratings": {},
                "newest_age_days": None,
                "forecast": forecast,
                "channel": "机构评级统计（东财 F10）",
                "reason": "研报库近三年无文章，改用东财 F10 的机构评级/盈利预测",
            }
        return {
            "available": False,
            "empty": True,
            "reason": "近三年无券商覆盖（研报库 0 篇、机构预测库 0 条，已核实的空结果）",
        }

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


# ── 北向资金：季度持股 + 十大成交活跃股 ──────────────────────────────────


def _market_prefix(code: str) -> str:
    """6 位代码 → 交易所前缀（沪 6/9、深 0/3、北 4/8）。"""
    if code.startswith(("6", "9")):
        return "SH"
    if code.startswith(("4", "8")):
        return "BJ"
    return "SZ"


def load_northbound_holding(code: str) -> dict[str, Any]:
    """北向**季度持股**（东财 ``RPT_MUTUAL_HOLDSTOCKNORTH_STA``，免费、免 key）。

    2024-08-19 之后港交所把北向持股明细改成按季度披露，所以这里只有最近一个季末
    的持股快照（实测截至 2026-09-30）。它回答的是「外资还拿着多少」，不回答
    「昨天买了多少」。有这条，绝大多数票就不再是「未配置」。
    """
    try:
        payload = _get_json(
            "https://datacenter-web.eastmoney.com/api/data/v1/get",
            {
                "reportName": "RPT_MUTUAL_HOLDSTOCKNORTH_STA",
                "columns": "ALL",
                "pageNumber": 1,
                "pageSize": 1,
                "sortColumns": "TRADE_DATE",
                "sortTypes": -1,
                "source": "WEB",
                "client": "WEB",
                "filter": f'(SECURITY_CODE="{code}")',
            },
            referer="https://data.eastmoney.com/hsgtcg/",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("取北向持股失败 %s：%s", code, exc)
        return {"available": False, "reason": f"北向持股接口不可用：{exc}"}

    rows = ((payload or {}).get("result") or {}).get("data") or []
    if not rows:
        return {"available": False, "empty": True, "reason": "没有北向持股披露记录"}
    row = rows[0]
    return {
        "available": True,
        "date": str(row.get("TRADE_DATE") or "")[:10],
        "hold_shares": row.get("HOLD_SHARES"),
        "hold_market_cap": row.get("HOLD_MARKET_CAP"),
        # 占流通股比 / 占总股本比：两个都给，提示词里用的是流通股比
        "float_ratio": row.get("FREE_SHARES_RATIO"),
        "total_ratio": row.get("TOTAL_SHARES_RATIO"),
        "quarterly": True,
    }


def load_northbound(code: str, limit: int = 10, lookback_days: int = 60) -> dict[str, Any]:
    """北向资金：**季度持股快照** + 每日十大成交活跃股（两块都免费、免 key）。

    为什么不是「北向净买额」
    ------------------------
    港交所明示：自 2024-08-19 起沪深港通北向**持股明细改为按季度披露**，逐日个股
    净买额也随之停止——这个字段在免费源里已经不存在了，不是接入问题。能拿到的两块：

    1. 季度持股（``load_northbound_holding``）：外资还持有多少股、占流通股几成；
    2. 十大成交活跃股（``RPT_MUTUAL_TOP10DEAL``）：当日北向买卖有多活跃。

    合并口径：只要**持股快照**取到就算「已接入」（绝大多数票都有），十大活跃股是
    加分项。「没进前十」不再是数据缺口，只在提示词里注明「近 60 天未进前十」。
    """
    holding = load_northbound_holding(code)
    today = _dt.date.today()
    begin = today - _dt.timedelta(days=lookback_days)
    items: list[dict[str, Any]] = []
    top_error: Optional[str] = None
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
        rows = ((payload or {}).get("result") or {}).get("data") or []
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
    except Exception as exc:  # noqa: BLE001
        logger.warning("取北向活跃股失败 %s：%s", code, exc)
        top_error = f"北向活跃股接口不可用：{exc}"

    if holding.get("available"):
        return {
            "available": True,
            "holding": holding,
            "appearances": len(items),
            "latest": items[0] if items else None,
            "items": items,
            "empty": not items,
            "note": (
                None
                if items
                else f"近 {lookback_days} 天没有进入北向十大成交活跃股（不影响季度持股口径）"
            ),
            "top_error": top_error,
        }

    if items:  # 持股快照缺失但活跃股命中（少见）
        return {
            "available": True,
            "holding": None,
            "appearances": len(items),
            "latest": items[0],
            "items": items,
            "note": holding.get("reason"),
        }

    return {
        "available": False,
        "empty": True,
        "reason": holding.get("reason") or top_error or f"近 {lookback_days} 天没有进入北向十大成交活跃股",
        "note": "个股每日北向净买额自 2024-08-19 起不再披露；未上榜不代表外资在卖出",
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

