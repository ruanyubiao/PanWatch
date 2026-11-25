"""模型预测快照：报告生成时把这只票当日的预测名次一起存下来。

为什么要存而不是页面现取
----------------------
预测每天 17:00 同步后算一次，名次天天变。报告是一周前的那份，页面上如果现取
「最新名次」，就是拿今天的排名去解释一周前的结论 —— 两个时点混在一起，而且
旧报告会自己「变化」。所以存一份进 ``details.prediction``，页面显示时带上它
自己的 ``trade_date``。

只存事实，不存解读
----------------
``rank_no`` / ``universe`` / ``pct`` / ``model_version`` 都是库里的原值；
「是否落在前 10% 有效区」由前端按 ``pct >= 90`` 现算 —— 阈值将来要调的话改一处，
不用重跑历史报告。

失败不拖累分析
------------
预测表是可选依赖（表还没建、当天没跑推理、只读账号没权限）。任何异常都收成
``available=False`` + 原因，绝不让一次分析因为预测表而失败。
"""

from __future__ import annotations

import datetime as _dt
import logging
from typing import Any

logger = logging.getLogger(__name__)


def snapshot(code: str) -> dict[str, Any]:
    """该标的最近一条预测 → 可落库的块。没有记录时 ``available=False``。"""
    try:
        from ..fork_predict import data as predict_data

        info = predict_data.load_stock(code, days=1)
    except Exception as exc:  # noqa: BLE001 - 预测表是可选依赖
        logger.debug("预测快照读取失败 %s：%s", code, exc)
        return {
            "available": False,
            "code": code,
            "reason": f"预测库读取失败：{type(exc).__name__}",
            "captured_at": _now(),
        }

    if not info:
        return {
            "available": False,
            "code": code,
            "reason": "预测表里还没有这只票的记录（可能不在股票池内，或当天推理还没跑）",
            "captured_at": _now(),
        }

    return {
        "available": True,
        "code": code,
        "trade_date": info.get("trade_date"),
        "rank_no": info.get("rank_no"),
        "universe": info.get("universe"),
        "pct": info.get("pct"),
        "score": info.get("score"),
        "model_version": info.get("model_version"),
        "scored_at": info.get("scored_at"),
        "captured_at": _now(),
    }


def _now() -> str:
    return _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
