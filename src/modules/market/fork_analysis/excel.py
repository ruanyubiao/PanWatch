"""结果工作簿：``明细.xlsx``（用户 2026-10-22 指定的列序）。

三张表
------
1. **明细**：一行一条信号（日期 / 股票代码 / 名称 / d0 收盘价 / 第1–30天涨幅 /
   实际可取天数）。列序与用户给的格式逐列一致，末尾那列是**新增**的，用来一眼认出
   「这一行是停牌顺延出来的」（停牌天数越多，这一列越小）。
2. **按股票**：命中次数 + 5/10/15/20/25/30 天上涨概率 + 10 日平均涨幅与超额。
3. **汇总**：条件组与对照组的六周期胜率、超额、平均涨幅、盈亏比、样本数。

涨幅单位是**百分点**（3.25 = 上涨 3.25%），两位小数。价格是不复权真实收盘价，
涨幅是后复权口径（见 ``forward.py`` 的三条口径）。
"""

from __future__ import annotations

import logging
import os
import sqlite3
from typing import Any

from . import stats, store
from .models import HORIZONS

logger = logging.getLogger(__name__)

_BOARD_LABELS = {"sh": "沪市", "sz": "深市", "cyb": "创业板", "kcb": "科创板", "other": "其他"}

_HEADER_FILL = "FFF2F2F2"


def _pct(value: Any) -> Any:
    """内部是小数（0.0325）→ 展示成百分点（3.25）。"""
    if value is None:
        return None
    return round(float(value) * 100, 2)


def _style_header(sheet: Any, columns: int) -> None:
    from openpyxl.styles import Alignment, Font, PatternFill

    fill = PatternFill("solid", fgColor=_HEADER_FILL)
    for index in range(1, columns + 1):
        cell = sheet.cell(row=1, column=index)
        cell.font = Font(bold=True)
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center")


def _write_detail(sheet: Any, conn: sqlite3.Connection) -> int:
    headers = ["日期", "股票代码", "股票名称", "d0收盘价", *[f"第{i}天涨幅" for i in range(1, 31)], "实际可取天数"]
    sheet.append(headers)
    _style_header(sheet, len(headers))
    returns = ", ".join(store.RETURN_COLUMNS)
    row_count = 0
    cursor = conn.execute(
        f"SELECT d0, code, name, d0_close, {returns}, avail FROM signals "
        "WHERE is_control = 0 ORDER BY d0, code"
    )
    for row in cursor:
        code = str(row[1])
        sheet.append([
            row[0],
            # 代码写成文本：Excel 会把 000001 显示成 1
            code,
            row[2],
            float(row[3]) if row[3] is not None else None,
            *[_pct(row[4 + offset]) for offset in range(30)],
            int(row[34]) if row[34] is not None else 0,
        ])
        sheet.cell(row=sheet.max_row, column=2).number_format = "@"
        row_count += 1
    widths = [(1, 12), (2, 10), (3, 12), (4, 10)] + [(index, 9) for index in range(5, 36)]
    for column, width in widths:
        sheet.column_dimensions[sheet.cell(row=1, column=column).column_letter].width = width
    sheet.freeze_panes = "D2"
    return row_count


def _write_by_stock(sheet: Any, conn: sqlite3.Connection) -> int:
    summary_rows = stats.summary(conn)
    control = stats.control_win_rates(summary_rows)
    items = stats.by_stock(conn, control)
    headers = ["股票代码", "股票名称", "市场", "信号数", *[f"{h}日上涨概率" for h in HORIZONS],
               "10日平均涨幅", "10日超额", "样本是否足够"]
    sheet.append(headers)
    _style_header(sheet, len(headers))
    for item in items:
        sheet.append([
            item["code"],
            item["name"],
            _BOARD_LABELS.get(item["board"], item["board"]),
            item["n"],
            *[item["win"].get(str(h)) for h in HORIZONS],
            item["avg"].get("10"),
            item["excess"].get("10"),
            "是" if item["sufficient"] else "否",
        ])
        sheet.cell(row=sheet.max_row, column=1).number_format = "@"
    for index in range(1, len(headers) + 1):
        sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = 13
    sheet.freeze_panes = "C2"
    return len(items)


def _write_summary(sheet: Any, conn: sqlite3.Connection) -> None:
    rows = stats.summary(conn)
    headers = ["持有周期(交易日)", "条件组胜率%", "对照组胜率%", "超额(百分点)", "条件组触及率%",
               "条件组平均涨幅%", "条件组盈亏比", "条件组样本", "对照组样本"]
    sheet.append(headers)
    _style_header(sheet, len(headers))
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
    for index in range(1, len(headers) + 1):
        sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = 17
    sheet.freeze_panes = "A2"


def write_workbook(conn: sqlite3.Connection, preset_name: str, run_id: str) -> str:
    """生成（或覆盖）``明细.xlsx``，返回路径字符串。没有信号时也生成空表头。"""
    try:
        from openpyxl import Workbook
    except ImportError as exc:  # pragma: no cover - 依赖漏装
        raise RuntimeError("缺少 openpyxl，请执行 deploy/01-install-deps.sh 安装") from exc

    workbook = Workbook()
    detail = workbook.active
    assert detail is not None  # openpyxl 新建工作簿必有一个活动表
    detail.title = "明细"
    _write_detail(detail, conn)
    _write_by_stock(workbook.create_sheet("按股票"), conn)
    _write_summary(workbook.create_sheet("汇总"), conn)

    path = store.excel_path(preset_name, run_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    # 临时名带 pid：主循环收尾与「下载时按需重建」可能同时跑（两个线程各写一份）
    tmp = path.with_name(f".tmp-{os.getpid()}-{path.name}")
    workbook.save(tmp)
    tmp.replace(path)
    return str(path)
