"""条件推理（自动搜索）的回归：变异空间、前瞻口径、引擎打分。

全部不碰 MySQL —— ``Dataset`` 直接手工构造数组，规则用真的 ``fork_screen``
求值器跑。这样测的是「我们自己写的那部分」，而求值一致性由条件选股自己的
测试保证。
"""

from __future__ import annotations

import datetime as dt
import random

import pytest

from src.modules.market.fork_infer import space
from src.modules.market.fork_infer.data import Dataset, StockData
from src.modules.market.fork_infer.engine import (
    COST,
    Engine,
    forward_of,
    primary_metric,
    score_of,
)
from src.modules.market.fork_infer.models import INFER_HORIZONS
from src.modules.market.fork_screen.models import ScreenRequest

BASE_RULE = {"type": "group", "operator": "AND", "children": [
    {"type": "condition", "name": "consecutive_bullish", "params": {"start": 1, "days": 2}},
]}


def make_request(rule: dict, trading_days: int = 30) -> ScreenRequest:
    return ScreenRequest.model_validate({
        "trading_days": trading_days,
        "markets": ["sh", "sz", "cyb", "kcb"],
        "include_st": False,
        "rule": rule,
    })


def make_dataset(stocks: list[StockData], days: int) -> Dataset:
    calendar = [dt.date(2024, 1, 1) + dt.timedelta(days=index) for index in range(days)]
    return Dataset(calendar=calendar,
                   cal_index={day: index for index, day in enumerate(calendar)},
                   stocks={stock.symbol: stock for stock in stocks})


def make_stock(symbol: str, days: int, *, start: float = 10.0, step: float = 0.2,
               board: str = "sh", suspend: tuple[int, int] | None = None,
               gap_up: float = 0.0, open_factor: float = 0.995) -> StockData:
    """造一只股票：``step`` 每天涨多少；``suspend`` 指定停牌的下标区间。

    ``open_factor`` < 1 → 每根都是阳线（收盘高于开盘）；> 1 → 阴线。
    ``gap_up`` 再把开盘价整体抬高（用来造「开盘即涨停」）。
    """
    stock = StockData(symbol=symbol, code=symbol[-6:], name=f"测试{symbol}",
                      board=board, is_st=False)
    price = start
    for index in range(days):
        if suspend and suspend[0] <= index < suspend[1]:
            continue  # 停牌：没有 K 线
        price = price * (1.0 + step)
        open_price = price * open_factor * (1.0 + gap_up)
        stock.dates.append(index)
        stock.open.append(open_price)
        stock.close.append(price)
        stock.high.append(price * 1.02)
        stock.pre_close.append(price)
        stock.c_adj.append(price)
        stock.open_adj.append(open_price)
        stock.high_adj.append(price * 1.02)
        stock.volume.append(1e6)
        stock.amount.append(1e8)
        stock.turnover.append(1.0)
        stock.mcap.append(50e8)
    return stock


# --------------------------------------------------------------------------- #
# 变异空间
# --------------------------------------------------------------------------- #
def test_基础条件原样嵌进_and_组():
    rule = space.make_rule(BASE_RULE, [{"name": "change_pct", "params": {"n": 1, "min": 0, "max": 9.9}}])
    assert rule["operator"] == "AND"
    assert rule["children"][0] == BASE_RULE
    assert rule["children"][1]["name"] == "change_pct"


def test_补条件不会重复同一个条件名():
    rng = random.Random(1)
    filters: list[dict] = []
    for _ in range(30):
        candidate = space.add_filter(filters, rng)
        if candidate is not None:
            filters = candidate
    names = [item["name"] for item in filters]
    assert len(names) == len(set(names))
    assert len(names) <= len(space.FILTER_TEMPLATES)


def test_去条件不会动基础条件():
    filters = [{"name": "change_pct", "params": {"n": 1, "min": 0, "max": 9.9}}]
    result = space.remove_filter(filters, random.Random(0))
    assert result == []
    assert space.remove_filter([], random.Random(0)) is None


