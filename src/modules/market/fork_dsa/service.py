"""编排：取数 → 拼提示词 → 调模型 → 解析 → 落库。

为什么在后台线程里跑
--------------------
一次分析要打 3 个外网接口 + 一次大模型（实测 1~3 分钟）。DSA 自己也是
``async_mode`` + 轮询，这里照抄这个交互：接口立刻返回 ``report_id``，页面按
``status`` 轮询。线程里自己开 DB session —— SQLAlchemy 的 session 不能跨线程用。

模型选择
--------
``get_configured_failover_client(db, model_id)``：model_id 为空时取库里的默认模型，
与助手/组合页共用同一套「主模型 + 备选」链路。**不新拉 key**，也不写应用库。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Optional

from . import data, prompt as prompt_mod, schema, sources, store

logger = logging.getLogger(__name__)


def _collect(symbol: str, name: Optional[str]) -> dict[str, Any]:
    """取齐所有数据，返回 (snapshot, boards, flow, news, limitations)。"""
    limitations: list[str] = []
    snapshot = data.load_market_snapshot(symbol)
    if not snapshot.get("available"):
        raise data.MarketDataUnavailable(snapshot.get("reason") or "行情数据不可用")

    boards = data.load_boards(symbol)
    if not boards.get("available"):
        limitations.append("板块归属未纳入（东财板块接口不可用）")

    flow = data.load_capital_flow(symbol)
    if not flow.get("available"):
        limitations.append("主力资金流未纳入（东财资金流接口不可用）")

    news = data.load_news(snapshot.get("name") or name or symbol)
    if not news.get("available"):
        limitations.append("新闻面未纳入（东财新闻搜索无结果或不可用）")

    # 消息面 / 杠杆面：全部免费免 key（财联社用网页签名，不是账号密钥）。
    # 每一块都是尽力而为，取不到就进 limitations，绝不用空字符串冒充「已查」。
    announcements = sources.load_announcements(symbol)
    if not announcements.get("available"):
        limitations.append(f"公司公告未纳入（{announcements.get('reason') or '无公告'}）")

    margin = sources.load_margin(symbol)
    if not margin.get("available"):
        limitations.append(f"融资融券未纳入（{margin.get('reason') or '无两融数据'}）")

    flash = sources.load_flash_news(snapshot.get("name") or name)
    if not flash.get("available"):
        limitations.append(f"7×24 快讯未纳入（{flash.get('reason') or '无快讯'}）")

    # 卖方观点 / 资金异动 / 讨论热度：三块都免 key，「零条」是正常结果而不是故障，
    # 但两种情形在 limitations 里要能区分开（无覆盖 vs 接口挂了）。
    research = sources.load_research(symbol)
    if not research.get("available"):
        limitations.append(f"机构研报未纳入（{research.get('reason') or '无研报'}）")

    billboard = sources.load_billboard(symbol)
    if not billboard.get("available"):
        limitations.append(f"龙虎榜未纳入（{billboard.get('reason') or '无上榜记录'}）")

    popularity = sources.load_popularity(symbol)
    if not popularity.get("available"):
        limitations.append(f"人气排名未纳入（{popularity.get('reason') or '无排名'}）")

    phase = data.market_phase()
    if phase.get("calendar") == "approx":
        limitations.append("交易日历不可用（行情库与指数快照都没取到），市场阶段按工作日近似")

    for key, label in (
        ("ma20", "MA20"),
        ("ma60", "MA60"),
        ("pe_ttm", "PE(TTM)"),
        ("turnover_rate", "换手率"),
    ):
        if snapshot.get(key) is None:
            limitations.append(f"{label} 缺失（新股或历史数据不足）")
    if not (snapshot.get("tech") or {}).get("support"):
        limitations.append("技术面支撑/压力位缺失")

    return {
        "snapshot": snapshot,
        "boards": boards,
        "flow": flow,
        "news": news,
        "announcements": announcements,
        "margin": margin,
        "flash": flash,
        "research": research,
        "billboard": billboard,
        "popularity": popularity,
        "phase": phase,
        "limitations": limitations,
        # 页面「数据源」面板要的行：每个模块一条，状态 ok / unavailable / unconfigured
        "sources": sources.module_status(
            {
                "market": True,
                "boards": bool(boards.get("available")),
                "capital_flow": bool(flow.get("available")),
                "news": bool(news.get("available")),
                "announcements": bool(announcements.get("available")),
                "margin": bool(margin.get("available")),
                "flash": bool(flash.get("available")),
                "research": bool(research.get("available")),
                "billboard": bool(billboard.get("available")),
                "popularity": bool(popularity.get("available")),
            }
        ),
    }


def _run_model(
    collected: dict[str, Any], *, db: Any, model_id: Optional[int]
) -> tuple[dict[str, Any], Optional[str]]:
    """调模型并解析；JSON 解析失败重试一次（DSA 的口径：不要静默返回半份）。"""
    from src.platform.ai.ai_failover import get_configured_failover_client

    user_prompt = prompt_mod.build_user_prompt(
        snapshot=collected["snapshot"],
        phase=collected["phase"],
        boards=collected["boards"],
        flow=collected["flow"],
        news=collected["news"],
        limitations=collected["limitations"],
        announcements=collected.get("announcements"),
        margin=collected.get("margin"),
        flash=collected.get("flash"),
        research=collected.get("research"),
        billboard=collected.get("billboard"),
        popularity=collected.get("popularity"),
    )
    client = get_configured_failover_client(db, model_id)

    async def _call(extra: str = "") -> str:
        return await client.chat(
            prompt_mod.SYSTEM_PROMPT,
            user_prompt + extra,
            temperature=0.3,
        )

    text = asyncio.run(_call())
    try:
        raw = schema.parse_llm_json(text)
    except schema.ReportParseError as exc:
        logger.warning("DSA2 首次解析失败，重试一次：%s", exc)
        retry_prompt = (
            "\n\n## 重要\n上一次输出无法解析（" + str(exc) + "）。请只输出一个合法 JSON 对象，"
            "不要代码块围栏、不要任何前后说明。"
        )
        text = asyncio.run(_call(retry_prompt))
        raw = schema.parse_llm_json(text)

    model_label = getattr(client, "used_model_label", None) or getattr(client, "model", None)
    return raw, model_label


def _worker(symbol: str, name: Optional[str], model_id: Optional[int], report_id: int) -> None:
    db = None
    try:
        from src.platform.persistence.database import SessionLocal

        db = SessionLocal()
        collected = _collect(symbol, name)
        raw, model_label = _run_model(collected, db=db, model_id=model_id)

        snapshot = collected["snapshot"]
        tags = (collected["boards"].get("tags") or []) if collected["boards"].get("available") else []
        meta = {
            "stock_code": symbol,
            "stock_name": name or snapshot.get("name"),
            "current_price": snapshot.get("price"),
            "change_pct": snapshot.get("change_pct"),
            "asof": snapshot.get("asof"),
            "created_at": store._now(),
            "market_phase": collected["phase"].get("phase"),
            "market_phase_label": collected["phase"].get("label"),
            "model_used": model_label,
            "report_type": "dsa2",
        }
        report = schema.normalize(
            raw,
            meta=meta,
            sectors=tags,
            limitations=collected["limitations"],
            fallback_name=snapshot.get("name"),
        )
        report["details"]["capital_flow"] = collected["flow"]
        report["details"]["news"] = collected["news"]
        report["details"]["announcements"] = collected.get("announcements") or {"available": False}
        report["details"]["margin"] = collected.get("margin") or {"available": False}
        report["details"]["flash"] = collected.get("flash") or {"available": False}
        report["details"]["research"] = collected.get("research") or {"available": False}
        report["details"]["billboard"] = collected.get("billboard") or {"available": False}
        report["details"]["popularity"] = collected.get("popularity") or {"available": False}
        # 数据源面板（页面渲染用）。历史报告没有这一项，前端要能容忍缺失。
        report["details"]["sources"] = collected.get("sources") or sources.module_status({})
        report["details"]["data_sources"] = [
            "本机行情库（日线/均线/技术指标）",
            "东财板块归属",
            "东财主力资金流",
            "东财新闻搜索",
            "东财公司公告",
            "东财融资融券",
            "财联社 7×24 快讯",
            "东财研报中心",
            "东财龙虎榜",
            "东财人气榜",
        ]
        store.finish(report_id, report, model_label)
    except Exception as exc:  # noqa: BLE001 - 任何失败都要落成 failed，不能留 running
        logger.exception("DSA2 分析失败 %s", symbol)
        store.fail(report_id, f"{type(exc).__name__}: {exc}")
    finally:
        if db is not None:
            db.close()


def start(symbol: str, name: Optional[str] = None, model_id: Optional[int] = None) -> dict[str, Any]:
    """起一次分析：先落 running 行，再开线程。同一只票已有 running 就复用它。"""
    existing = store.running(symbol)
    if existing:
        return existing
    report_id = store.create(symbol, name)
    thread = threading.Thread(
        target=_worker, args=(symbol, name, model_id, report_id), name=f"dsa2-{symbol}", daemon=True
    )
    thread.start()
    return store.get(report_id) or {"id": report_id, "symbol": symbol, "status": "running"}


def run_sync(symbol: str, name: Optional[str] = None, model_id: Optional[int] = None) -> dict[str, Any]:
    """同步跑一次（脚本/测试用，接口不用这个）。"""
    report_id = store.create(symbol, name)
    _worker(symbol, name, model_id, report_id)
    row = store.get(report_id)
    if not row:
        raise RuntimeError("报告写入失败")
    return row
