"""条件选股的请求/规则模型（Pydantic v2）。

对应需求规格 §7.2。只做**结构**校验：白名单、范围、跨字段的业务规则都在
``evaluator.validate_request`` 里，那边能给出带路径的中文错误信息。

``extra="forbid"`` 是刻意的：前端多传一个字段就是前端写错了，静默忽略会让
「明明勾了却没生效」这类问题极难查（规格 §10 最后一行）。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ConditionNode(_Strict):
    type: Literal["condition"]
    id: str | None = Field(default=None, max_length=64)
    # 白名单在语义校验里查（``CONDITIONS``），错误信息比 pydantic 的枚举报错友好
    name: str
    params: dict[str, Any] = Field(default_factory=dict)


class GroupNode(_Strict):
    type: Literal["group"]
    id: str | None = Field(default=None, max_length=64)
    operator: Literal["AND", "OR"]
    children: list["RuleNode"] = Field(default_factory=list)


RuleNode = Annotated[Union[ConditionNode, GroupNode], Field(discriminator="type")]
GroupNode.model_rebuild()


class MarketCap(_Strict):
    min_yi: float
    max_yi: float


class ScreenRequest(_Strict):
    """选股请求。

    ``trading_days`` 声明成 ``int | float`` 而不是纯 ``int``：1.5 这种输入
    pydantic 会直接判 422「结构错误」，而规格 §8.1 的错误表要求它是 400
    ``screen_invalid_params``（文案「统计窗口需为 1–250 的整数」）。所以在语义
    校验里查「是不是整数」，用户得到的错误码与他填错的其他字段一致。
    """

    trading_days: int | float
    markets: list[Literal["sh", "sz", "cyb", "kcb"]]
    include_st: bool = False
    market_cap: MarketCap
    rule: GroupNode
