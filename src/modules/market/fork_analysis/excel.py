"""结果工作簿：``明细.xlsx``（列序按用户 2026-10-22 的模板）。

工作表
------
1. **明细**：一行一条信号（日期 / 股票代码 / 名称 / d0 收盘价 / 第1–N 天涨幅 /
   实际可取天数）。N = 验证天数（用户第 3 条）。列序与模板逐列一致，末尾那列是
   新增的，用来一眼认出「这一行是停牌顺延出来的」。
2. **按股票**：命中次数 + 各周期上涨概率 + 行业、市值（第 11 条要的分类依据）。
3. **汇总**：条件组与对照组的整体胜率、超额、平均涨幅、盈亏比、样本数。
4. **分组胜率**：13 个维度（市场/行业/市值/股价/成交额/换手/PE/PB/上市年限/振幅/
   大盘环境/拥挤度/年份）× 各周期，带 q 值（BH 校正）与结论。
5. **年度稳定性**：逐年胜率，看条件是「一直没用」还是「近年被消化」。
6. **行业×市值**：交叉表，找「行业 + 市值」这个组合里的有效区间。

涨幅单位是**百分点**（3.25 = 上涨 3.25%），两位小数。价格是不复权真实收盘价，
涨幅是后复权口径（见 ``forward.py``）。

为什么用 write_only 模式
----------------------
云端实测：38,759 行 × 35 列用普通模式要建 136 万个 Cell 对象，内存冲到 1GB 以上、
20 分钟写不出文件（被 systemd 的 ``MemoryMax=1800M`` 拖到反复换页）。
``Workbook(write_only=True)`` 边写边落盘，内存常数级，同一份数据十几秒完成。
代价：不能事后改单元格（列宽在写完后设、表头样式用 ``WriteOnlyCell`` 提前挂）。
"""

from __future__ import annotations

import logging
import os
import sqlite3
from typing import Any

from . import stats, store
from .models import HORIZONS, horizons_for

logger = logging.getLogger(__name__)

_BOARD_LABELS = {"sh": "沪市", "sz": "深市", "cyb": "创业板", "kcb": "科创板", "other": "其他"}

_HEADER_FILL = "FFF2F2F2"


def _pct(value: Any) -> Any:
    """内部是小数（0.0325）→ 展示成百分点（3.25）。"""
    if value is None:
        return None
    return round(float(value) * 100, 2)


def _header_cells(sheet: Any, values: list[str]) -> list[Any]:
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Alignment, Font, PatternFill

    fill = PatternFill("solid", fgColor=_HEADER_FILL)
    cells = []
    for value in values:
        cell = WriteOnlyCell(sheet, value=value)
        cell.font = Font(bold=True)
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cells.append(cell)
    return cells


def _set_widths(sheet: Any, widths: list[tuple[int, float]]) -> None:
    from openpyxl.utils import get_column_letter

    for column, width in widths:
        sheet.column_dimensions[get_column_letter(column)].width = width


def _write_detail(sheet: Any, conn: sqlite3.Connection, validate_days: int) -> int:
    headers = ["日期", "股票代码", "股票名称", "d0收盘价",
               *[f"第{i}天涨幅" for i in range(1, validate_days + 1)], "实际可取天数"]
    sheet.append(_header_cells(sheet, headers))
    returns = ", ".join(store.RETURN_COLUMNS[:validate_days])
    row_count = 0
    cursor = conn.execute(
        f"SELECT d0, code, name, d0_close, {returns}, avail FROM signals "
        "WHERE is_control = 0 ORDER BY d0, code"
    )
    for row in cursor:
        sheet.append([
            row[0],
            str(row[1]),
            row[2],
            float(row[3]) if row[3] is not None else None,
            *[_pct(row[4 + offset]) for offset in range(validate_days)],
            int(row[4 + validate_days]) if row[4 + validate_days] is not None else 0,
        ])
        row_count += 1
    _set_widths(sheet, [(1, 12), (2, 10), (3, 12), (4, 10),
                        *[(index, 9) for index in range(5, 6 + validate_days)]])
    return row_count


def _write_by_stock(sheet: Any, conn: sqlite3.Connection, horizons: tuple[int, ...] | list[int],
                    control: dict[int, float]) -> int:
    items = stats.by_stock(conn, control, horizons)
    focus = str(horizons[-1])
    headers = ["股票代码", "股票名称", "市场", "行业", "总市值(亿)", "信号数",
               *[f"{h}日上涨概率" for h in horizons],
               f"{focus}日平均涨幅", f"{focus}日超额", "样本是否足够"]
    sheet.append(_header_cells(sheet, headers))
    for item in items:
        sheet.append([
            item["code"],
            item["name"],
            _BOARD_LABELS.get(item["board"], item["board"]),
            item["industry"] or "",
            item["mcap"],
            item["n"],
            *[item["win"].get(str(h)) for h in horizons],
            item["avg"].get(focus),
            item["excess"].get(focus),
            "是" if item["sufficient"] else "否",
        ])
    _set_widths(sheet, [(index, 13) for index in range(1, len(headers) + 1)])
    return len(items)


def _write_summary(sheet: Any, conn: sqlite3.Connection, horizons: tuple[int, ...] | list[int]) -> None:
    rows = stats.summary(conn, horizons)
    headers = ["持有周期(交易日)", "条件组胜率%", "对照组胜率%", "超额(百分点)", "条件组触及率%",
               "条件组平均涨幅%", "条件组盈亏比", "条件组样本", "对照组样本"]
    sheet.append(_header_cells(sheet, headers))
    for row in rows:
        sig, ctl = row["signal"], row["control"]
        sheet.append([
            row["horizon"],
            sig["win_rate"],
            ctl["win_rate"],
            row["excess_pp"],
            sig["touch_rate"],
            sig["avg_return"],
            sig["payoff"],
            sig["n"],
            ctl["n"],
        ])
    _set_widths(sheet, [(index, 17) for index in range(1, len(headers) + 1)])


