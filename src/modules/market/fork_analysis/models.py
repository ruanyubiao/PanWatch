"""数据分析任务的请求模型与常量（需求：条件在历史上的准确率）。

与条件选股的关系
----------------
一个分析任务 = 「一个已保存条件」× 「一段日期区间」× 「每天跑一次条件选股」。
选股本身完全复用 ``fork_screen.service.run_screen(request, asof=d0)``，不另写一套
判定逻辑 —— 否则「分析出来的准确率」和「界面上选出来的股票」会是两件事。

这里只放**结构**校验（``extra=\"forbid\"`` 与 ``ScreenRequest`` 一致）；条件本身是否
合法由 ``fork_screen`` 的 validate 负责。

验证天数（``validate_days``，用户 2026-10-22 第 3 条）
----------------------------------------------------
任务只向前看 N 个交易日（默认 30）。统计周期取 ``HORIZONS`` 里 ≤ N 的那些
（N=12 → 5、10；N=3 → 只剩 3 本身）。上限 30 是 ``signals.db`` 的列宽
（``r1``…``r30``），要更长就得改表结构，所以这里显式拦住。
"""

from __future__ import annotations

import datetime as _dt
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

#: 前瞻交易日数上限（d0 之后最多看 30 个交易日 = signals.db 的 r1..r30）
FORWARD_DAYS = 30

#: 标准统计周期（天）。验证天数不足时按 ``horizons_for`` 截断。
HORIZONS: tuple[int, ...] = (5, 10, 15, 20, 25, 30)

#: 默认验证天数（用户第 3 条）
DEFAULT_VALIDATE_DAYS = 30

#: 每天随机抽取的对照样本数（只在内部用来算超额/结论，界面不再展示对照组）。
DEFAULT_SAMPLE_SIZE = 200

#: 允许的最大区间（防止把 2000 年那种无意义区间填进来跑一整天）
MAX_CALENDAR_DAYS = 4000


def horizons_for(validate_days: int) -> tuple[int, ...]:
    """当前验证天数下要统计的周期。

    N=30 → 5/10/15/20/25/30；N=12 → 5/10（不额外加 12，用户 2026-10-22 明确）；
    N<5 → 只有 N 自己（否则一个周期都没有，报告是空的）。
    """
    days = max(1, int(validate_days))
    picked = tuple(horizon for horizon in HORIZONS if horizon <= days)
    return picked or (days,)


class AnalysisCreate(BaseModel):
    """创建分析任务。"""

    model_config = ConfigDict(extra="forbid")

    #: 已保存条件的名字（= ``data/screen_presets/<名字>.json`` 的文件名）
    preset: str = Field(min_length=1, max_length=64)
    start_date: _dt.date
    #: 结束日（含）。省略 = 库里最新交易日往前推 ``validate_days`` 个交易日。
    end_date: Optional[_dt.date] = None
    #: 验证天数（向前看几个交易日），1–30
    validate_days: int = Field(default=DEFAULT_VALIDATE_DAYS, ge=1, le=FORWARD_DAYS)
    #: 股票范围：覆盖已保存条件里的市场设置。省略 = 用条件自己存的。
    markets: Optional[list[Literal["sh", "sz", "cyb", "kcb"]]] = None
    include_st: Optional[bool] = None
    #: 每日对照样本数（0 = 不算对照组）。界面不展示，但结论卡要靠它判断「是不是本来就会涨」。
    sample_size: int = Field(default=DEFAULT_SAMPLE_SIZE, ge=0, le=2000)
