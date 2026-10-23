"""统计分析方法 1（``stat_v1``）：口径 v4 的「条件准确率」评估。

历史
----
这是 2026-10-22 上线的那套统计（胜率 / 超额 / 盈亏比 / 分组 / 组合 / 归因 / 消融），
公式散在 ``stats.py``、``significance.py``、``costs.py``、``entry.py``、``portfolio.py``、
``attribution.py``、``health.py``、``ablation.py`` 里。用户 2026-10-23 要求「原来的统计
方案保存成 1 个文件，叫统计分析方法1」—— 这里就是那个文件：**方法 1 的唯一定义处**，
包含它的口径声明、参数、统一输出映射。算法本体仍在上面那些模块里（它们是方法 1 的
实现细节，别的功能也在用，搬进来会让 4000 行互相 import），所以本文件是「纯算法入口 +
契约适配器」，不碰 HTTP、不碰 UI。

方法 1 回答的问题
----------------
「命中之后第 N 天收盘相对信号日收盘涨了没有？和同期随机买入比好多少？」
主口径是**可执行**的：次日开盘买入、扣 0.2% 往返成本、剔除次日一字涨停买不进的行。
结论只认按交易日聚合的区间（重叠窗口会把显著性放大 3–10 倍）。
"""

from __future__ import annotations

import sqlite3
from typing import Any, Optional

from .. import significance, stats
from ..models import HORIZONS, horizons_for
from .contracts import (
    Artifact,
    Column,
    Headline,
    MethodSpec,
    ParamSpec,
    StandardReport,
    Table,
    cap_rows,
    metric,
)

METHOD = MethodSpec(
    id="stat_v1",
    name="统计分析方法 1：持有期胜率与超额",
    version="v4",
    summary=(
        "逐日回放条件选股，统计命中后第 5/10/15/20/25/30 个交易日的上涨概率、"
        "平均涨幅与相对随机买入的超额（按交易日聚合的 95% 区间）。"
    ),
    forward_days=30,
    windows=HORIZONS,
    params=(
        ParamSpec(
            key="validate_days",
            label="验证天数",
            kind="int",
            default=30,
            hint="向未来看几个交易日；统计周期取标准周期里 ≤ 它的那些",
            minimum=1,
            maximum=30,
        ),
    ),
    outputs=("明细.xlsx",),
    caliber="次日开盘买入，扣 0.2% 往返成本；次日一字涨停不计入；停牌按前收盘顺延（上限 20 天）",
    entry="d0 收盘出信号，d0+1 开盘成交",
)

_TABLE_LIMIT = 200


def _pct(value: Optional[float], digits: int = 2) -> Optional[float]:
    if value is None:
        return None
    return round(float(value) * 100.0, digits)


