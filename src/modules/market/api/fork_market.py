"""fork 专用：A 股全市场行情表（分析页的表格数据源）。

背景（为什么必须有这个接口）
--------------------------
上游的「持仓 / 关注」页只认识自选里的股票，行情走 ``POST /api/quotes/batch``、
技术面走 ``POST /api/klines/summary/batch`` —— 两者都要**打外网**。fork 的分析页
要看**全市场**（实测 5574 只），每翻一页 100 只就是一次外网批量请求，实测被数据源
限流/屏蔽（症状：用户说「查外网次数太多被屏蔽了」）。

所以全市场一律读**自建的 A 股数据仓库**：与本应用同机的 MySQL（``stock`` 库，
日终由 ``/opt/stock`` 的管道写好行情、市值、技术面评分 ``tech_*``）。
本接口全市场列表**一个外网请求都不发**。

代价说清楚：表里的「现价」= 库里**最新一个交易日**的收盘价，盘中不是实时价。
响应里的 ``asof`` 就是那个交易日，前端据此标「已过期」。

凭据零复制
----------
口令唯一来源是 ``/opt/stock/.env``（systemd 里用 ``EnvironmentFile=`` 注入），
只读账户 ``STOCK_DB_RO_USER``（``GRANT SELECT ... ON stock.*``）。应用配置里
不出现第二份口令。缺变量时返回 **503 + 明确原因**，不抛栈。

放在独立文件里，只在 ``src/bootstrap/application.py`` 里加一行 ``include_router``，
不改动上游模块内部逻辑。
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import subprocess
from decimal import Decimal
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)

router = APIRouter()

# 与前端 BOARD_OPTIONS 一致（'all' 不是板块，是全集）
BOARD_KEYS = ("all", "sh", "sz", "kcb", "cyb", "st")

DEFAULT_LIMIT = 100
# 前端一次性把全市场取回去（约 5600 行）后在浏览器里筛选/排序/分页，
# 所以上限必须放得比全市场大：翻页不再打接口，也就不会出现「每翻一页 100 只」
# 那种反复请求。取 2 万是给将来扩容留的余量（A 股现存约 5600 只）。
MAX_LIMIT = 20000

# 板块判定（与前端 frontend/src/lib/board-classify.ts 同一套规则，顺序即优先级）：
#   ST > 科创 > 创业 > 上证 > 深证，其余（北交所 920xxx 等）只计入「全部」。
# 用 code（6 位纯数字）而不是 symbol —— 库里的 symbol 带 sh/sz/bj 前缀。
#
# 拆成两段（条件选股复用，见 fork_screen/repository.py）：
#   _MARKET_BOARD_CASE —— **纯代码前缀**规则，不含 ST。条件选股的市场范围按
#       这个口径判定（ST 是独立开关，不是市场），否则「选了上证但不含 ST」会把
#       ST 股整个漏掉。
#   _BOARD_CASE —— 在它外面包一层 ST 判定，表格的板块列/计数仍用这个
#       （ST 优先是刻意的：点「ST」是想单独把这批票挑出来看）。
_IS_ST_CASE = "LOCATE('ST', UPPER(REPLACE(i.name, ' ', ''))) > 0"

_MARKET_BOARD_CASE = """
    CASE
      WHEN LEFT(i.code, 3) IN ('688', '689') THEN 'kcb'
      WHEN LEFT(i.code, 3) IN ('300', '301') THEN 'cyb'
      WHEN LEFT(i.code, 2) = '60' THEN 'sh'
      WHEN LEFT(i.code, 2) = '00' OR LEFT(i.code, 3) = '302' THEN 'sz'
      ELSE 'other'
    END"""

_BOARD_CASE = f"""
    CASE
      WHEN {_IS_ST_CASE} THEN 'st'
      ELSE {_MARKET_BOARD_CASE}
    END"""

# base = 在市的 A 股，带板块标签；uni = 再贴上「最新交易日」那一行行情。
# 板块计数与列表都从 uni 出，两者口径因此必然一致（不会出现「全部 5574，翻页只有 5573」）。
_WITH_UNI = f"""
WITH base AS (
    SELECT i.code, i.symbol, i.exchange, i.name, i.total_market_cap AS info_market_cap,
           {_BOARD_CASE} AS board,
           {_MARKET_BOARD_CASE} AS market_board,
           CASE WHEN {_IS_ST_CASE} THEN 1 ELSE 0 END AS is_st
    FROM stock_info i
    WHERE i.status = 'listed'
),
latest AS (SELECT MAX(trade_date) AS asof FROM stock_daily),
uni AS (
    SELECT b.*, d.trade_date, d.open, d.high, d.low, d.close, d.pre_close,
           d.change_amount, d.change_pct, d.total_market_cap, d.circulating_market_cap,
           d.source, d.adj_factor, d.ma5, d.ma10, d.ma20, d.ma60,
           d.tech_score, d.tech_trend, d.tech_macd, d.tech_rsi, d.tech_kdj,
           d.tech_boll, d.tech_volume, d.tech_support, d.tech_resistance
    FROM base b
    JOIN stock_daily d ON d.symbol = b.symbol
    JOIN latest l ON d.trade_date = l.asof
)
"""

_COUNTS_SQL = _WITH_UNI + """
SELECT l.asof,
       COUNT(*) AS c_all,
       SUM(u.board = 'sh')  AS c_sh,
       SUM(u.board = 'sz')  AS c_sz,
       SUM(u.board = 'kcb') AS c_kcb,
       SUM(u.board = 'cyb') AS c_cyb,
       SUM(u.board = 'st')  AS c_st
