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
    {
        "key": "northbound",
        "label": "北向资金",
        "source": None,
        "requires_key": False,
        "note": "同花顺分时接口单位不稳定，未接入",
    },
    {
        "key": "research",
        "label": "研报 / 机构评级",
        "source": None,
        "requires_key": True,
        "note": "需付费数据源，本页不使用",
    },
    {
        "key": "social",
        "label": "社交情绪（雪球 / Reddit 等）",
        "source": None,
        "requires_key": True,
        "note": "需第三方 apikey，本页不使用",
    },
)


def module_status(availability: dict[str, bool]) -> list[dict[str, Any]]:
    """把「本次取数结果」映射成页面要的行（status: ok / unavailable / unconfigured）。"""
    rows: list[dict[str, Any]] = []
    for module in MODULE_CATALOG:
        key = module["key"]
        if not module.get("source"):
            status = "unconfigured"
        elif availability.get(key):
            status = "ok"
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