def _pp(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    return round(float(value), 2)


def _summary_rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in report.get("summary") or []:
        signal = item.get("signal") or {}
        rows.append({
            "window": int(item["horizon"]),
            "n": int(signal.get("n") or 0),
            "win_rate": _pct(signal.get("win_rate")),
            "ci_low": _pct(signal.get("ci_low")),
            "ci_high": _pct(signal.get("ci_high")),
            "avg_return": _pct(signal.get("avg_return")),
            "payoff": item.get("payoff") if item.get("payoff") is not None else signal.get("payoff"),
            "excess_pp": _pp(item.get("excess_pp")),
        })
    return rows


def _honest_rows(report: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in report.get("significance") or []:
        rows.append({
            "window": int(item["horizon"]),
            "excess_pp": _pp(item.get("mean_excess_pp")),
            "ci_low_pp": _pp(item.get("ci_low_pp")),
            "ci_high_pp": _pp(item.get("ci_high_pp")),
            "nw_t": item.get("nw_t"),
            "days": int(item.get("days") or 0),
            "n_eff": int(item.get("n_eff") or 0),
            "verdict": (
                "显著为正" if item.get("significant_up")
                else "显著为负" if item.get("significant_down")
                else "不显著"
            ),
        })
    return rows


def _headline(report: dict[str, Any]) -> Headline:
    decision = report.get("verdict") or {}
    conclusion = report.get("conclusion") or {}
    reason = str(decision.get("reason") or "insufficient")
    best = decision.get("best_horizon")
    best_pp = decision.get("best_excess_pp")
    worst = decision.get("worst_horizon")
    worst_pp = decision.get("worst_excess_pp")
    sample = decision.get("sample")
    significant = bool(decision.get("significant"))

    if reason == "worse":
        title = "这个条件比随机买入更差"
        detail = (
            f"{worst or best} 日超额 {worst_pp if worst_pp is not None else best_pp} 个百分点，"
            "按交易日聚合的区间整体为负（统计显著），建议重新设计条件。"
        )
    elif reason == "usable":
        title = "这个条件显著好于随机买入"
        detail = f"{best} 日超额 {best_pp} 个百分点，最优持有期 {best} 个交易日。"
    elif reason == "no_edge":
        title = "这个条件没有可确认的优势"
        detail = (
            f"{best or '—'} 日超额 {best_pp} 个百分点，区间跨 0"
            f"（{'显著' if significant else '不显著'}），样本 {sample or 0} 条。"
        )
    elif reason == "mixed":
        title = "结论不一致：部分周期为正、部分为负"
        detail = f"最好的 {best} 日为 {best_pp} 个百分点，最差的 {worst} 日为 {worst_pp} 个百分点。"
    else:
        title = "样本不足，给不出结论"
        detail = "命中条数或交易日数太少，先扩大区间再判断。"

    metrics = [
        metric("best_window", "最优周期", best, "日"),
        metric("best_excess", "超额", best_pp, "pp"),
        metric("win_rate", "胜率", decision.get("best_win_rate"), "%"),
        metric("sample", "命中数", sample, "条"),
        metric("honest", "按日聚合区间", (
            f"{conclusion.get('primary_ci_low_pp')} ~ {conclusion.get('primary_ci_high_pp')}"
            if conclusion.get("primary_ci_low_pp") is not None else None
        ), "pp"),
        metric("n_eff", "有效样本", conclusion.get("n_eff"), "段"),
    ]
    return Headline(verdict=reason, title=title, detail=detail, metrics=metrics)


def build(conn: sqlite3.Connection, meta: dict[str, Any]) -> StandardReport:
    """方法 1 的统一报告（内部仍是 ``stats.build_report``，带缓存）。"""
    report = stats.build_report(conn, meta)
    validate_days = int(meta.get("validate_days") or HORIZONS[-1])
    windows = tuple(int(item) for item in (meta.get("horizons") or horizons_for(validate_days)))
    rows = _summary_rows(report)
    honest = _honest_rows(report)

    tables: list[Table] = [
        Table(
            key="window_summary",
            title="各持有期胜率与超额",
            hint="胜率 = 第 N 天收盘高于信号日收盘的比例；超额 = 相对同期随机买入的百分点差",
            columns=[
                Column("window", "持有期", "int"),
                Column("n", "样本", "int"),
                Column("win_rate", "胜率", "percent"),
                Column("ci_low", "区间下限", "percent"),
                Column("ci_high", "区间上限", "percent"),
                Column("avg_return", "平均涨幅", "percent"),
                Column("payoff", "盈亏比", "number"),
                Column("excess_pp", "超额", "pp"),
            ],
            rows=rows,
            sort_key="window",
            sort_order="asc",
        ),
        Table(
            key="honest",
            title="按交易日聚合的显著性（结论以此为准）",
            hint="同一天命中的多只股票、同一只股票连续命中，窗口是重叠的；按日聚合后才不会被放大",
            columns=[
                Column("window", "持有期", "int"),
                Column("excess_pp", "平均超额", "pp"),
                Column("ci_low_pp", "区间下限", "pp"),
                Column("ci_high_pp", "区间上限", "pp"),
                Column("nw_t", "Newey-West t", "number"),
                Column("days", "交易日", "int"),
                Column("n_eff", "有效样本", "int"),
                Column("verdict", "判断", "text"),
            ],
            rows=honest,
            sort_key="window",
            sort_order="asc",
        ),
    ]

    # 数据质量
    quality = report.get("quality") or {}
    quality_rows = [{
        "days": quality.get("days"),
        "rows": quality.get("rows"),
        "unverifiable": quality.get("unverifiable"),
        "unfillable": quality.get("unfillable"),
        "adj_missing": quality.get("adj_missing_rows"),
        "stale_over_5d": quality.get("stale_over_5d"),
        "usable_rate": _pct(quality.get("usable_rate")),
    }]

    # 分市场 / 分年：各周期胜率（只列胜率，界面不显示对照组）
    for key, title, source in (
        ("by_board", "分市场", report.get("by_board") or []),
        ("by_year", "分年", report.get("by_year") or []),
    ):
        if not source:
            continue
        columns = [Column("key", "分组", "text")]
        columns += [Column(f"w{window}", f"{window} 日", "percent") for window in windows]
        columns.append(Column("n", "样本", "int"))
        table_rows = []
        for item in source:
            signal = item.get("signal") or {}
            row: dict[str, Any] = {"key": item.get("key")}
            total = 0
            for window in windows:
                cell = signal.get(str(window)) or {}
                row[f"w{window}"] = _pct(cell.get("win_rate"))
                total = max(total, int(cell.get("n") or 0))
            row["n"] = total
            table_rows.append(row)
        tables.append(Table(key=key, title=title, columns=columns, rows=table_rows, sort_key="n"))

    # 分组（13 个维度）里只把「特别有效」的挑出来，完整版在报告页
    group_rows: list[dict[str, Any]] = []
    for block in report.get("groups") or []:
        for item in block.get("items") or []:
            group_rows.append({
                "dim": block.get("label") or block.get("dim"),
                "key": item.get("key"),
                "n": item.get("n"),
                "win_rate": item.get("win_rate"),
                "edge_pp": item.get("edge_pp"),
                "verdict": item.get("verdict"),
            })
    group_rows.sort(key=lambda row: (row.get("edge_pp") is None, -(row.get("edge_pp") or 0)))
    kept, total_groups = cap_rows([row for row in group_rows if row.get("verdict") == "edge"], _TABLE_LIMIT)
    if kept:
        tables.append(Table(
            key="groups",
            title="特别有效的分类（按超额排序）",
            hint="相对这个条件自身的整体胜率；样本 <100 或校正后不显著的不列入",
            columns=[
                Column("dim", "维度", "text"),
                Column("key", "取值", "text"),
                Column("n", "样本", "int"),
                Column("win_rate", "胜率", "percent"),
                Column("edge_pp", "超额", "pp"),
            ],
            rows=kept,
            total_rows=total_groups,
            sort_key="edge_pp",
        ))

    notes = [
        "超额是与「同一天、按市值档配比抽样的随机股票」比较得出的，界面不展示对照组数字。",
        "重叠样本（同一只股票连续命中、同日大量命中）会让朴素 z 检验放大 3–10 倍，结论以按交易日聚合的区间为准。",
        "退市股不在行情库里，幸存者偏差会使胜率略微偏高；历史 ST 状态与行业分类用的是当前快照。",
    ]
    data_version = report.get("data_version") or {}
    if data_version:
        notes.append(
            f"数据截止 {data_version.get('max_trade_date') or '—'}，股票池 {data_version.get('symbols') or '—'} 只。"
        )

    return StandardReport(
        method=METHOD,
        parameters={"validate_days": validate_days, "windows": list(windows)},
        headline=_headline(report),
        tables=tables,
        artifacts=[Artifact(name="明细.xlsx", kind="xlsx", label="下载 Excel（逐条信号明细）")],
        data_quality={"caliber": report.get("caliber"), "rows": quality_rows,
                      "health": quality.get("health") or {}},
        notes=notes,
    )