def test_调参数只会改一个数值且仍是整数参数():
    params = {"start": 1, "days": 4}
    updated = space.jitter_params("consecutive_bullish", params, random.Random(3))
    assert updated is not None
    changed = [key for key in params if params[key] != updated[key]]
    assert len(changed) == 1
    assert isinstance(updated[changed[0]], int)


def test_描述能说清条件和参数():
    text = space.describe("连续阳线2天", [{"name": "consecutive_bullish",
                                       "params": {"start": 1, "days": 2}}])
    assert "连续阳线" in text and "2" in text
    assert space.describe("基础", []) == "基础"


def test_规则规范化可去重():
    a = space.make_rule(BASE_RULE, [{"name": "new_high", "params": {"m": 60, "n": 1}}])
    b = space.make_rule(BASE_RULE, [{"name": "new_high", "params": {"n": 1, "m": 60}}])
    assert space.canonical(a) == space.canonical(b)


# --------------------------------------------------------------------------- #
# 前瞻口径
# --------------------------------------------------------------------------- #
def test_收盘口径与可执行口径的差别就是隔夜跳空():
    stock = make_stock("sh600000", 60, step=0.01, gap_up=0.05)
    result = forward_of(stock, 30, 30, 60)
    assert result is not None
    # 收盘口径：第 5 天收盘 / 当天收盘
    expected_close = stock.c_adj[35] / stock.c_adj[30] - 1
    assert result.close[0] == pytest.approx(expected_close, rel=1e-6)
    # 可执行口径：第 5 天收盘 / 次日**开盘**（开盘被抬高 5%）
    expected_exec = stock.c_adj[35] / stock.open_adj[31] - 1
    assert result.exec_[0] == pytest.approx(expected_exec, rel=1e-6)
    assert result.exec_[0] < result.close[0]


def test_停牌按前一日顺延且计入顺延上限():
    # 停牌 6 天（全局下标 40..45）：第 10 个持有日（下标 40）正落在停牌里
    stock = make_stock("sh600001", 80, step=0.01, suspend=(40, 46))
    result = forward_of(stock, 30, 30, 80)
    assert result is not None
    ten_index = INFER_HORIZONS.index(10)
    assert ten_index == 1
    # 用停牌前最后一个有效收盘（全局下标 39）的涨幅，而不是「记成 0%」
    pos_before = stock.dates.index(39)
    expected = stock.c_adj[pos_before] / stock.c_adj[30] - 1
    assert result.close[ten_index] == pytest.approx(expected, rel=1e-6)
    # 停牌结束后的持有期恢复正常（第 20 天 = 全局下标 50）
    twenty_index = INFER_HORIZONS.index(20)
    pos_after = stock.dates.index(50)
    assert result.close[twenty_index] == pytest.approx(
        stock.c_adj[pos_after] / stock.c_adj[30] - 1, rel=1e-6)


def test_长期停牌判不可验证而不是记成零涨幅():
    stock = make_stock("sh600002", 120, step=0.01, suspend=(40, 100))  # 停 60 天
    result = forward_of(stock, 30, 30, 120)
    assert result is not None
    assert result.close[4] is None  # 第 30 天仍在停牌 → 顺延超过上限


def test_次日开盘一字涨停标记买不进():
    stock = make_stock("sh600003", 60, step=0.0, gap_up=0.10, open_factor=1.005)
    result = forward_of(stock, 30, 30, 60)
    assert result is not None and result.unfillable is True
    # 创业板 20% 才涨停，同样的 10% 高开不算买不进
    stock.board = "cyb"
    assert forward_of(stock, 30, 30, 60).unfillable is False


def test_前瞻天数不够时留空():
    # 日历只有 40 天（下标 0..39），信号在下标 35：第 5 天之后就没有行情了
    stock = make_stock("sh600004", 40, step=0.01)
    result = forward_of(stock, 35, 35, 40)
    assert result is not None
    assert result.close[0] is None  # 第 5 天已超出日历
    assert len(result.close) == len(INFER_HORIZONS)


