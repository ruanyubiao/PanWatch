"""数据分析任务的请求模型与常量（需求：条件在历史上的准确率）。

与条件选股的关系
----------------
一个分析任务 = 「一个已保存条件」× 「一段日期区间」× 「每天跑一次条件选股」。
选股本身完全复用 ``fork_screen.service.run_screen(request, asof=d0)``，不另写一套
判定逻辑 —— 否则「分析出来的准确率」和「界面上选出来的股票」会是两件事。

这里只放**结构**校验（``extra="forbid"`` 与 ``ScreenRequest`` 一致）；条件本身是否
合法由 ``fork_screen`` 的 validate 负责。
"""

from __future__ import annotations

import datetime as _dt
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

#: 前瞻交易日数（d0 之后最多看 30 个交易日）
FORWARD_DAYS = 30

#: 统计用的持有周期（天）。与前端图表、Excel 汇总表共用这一份。
HORIZONS: tuple[int, ...] = (5, 10, 15, 20, 25, 30)

#: 每天随机抽取的对照样本数（同一天、同一市场的随机股票，用同样算法算涨幅）。
DEFAULT_SAMPLE_SIZE = 200

#: 允许的最大统计天数（防止把 2000 年那种无意义区间填进来跑一整天）
MAX_CALENDAR_DAYS = 4000


class AnalysisCreate(BaseModel):
    """创建分析任务。"""

    model_config = ConfigDict(extra="forbid")

    #: 已保存条件的名字（= ``data/screen_presets/<名字>.json`` 的文件名）
    preset: str = Field(min_length=1, max_length=64)
    start_date: _dt.date
    #: 结束日（含）。省略 = 库里最新交易日。
    end_date: Optional[_dt.date] = None
    #: 股票范围：覆盖已保存条件里的市场设置。省略 = 用条件自己存的。
    markets: Optional[list[Literal["sh", "sz", "cyb", "kcb"]]] = None
    include_st: Optional[bool] = None
    #: 每日对照样本数（0 = 不算对照组，只跑条件组）
    sample_size: int = Field(default=DEFAULT_SAMPLE_SIZE, ge=0, le=2000)
