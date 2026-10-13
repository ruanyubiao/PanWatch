"""fork 专用：A 股全市场目录接口（浏览 / 板块筛选）。

上游只有 ``GET /stocks/search``：必须有关键词、最多 20 条结果，没有「列出全
市场」的接口。fork 的「全部 / 上证 / 深证 / 科创 / 创业 / ST」浏览需要它。

放在独立文件里，仅在 ``src/bootstrap/application.py`` 里加一行
``include_router``，不改动上游模块内部逻辑，降低 merge upstream 成本。

板块判定必须与前端 ``frontend/src/lib/board-classify.ts`` 保持一致：
    ST > 科创 > 创业 > 上证 > 深证，其余（北交所等）只计入「全部」。
优先级刻意如此：ST 是风险标记，用户点「ST」是想把这批票单独挑出来看。
"""

from fastapi import APIRouter, Query

from src.platform.marketdata.stock_list import get_stock_list

router = APIRouter()

# 与前端 BOARD_OPTIONS 一致（'all' 不是板块，是全集）
BOARD_KEYS = ("all", "sh", "sz", "kcb", "cyb", "st")


def _is_st(name: str) -> bool:
    """名称含 ST 即视为 ST（覆盖 *ST / SST / S*ST 等变体）。"""
    return "ST" in (name or "").upper().replace(" ", "")


def classify_board(symbol: str, name: str, asset_type: str) -> str:
    """返回板块 key；非 A 股或无法归类返回 'other'（只计入 all）。"""
    if asset_type == "etf":
        return "etf"
    if _is_st(name):
        return "st"
    if symbol.startswith(("688", "689")):
        return "kcb"
    if symbol.startswith(("300", "301")):
        return "cyb"
    if symbol.startswith("60"):
        return "sh"
    if symbol.startswith(("00", "302")):
        return "sz"
    return "other"


# 交易所上市 A 股的代码前缀。东部财富的 CN 目录把新三板(400/420/43x/83x/87x)
# 也一并返回（实测约 6600 条，是非上市挂牌公司，不是 A 股），必须挡掉，
# 否则「全部」会虚高一倍。北交所新代码 920xxx 保留（它属于 A 股，但没有对应 pill）。
A_SHARE_PREFIXES = ("60", "68", "00", "30", "920")


def _is_delisted(name: str) -> bool:
    """退市/终止上市标的：名称形如「退市XX」「XX退」或前缀 PT（实测 159 只）。"""
    upper = (name or "").upper().strip()
    return upper.startswith("PT") or upper.startswith("退市") or upper.endswith("退")


def _fork_universe() -> list[dict]:
    """A 股非 ETF、非退市标的（fork 的「全部」范围）。"""
    rows: list[dict] = []
    for item in get_stock_list() or []:
        if item.get("market") != "CN":
            continue
        symbol = str(item.get("symbol") or "").strip()
        name = str(item.get("name") or "")
        if not symbol or not symbol.startswith(A_SHARE_PREFIXES):
            continue
        asset_type = str(item.get("asset_type") or "stock").lower()
        if asset_type == "etf":
            continue  # fork: ETF 不参与本页
        if _is_delisted(name):
            continue  # fork: 退市/PT 标的没有意义，不占列表
        rows.append(
            {
                "symbol": symbol,
                "name": name,
                "market": "CN",
                "asset_type": "stock",
                "board": classify_board(symbol, name, asset_type),
            }
        )
    return rows


@router.get("/catalog")
def stock_catalog(
    board: str = Query("all", description="all/sh/sz/kcb/cyb/st"),
    q: str = Query("", description="代码或名称片段"),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
):
    """分页返回 A 股全市场目录，并给出各板块的总数（供前端 pill 上显示）。"""
    rows = _fork_universe()

    counts = {key: 0 for key in BOARD_KEYS}
    for row in rows:
        counts["all"] += 1
        if row["board"] in counts:
            counts[row["board"]] += 1

    board_key = board if board in BOARD_KEYS else "all"
    if board_key != "all":
        rows = [row for row in rows if row["board"] == board_key]

    needle = q.strip().lower()
    if needle:
        rows = [row for row in rows if needle in row["symbol"].lower() or needle in row["name"].lower()]

    rows.sort(key=lambda row: row["symbol"])
    total = len(rows)
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "counts": counts,
        "items": rows[offset : offset + limit],
    }