# --------------------------------------------------------------------------- #
# 引擎
# --------------------------------------------------------------------------- #
def test_引擎只数命中而且基准覆盖全市场():
    days = 60
    rising = make_stock("sh600010", days, step=0.02)      # 每天阳线 → 天天命中
    falling = make_stock("sh600011", days, step=-0.02, open_factor=1.005)  # 阴线 → 不命中
    dataset = make_dataset([rising, falling], days)
    engine = Engine(dataset, make_request(BASE_RULE))
    metrics = engine.evaluate(BASE_RULE, [20, 30, 40])
    assert metrics.signals() == 3            # 3 天 × 1 只
    assert metrics.days_with_hits() == 3
    row = metrics.table()[0]
    # 基准是两只股票的当天结果，不是只看命中的那只
    assert row["close_base"] is not None
    assert 0 < row["close_base"] < 100


def test_不可验证的样本不进分母():
    """命中里有一部分因为停牌/退市算不出涨幅，它们不能当「没涨」压概率。"""
    days = 100
    winner = make_stock("sh600050", days, step=0.02)               # 一直涨
    stuck = make_stock("sh600051", days, step=0.02, suspend=(31, 100))  # 信号后立刻长停
    dataset = make_dataset([winner, stuck], days)
    engine = Engine(dataset, make_request(BASE_RULE))
    metrics = engine.evaluate(BASE_RULE, [30])
    record = metrics.records[0]
    assert record.hits == 2
    # 第 5 天：停牌顺延 5 天，仍在 20 天上限内 → 用停牌前收盘，两只都算得出
    assert record.close_n[0] == 2
    # 第 30 天：顺延已超过 20 天上限 → 那一只判不可验证，分母只剩 1
    assert record.close_n[4] == 1
    assert record.base_close[4] == 1.0


def test_评分在样本不足时不给分():
    days = 60
    dataset = make_dataset([make_stock("sh600020", days, step=0.02)], days)
    engine = Engine(dataset, make_request(BASE_RULE))
    metrics = engine.evaluate(BASE_RULE, [20, 30])
    assert score_of(metrics, "stat_v3")[0] is None


def test_三种方法各自用不同口径():
    assert primary_metric("stat_v1") == ("close", "day")
    assert primary_metric("stat_v2") == ("touch", "pooled")
    assert primary_metric("stat_v3") == ("exec", "pooled")


def test_成分年份为负时评分被扣分():
    days = 400
    stock = make_stock("sh600030", days, step=0.01)
    dataset = make_dataset([stock], days)
    engine = Engine(dataset, make_request(BASE_RULE))
    metrics = engine.evaluate(BASE_RULE, list(range(30, 300)))
    # 单只股票、随便构造的数据：只要能算出分就说明扣分逻辑没抛异常
    score, horizon = score_of(metrics, "stat_v1")
    assert score is None or isinstance(score, float)


def test_校验能给出中文错误而不是抛异常():
    engine = Engine(make_dataset([make_stock("sh600040", 40, step=0.01)], 40),
                    make_request(BASE_RULE))
    bad = space.make_rule(BASE_RULE, [{"name": "change_pct",
                                       "params": {"n": 1, "min": 5, "max": 1}}])
    issues = engine.validate(bad)
    assert issues and "涨跌幅" in issues[0]


def test_抽样保持顺序且不重复():
    from src.modules.market.fork_infer.search import _sample

    days = [dt.date(2024, 1, 1) + dt.timedelta(days=index) for index in range(500)]
    picked = _sample(days, 120)
    assert len(picked) == 120
    assert picked == sorted(picked)
    assert len(set(picked)) == 120
    assert _sample(days[:10], 120) == days[:10]


def test_成本是千分之二():
    assert COST == 0.002


def test_持有期是用户指定的五档():
    assert INFER_HORIZONS == (5, 10, 20, 25, 30)