def _write_groups(sheet: Any, report: dict[str, Any], horizons: tuple[int, ...] | list[int]) -> int:
    """分组胜率（第 11 条的主体）。一行 = 一个维度的一个分类。"""
    headers = ["维度", "分类", "样本", *[f"{h}日胜率%" for h in horizons],
               "优势(百分点)", "q值", "结论", "平均涨幅%"]
    sheet.append(_header_cells(sheet, headers))
    written = 0
    for block in report["groups"]:
        for item in block["items"]:
            horizon_cells = [
                (item["horizons"].get(str(h)) or {}).get("win_rate") for h in horizons
            ]
            label = {
                "edge": "特别有效",
                "no_edge": "一般",
                "insufficient": "样本不足",
            }.get(str(item.get("verdict")), "")
            sheet.append([
                block["label"],
                item["key"],
                item["n"],
                *horizon_cells,
                item.get("edge_pp"),
                item.get("q"),
                label,
                item.get("avg_return"),
            ])
            written += 1
    _set_widths(sheet, [(1, 12), (2, 16), (3, 9), *[(index, 11) for index in range(4, len(headers) + 1)]])
    return written


def _write_years(sheet: Any, report: dict[str, Any], horizons: tuple[int, ...] | list[int]) -> None:
    headers = ["年份", *[f"{h}日胜率%" for h in horizons], "命中数"]
    sheet.append(_header_cells(sheet, headers))
    for row in report["by_year"]:
        signal = row.get("signal") or {}
        sheet.append([
            row["key"],
            *[(signal.get(str(h)) or {}).get("win_rate") for h in horizons],
            (signal.get(str(horizons[-1])) or {}).get("n"),
        ])
    _set_widths(sheet, [(index, 13) for index in range(1, len(headers) + 1)])


def _write_cross(sheet: Any, conn: sqlite3.Connection, focus: int) -> None:
    """行业 × 市值：只在两边样本都够的组合上给胜率，否则留空（不给假精度）。"""
    industry = "COALESCE(NULLIF(industry, ''), '未知')"
    mcap = stats._tiers("mcap", [30, 100, 300, 1000],
                        ["小于30亿", "30-100亿", "100-300亿", "300-1000亿", "1000亿以上"])
    sql = (
        f"SELECT {industry} AS ind, {mcap} AS cap, COUNT(r{focus}) AS n, "
        f"SUM(CASE WHEN r{focus} > 0 THEN 1 ELSE 0 END) AS w, AVG(r{focus}) AS avg "
        "FROM signals WHERE is_control = 0 GROUP BY ind, cap"
    )
    cells: dict[str, dict[str, dict[str, Any]]] = {}
    caps: list[str] = []
    for row in conn.execute(sql):
        ind, cap = str(row["ind"]), str(row["cap"])
        if cap not in caps:
            caps.append(cap)
        cells.setdefault(ind, {})[cap] = {
            "n": int(row["n"] or 0),
            "w": int(row["w"] or 0),
            "avg": row["avg"],
        }
    headers = ["行业", "样本", *[f"{cap} 胜率%" for cap in caps]]
    sheet.append(_header_cells(sheet, headers))
    for ind in sorted(cells):
        total = sum(cell["n"] for cell in cells[ind].values())
        sheet.append([
            ind,
            total,
            *[
                round(cells[ind][cap]["w"] / cells[ind][cap]["n"] * 100, 2)
                if cells[ind].get(cap, {}).get("n", 0) >= stats.MIN_GROUP_SAMPLES else None
                for cap in caps
            ],
        ])
    _set_widths(sheet, [(1, 16), (2, 9), *[(index, 13) for index in range(3, len(headers) + 1)]])


def write_workbook(conn: sqlite3.Connection, preset_name: str, run_id: str) -> str:
    """生成（或覆盖）``明细.xlsx``，返回路径字符串。没有信号时也生成空表头。"""
    try:
        from openpyxl import Workbook
    except ImportError as exc:  # pragma: no cover - 依赖漏装
        raise RuntimeError("缺少 openpyxl，请执行 deploy/01-install-deps.sh 安装") from exc

    try:
        meta = store.load_meta(preset_name, run_id)
    except store.RunNotFound:  # 单测/手工建库：没有 meta 也要能出表
        meta = {}
    validate_days = int(meta.get("validate_days") or HORIZONS[-1])
    horizons = tuple(meta.get("horizons") or horizons_for(validate_days))
    report = stats.build_report(conn, meta)

    workbook = Workbook(write_only=True)
    _write_detail(workbook.create_sheet("明细"), conn, validate_days)
    _write_by_stock(workbook.create_sheet("按股票"), conn, horizons,
                    stats.control_win_rates(report["summary"]))
    _write_summary(workbook.create_sheet("汇总"), conn, horizons)
    _write_groups(workbook.create_sheet("分组胜率"), report, horizons)
    _write_years(workbook.create_sheet("年度稳定性"), report, horizons)
    _write_cross(workbook.create_sheet("行业×市值"), conn, horizons[-1])

    path = store.excel_path(preset_name, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 临时名带 pid：主循环收尾与「下载时按需重建」可能同时跑（两个线程各写一份）
    tmp = path.with_name(f".tmp-{os.getpid()}-{path.name}")
    workbook.save(tmp)
    tmp.replace(path)
    return str(path)