FROM latest l CROSS JOIN uni u
GROUP BY l.asof
"""

_PAGE_SELECT = """
SELECT code, symbol, exchange, name, board, trade_date, open, high, low, close,
       pre_close, change_amount, change_pct, total_market_cap, info_market_cap,
       circulating_market_cap, source, adj_factor, ma5, ma10, ma20, ma60,
       tech_score, tech_trend, tech_macd, tech_rsi, tech_kdj, tech_boll,
       tech_volume, tech_support, tech_resistance
FROM uni
"""


class ForkDbUnavailable(RuntimeError):
    """MySQL 未配置或连不上 —— 端点会转成 503。"""


def _db_config() -> dict[str, Any]:
    """从环境变量读只读库凭据（systemd 的 EnvironmentFile 注入）。"""
    user = os.getenv("STOCK_DB_RO_USER")
    password = os.getenv("STOCK_DB_RO_PASSWORD")
    if not user or password is None:
        raise ForkDbUnavailable(
            "未配置只读行情库：需要环境变量 STOCK_DB_RO_USER / STOCK_DB_RO_PASSWORD"
            "（来源 /opt/stock/.env，由 systemd 的 EnvironmentFile 注入）"
        )
    raw_port = os.getenv("STOCK_DB_PORT") or "3306"
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise ForkDbUnavailable(f"STOCK_DB_PORT 不是合法端口：{raw_port}") from exc
    return {
        "host": os.getenv("STOCK_DB_HOST") or "127.0.0.1",
        "port": port,
        "user": user,
        "password": password,
        "database": os.getenv("STOCK_DB_NAME") or "stock",
        "charset": "utf8mb4",
    }


def _connect() -> Any:
    """新建一条 MySQL 连接。pymysql 延迟导入：它是 fork 的额外依赖（deploy 里装）。"""
    try:
        import pymysql
        from pymysql.cursors import DictCursor
    except ImportError as exc:  # pragma: no cover - 只在漏装依赖时命中
        raise ForkDbUnavailable(
            "缺少 MySQL 驱动 pymysql，请执行 deploy/01-install-deps.sh（uv pip install pymysql）"
        ) from exc
    try:
        return pymysql.connect(
            cursorclass=DictCursor,
            connect_timeout=5,
            read_timeout=60,
            write_timeout=30,
            **_db_config(),
        )
    except ForkDbUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 连不上时给明确原因而不是栈
        raise ForkDbUnavailable(f"连接行情库失败：{exc}") from exc


def _queries(statements: list[tuple[str, dict[str, Any] | None]]) -> list[list[dict[str, Any]]]:
    """同一条连接上顺序执行多条只读查询。

    行情表一次请求原来要连三次库（计数、总数、分页）。全市场扫描不便宜，
    合并到一条连接上，避免把连接数和握手开销放大三倍。

    SQL 文本里**不出现字面 ``%`` 号**（板块判定用 LEFT()/LOCATE()，不用 LIKE 通配符），
    因为 pymysql 在 ``args is not None`` 时会做 ``query % args``，字面 % 会被当格式符打爆。
    """
    conn = _connect()
    try:
        results: list[list[dict[str, Any]]] = []
        with conn.cursor() as cursor:
            for sql, params in statements:
                cursor.execute(sql, params or {})
                results.append(list(cursor.fetchall() or []))
        return results
    except ForkDbUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 查库失败时给明确原因而不是栈
        raise ForkDbUnavailable(f"查询行情库失败：{exc}") from exc
    finally:
        conn.close()


def _query(sql: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """执行一条只读查询，返回 list[dict]。"""
    return _queries([(sql, params)])[0]


# ---------------------------------------------------------------- 纯函数（可单测）

def build_where(board: str, q: str) -> tuple[str, dict[str, Any]]:
    """拼 WHERE 子句与参数（分页查询与计数查询共用，保证 `total` 与列表同口径）。"""
    where = ["1 = 1"]
    params: dict[str, Any] = {}
    if board in BOARD_KEYS and board != "all":
        where.append("board = %(board)s")
        params["board"] = board
    needle = (q or "").strip()
    if needle:
        # 用 LOCATE 而不是 LIKE：SQL 里因此不出现字面 % 号，pymysql 的参数插值
        # （query % args）不会误伤 LIKE 的通配符。
        where.append("(LOCATE(%(needle)s, code) > 0 OR LOCATE(%(needle)s, name) > 0)")
        params["needle"] = needle
    return " AND ".join(where), params


def build_page_sql(board: str, q: str) -> tuple[str, dict[str, Any]]:
    """拼分页查询与它的参数（不含 LIMIT/OFFSET —— 那两个在端点里单独给）。"""
    where_sql, params = build_where(board, q)
    return _WITH_UNI + _PAGE_SELECT + " WHERE " + where_sql + " ORDER BY code", params


def build_total_sql(board: str, q: str) -> tuple[str, dict[str, Any]]:
    """拼计数查询：与分页查询同一套 WHERE，口径不会漂。"""
    where_sql, params = build_where(board, q)
    return _WITH_UNI + "SELECT COUNT(*) AS total FROM uni WHERE " + where_sql, params


def _f(value: Any) -> float | None:
    """Decimal / int / None → float / None（JSON 里统一成数字）。"""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def map_row(row: dict[str, Any]) -> dict[str, Any]:
    """库行 → 响应条目。

    **复权口径**：``ma5..ma250`` 与 ``tech_support`` / ``tech_resistance`` 都是
    **后复权空间**的值（``close_adj = close × adj_factor``，管道按 close_adj 算），
    而 ``close`` / ``high`` / ``low`` 是不复权价。直接并列显示会出现「ma5 比现价高
    一大截」的假象（实测有票 adj_factor 到 58348）。两者除以 ``adj_factor`` 就回到
    不复权空间 —— 打分与状态字符串只依赖比值，缩放不影响结论，所以这一步只动显示。

    ``tech_*`` 整组为 NULL（新股、历史不足 120 根，实测最新交易日 97/5574）时
    返回 ``None``，前端显示「数据不足」而不是喂 0（0 分会被当成「观望」这个结论）。
    """
    raw_factor = _f(row.get("adj_factor"))
    # 0 会除零；负数会把均线/支撑翻到价格的另一侧。两者都按「没有复权因子」处理。
    fq = raw_factor if raw_factor and raw_factor > 0 else 1.0

    def adjusted(value: Any) -> float | None:
        raw = _f(value)
        return None if raw is None else round(raw / fq, 4)

    score = row.get("tech_score")
    tech = None
    if score is not None:
        tech = {
            "score": int(score),
            "trend": row.get("tech_trend"),
            "macd": row.get("tech_macd"),
            "rsi": row.get("tech_rsi"),
            "kdj": row.get("tech_kdj"),
            "boll": row.get("tech_boll"),
            "volume": row.get("tech_volume"),
            "support": adjusted(row.get("tech_support")),
            "resistance": adjusted(row.get("tech_resistance")),
        }

    market_cap = row.get("total_market_cap")
    if market_cap is None:
        market_cap = row.get("info_market_cap")

    return {
        "code": row.get("code"),
        "symbol": row.get("symbol"),
        "exchange": row.get("exchange"),
        "name": row.get("name"),
        "board": row.get("board"),
        "trade_date": str(row.get("trade_date")) if row.get("trade_date") is not None else None,
        "pre_close": _f(row.get("pre_close")),
        "open": _f(row.get("open")),
        "close": _f(row.get("close")),
        "high": _f(row.get("high")),
        "low": _f(row.get("low")),
        "change_amount": _f(row.get("change_amount")),
        "change_pct": _f(row.get("change_pct")),
        "total_market_cap": _f(market_cap),
        "source": row.get("source"),
        "adj_factor": fq,
        "ma": {
            "ma5": adjusted(row.get("ma5")),
            "ma10": adjusted(row.get("ma10")),
            "ma20": adjusted(row.get("ma20")),
            "ma60": adjusted(row.get("ma60")),
        },
        "tech": tech,
    }


# ---------------------------------------------------------------------- 端点

@router.get("/market-table")
def market_table(
    board: str = Query("all", description="all/sh/sz/kcb/cyb/st"),
    q: str = Query("", description="代码或名称片段"),
    offset: int = Query(0, ge=0),
    limit: int = Query(DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
) -> dict[str, Any]:
    """A 股全市场行情表（分页），行情与技术面全部来自本机 MySQL，不打外网。"""
    board_key = board if board in BOARD_KEYS else "all"

    # 前端全市场一次取回（board=all 且无关键词）时，总数就是计数查询里的 c_all，
    # 不必再扫一遍 uni。带板块或关键词时才单独 COUNT，保证和分页同一套 WHERE。
    filtered = board_key != "all" or bool((q or "").strip())
    statements: list[tuple[str, dict[str, Any] | None]] = [(_COUNTS_SQL, None)]
    if filtered:
        statements.append(build_total_sql(board_key, q))
    page_sql, page_params = build_page_sql(board_key, q)
    statements.append((
        page_sql + " LIMIT %(limit)s OFFSET %(offset)s",
        {**page_params, "limit": limit, "offset": offset},
    ))

    try:
        results = _queries(statements)
    except ForkDbUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    count_rows = results[0]
    total_rows = results[1] if filtered else []
    rows = results[-1]
    counts_row = count_rows[0] if count_rows else {}
    counts = {
        "all": int(counts_row.get("c_all") or 0),
        "sh": int(counts_row.get("c_sh") or 0),
        "sz": int(counts_row.get("c_sz") or 0),
        "kcb": int(counts_row.get("c_kcb") or 0),
        "cyb": int(counts_row.get("c_cyb") or 0),
        "st": int(counts_row.get("c_st") or 0),
    }
    asof = counts_row.get("asof")
    total = int(total_rows[0].get("total") or 0) if total_rows else counts["all"]

    return {
        "asof": str(asof) if asof is not None else None,
        "total": total,
        "offset": offset,
        "limit": limit,
        "counts": counts,
        "items": [map_row(row) for row in rows],
    }


# ---------------------------------------------------------------------- 构建信息

# 分析页筛选行右端要显示「代码最新版本 / 提交时间」（用户要求），所以得把
# 「这份代码是哪次提交」暴露给前端。云端是**源码部署**：``deploy/10-publish.sh``
# 把仓库内容铺到 ``/opt/PanWatch/app`` 时排除了 ``.git``，所以服务器上问不到 git。
# 三级回退，任一级给出答案即可（都拿不到就返回空字段，前端整块隐藏 ——
# 一行元信息不值得让页面挂掉）：
#   1) 部署脚本写下的 ``BUILD_INFO.json``（服务器上唯一可靠来源）
#   2) 环境变量 ``APP_GIT_SHA`` / ``APP_GIT_BRANCH`` / ``APP_GIT_COMMIT_TIME``
#   3) 本机工作副本有 ``.git`` 时直接问 git（开发与本地验证实例走这条）
_REPO_ROOT = Path(__file__).resolve().parents[4]
_BUILD_INFO_FILE = _REPO_ROOT / "BUILD_INFO.json"


def _build_from_file() -> dict[str, Any]:
    try:
        data = json.loads(_BUILD_INFO_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _build_from_git() -> dict[str, Any]:
    def git(*args: str) -> str:
        try:
            result = subprocess.run(
                ["git", "-C", str(_REPO_ROOT), *args],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        return result.stdout.strip() if result.returncode == 0 else ""

    sha = git("rev-parse", "--short=8", "HEAD")
    if not sha:
        return {}
    return {
        "sha": sha,
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "commit_time": git("log", "-1", "--format=%cI"),
    }


@lru_cache(maxsize=1)
def build_info() -> dict[str, Any]:
    """这份代码的版本信息：sha / branch / commit_time / published_at。"""
    data: dict[str, Any] = dict(_build_from_git())
    # 部署时写下的文件比本地 .git 更权威（服务器上根本没有 .git）
    data.update(_build_from_file())
    for key, env in (
        ("sha", "APP_GIT_SHA"),
        ("branch", "APP_GIT_BRANCH"),
        ("commit_time", "APP_GIT_COMMIT_TIME"),
    ):
        value = os.getenv(env)
        if value:
            data[key] = value

    def text(key: str) -> str:
        return str(data.get(key) or "").strip()

    return {
        "sha": text("sha"),
        "branch": text("branch"),
        "commit_time": text("commit_time") or None,
        "published_at": text("published_at") or None,
    }


# ---------------------------------------------------------------------- 数据同步时间

# 分析页那行右端第一项「数据时间」：**股票数据最后一次同步的时刻**，来自管道自己
# 写的 ``sync_log``（日终 /opt/stock 管道每跑一个作业落一行）。取 ``stock_daily``
# 最后一条成功记录 —— 行情表就是由它灌进来的，别的作业（stock_info / stock_status）
# 早几十秒，按它们算会显示成「数据时间比行情还早」这种看不懂的东西。
#
# 兜底：sync_log 不可用（老库没这张表 / 只读账户没授权）时退回
# ``MAX(trade_date)`` —— 有索引，毫秒级返回。
# **不要**退回 ``MAX(updated_at)``：那是「这批行情行最后被写库的时刻」，语义最接近，
# 但 ``updated_at`` 没有索引、表 1600 万行，实测 150s 都不返回，请求会卡到
# pymysql 的 read_timeout=60 再被 except 吞掉（页面不挂，但明显卡一下）。
# 代价是兜底时只有交易日、没有具体时刻，``data_synced_at`` 留空 —— 宁可少一项，
# 也不拿交易日伪造一个 00:00:00 的时刻。
_LAST_SYNC_SQL = """
SELECT finished_at, trade_date
FROM sync_log
WHERE job = %(job)s AND status = 'success' AND finished_at IS NOT NULL
ORDER BY finished_at DESC, id DESC
LIMIT 1
"""

_LAST_SYNC_FALLBACK_SQL = """
SELECT MAX(trade_date) AS trade_date
FROM stock_daily
"""


def _local_offset_suffix() -> str:
    """本机时区偏移（如 ``+08:00``）。库里存的是无时区的 DATETIME（MySQL SYSTEM=本机时区），
    前端要「本地时间」，所以序列化时把偏移带上，浏览器才不会按 UTC 猜。"""
    offset = _dt.datetime.now().astimezone().utcoffset() or _dt.timedelta(0)
    total = int(offset.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    return f"{sign}{total // 3600:02d}:{total % 3600 // 60:02d}"


def _iso_local(value: Any) -> str | None:
    """datetime → 带本机偏移的 ISO 串；已经是字符串的按原样返回（带 T 就补偏移）。"""
    if value is None:
        return None
    if isinstance(value, _dt.datetime):
        return value.strftime("%Y-%m-%dT%H:%M:%S") + _local_offset_suffix()
    text = str(value).strip()
    return text or None


def _date_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.strftime("%Y-%m-%d")
    text = str(value).strip()
    return text[:10] or None


def data_sync_info() -> dict[str, Any]:
    """行情库最后一次同步：``data_synced_at``（ISO，本机时区）+ ``data_trade_date``。

    任何异常都吞掉并返回两个 None —— 这行元信息是给人对版本/对数据用的，
    不能因为它把页面打挂，也不能顺带把版本信息一起弄丢。
    """
    row: dict[str, Any] = {}
    try:
        rows = _query(_LAST_SYNC_SQL, {"job": "stock_daily"})
        row = rows[0] if rows else {}
    except Exception as exc:  # noqa: BLE001 - 见 docstring
        logger.debug("读 sync_log 失败，退回 stock_daily.trade_date：%s", exc)
        row = {}
    if row.get("finished_at") is None:
        try:
            rows = _query(_LAST_SYNC_FALLBACK_SQL)
            row = rows[0] if rows else {}
        except Exception as exc:  # noqa: BLE001
            logger.debug("读行情库同步时间失败：%s", exc)
            row = {}
    return {
        "data_synced_at": _iso_local(row.get("finished_at")),
        "data_trade_date": _date_text(row.get("trade_date")),
    }


@router.get("/market-meta")
def market_meta() -> dict[str, Any]:
    """分析页那行元信息：数据时间 + 代码版本 + 提交时间。

    「数据时间」= 行情库最后一次同步的时刻（``sync_log`` 里 ``stock_daily`` 的
    最后一条成功记录），不是页面载入时间 —— 用户要的是**股票数据是哪次同步的**。
    查库失败时这两项留空（版本信息仍然要能显示，不该被数据库拖下水）。
    """
    return {**build_info(), **data_sync_info()}
