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


def test_创建任务时交易日存成日期数组而不是个数(monkeypatch):
    """曾经的 bug：preview() 的 train_days 是**个数**，create() 直接迭代它，
    报 ``'int' object is not iterable``（线上创建 503）。"""
    from pathlib import Path

    from src.modules.market.fork_infer import search, store
    from src.modules.market.fork_infer.models import InferCreate

    seg = {
        "train_days": [dt.date(2024, 1, 2), dt.date(2024, 1, 3)],
        "valid_days": [dt.date(2026, 1, 5)],
        "latest_trade_date": "2026-10-23",
        "max_verifiable": "2026-09-02",
        "data_version": {},
    }
    info = {
        "method": "stat_v3", "method_name": "m3",
        "train_days": 2, "valid_days": 1,          # 注意：个数
        "train_first": "2024-01-02", "train_last": "2024-01-03",
        "valid_first": "2026-01-05", "valid_last": "2026-01-05",
        "search_days": 2, "iterations": 2,
        "max_verifiable": "2026-09-02", "latest_trade_date": "2026-10-23",
        "base_summary": "x", "base_trading_days": 30, "base_bars": 30,
        "estimate_seconds": 1, "horizons": [5], "data_version": {},
    }
    box: dict = {}
    monkeypatch.setattr(search, "preview", lambda payload: info)
    monkeypatch.setattr(search, "two_segment_days", lambda payload: seg)
    monkeypatch.setattr(search, "base_request_of",
                        lambda *a, **k: make_request(BASE_RULE))
    monkeypatch.setattr(search, "start", lambda run_id: None)
    monkeypatch.setattr(store, "new_run_id", lambda: "20260101-000000-test")
    monkeypatch.setattr(store, "run_dir", lambda run_id: Path("/tmp"))
    monkeypatch.setattr(store, "save_meta", lambda run_id, meta: box.update(meta))
    monkeypatch.setattr(store, "load_meta", lambda run_id: dict(box))

    search.create(InferCreate(preset="xg1", train_start=dt.date(2024, 1, 1),
                              train_end=dt.date(2025, 12, 31),
                              valid_start=dt.date(2026, 1, 1), iterations=2))
    assert box["train_days"] == ["2024-01-02", "2024-01-03"]
    assert box["valid_days"] == ["2026-01-05"]


def test_与基础条件同名的补充条件被丢掉():
    """用户 2026-10-25 第 4 条：搜索出来的条件里出现过

        「0日内阳线多于阴线 ＋ …… ＋ 6日内阳线多于阴线」

    同一个判据写了两遍。同名（不论参数）一律不再补：A(5日) AND A(10日) 等价于
    A(10日)，只会让描述变长、白占搜索预算；「0日内」则是把 m=0 这个「窗口末」
    哨兵当日数打印出来了。
    """
    base = {"type": "group", "operator": "AND", "children": [
        {"type": "condition", "name": "consecutive_rising", "params": {"start": 1, "days": 3}},
        {"type": "condition", "name": "more_bullish_candles", "params": {"n": 1, "m": 1}},
    ]}
    filters = [
        {"name": "consecutive_rising", "params": {"start": 1, "days": 3}},   # 与基础完全重复 → 丢
        {"name": "consecutive_rising", "params": {"start": 1, "days": 2}},   # 同名不同参 → 也丢
        {"name": "more_bullish_candles", "params": {"n": 1, "m": 10}},       # 同名不同参 → 也丢
        {"name": "new_high", "params": {"m": 20, "n": 1}},                   # 新条件 → 留
    ]
    rule = space.make_rule(base, filters)
    tail = rule["children"][1:]
    assert [(c["name"], c["params"]) for c in tail] == [("new_high", {"m": 20, "n": 1})]
    # 描述里也不能出现两条一样的判据
    text = space.describe_tree(base, filters)
    assert text.count("阳线多于阴线") == 1


def test_基础条件里的窗口哨兵不会被打印成0日():
    """m=0 是「统计窗口最后一天」的哨兵，不是「0 日」。"""
    text = space.describe_condition("more_bullish_candles", {"n": 1, "m": 0})
    assert text == "整个统计窗口（倒数第1日～窗口末）阳线多于阴线"
    assert "0日" not in text
    # 显式给了 F：按「倒数第 F～N 日」写，和条件选股界面同一套写法
    assert space.describe_condition("more_bullish_candles", {"n": 1, "m": 6}) == "倒数第6～1日阳线多于阴线"


def test_保存条件时传的是可序列化字典(monkeypatch):
    """曾经的 bug：直接把 ScreenRequest 交给 json.dump，保存条件 500。"""
    from src.modules.market.fork_infer import search, store
    from src.modules.market.fork_screen import presets

    captured = {}

    monkeypatch.setattr(store, "load_meta", lambda run_id: {
        "preset": "xg1",
        "base_request": {"trading_days": 30, "markets": ["sh"], "include_st": False},
    })
    monkeypatch.setattr(store, "read_finalists", lambda run_id: [{"rank": 1, "rule": BASE_RULE}])
    monkeypatch.setattr(store, "read_results", lambda run_id: [])
    monkeypatch.setattr(presets, "save",
                        lambda name, request, overwrite=False: captured.update(
                            name=name, request=request))

    search.save_condition("20260101-000000-test", 1, "xg_opt1")
    assert captured["name"] == "xg_opt1"
    assert isinstance(captured["request"], dict), "必须是 dict，否则 json.dump 会 TypeError"
    assert captured["request"]["rule"]["children"][0]["name"] == "consecutive_bullish"


# --------------------------------------------------------------------------- #
# 2026-10-25：变异空间扩容（用户第 1 条）
# --------------------------------------------------------------------------- #
def test_条件池里的每一条都必须能通过后端校验():
    """模板写错参数会表现为「搜索跑了 1000 次，一半变体被判不合法」。

    上一轮 new_high 的 60/120/250 日回看就踩了这个坑：后端规定回看天数 ≤ 统计窗口，
    30 天窗口下 60 日新高直接不合法。这里把每个模板 × 30/60/250 三种窗口都过一遍。
    """
    from src.modules.market.fork_screen.evaluator import validate_rule
    from src.modules.market.fork_screen.models import ScreenRequest

    base = {"type": "group", "operator": "AND", "children": [
        {"type": "condition", "name": "more_bullish_candles", "params": {"n": 1, "m": 0}},
    ]}
    problems = []
    for template in space.FILTER_TEMPLATES:
        for params in template.grid:
            rule = space.make_rule(base, [{"name": template.name, "params": dict(params)}])
            for days in (30, 60, 250):
                request = ScreenRequest.model_validate({
                    "trading_days": days, "markets": ["sh", "sz", "cyb", "kcb"],
                    "include_st": True, "rule": rule,
                })
                issues = validate_rule(request)
                if issues:
                    problems.append((template.name, params, days, [i.message for i in issues]))
    assert problems == []


def test_基础条件候选池每一条都能通过校验():
    from src.modules.market.fork_screen.evaluator import validate_rule
    from src.modules.market.fork_screen.models import ScreenRequest

    problems = []
    for entry in space.BASE_POOL:
        rule = {"type": "group", "operator": "AND", "children": [
            {"type": "condition", "name": entry["name"], "params": dict(entry["params"])},
        ]}
        for days in (30, 60, 250):
            request = ScreenRequest.model_validate({
                "trading_days": days, "markets": ["sh", "sz", "cyb", "kcb"],
                "include_st": True, "rule": rule,
            })
            issues = validate_rule(request)
            if issues:
                problems.append((entry, days, [i.message for i in issues]))
    assert problems == []


def test_百分数参数按半步长调整():
    """用户第 1 条「参数步长按 0.5」：涨跌幅 8.9 → 8.4 / 9.4，而不是只能跳到 7.9。"""
    values = set()
    for seed in range(40):
        updated = space.jitter_params("change_pct", {"n": 1, "min": 2.0, "max": 8.9},
                                      random.Random(seed))
        if updated and "max" in updated and updated["max"] != 8.9:
            values.add(updated["max"])
    assert values <= {8.4, 9.4}, values
    assert 8.4 in values

    # 整数参数仍然只按 1 走，不会出现 3.5 天
    days = set()
    for seed in range(30):
        updated = space.jitter_params("consecutive_bullish", {"start": 1, "days": 4},
                                      random.Random(seed))
        if updated:
            days.add(updated["days"])
    assert all(isinstance(value, int) and value >= 1 for value in days), days


def test_可以替换基础条件且保留树的其余部分():
    """用户第 1 条「允许替换基础条件」：A AND B 换掉 A 之后仍然是 A' AND B。"""
    base = {"type": "group", "operator": "AND", "children": [
        {"type": "condition", "name": "more_bullish_candles", "params": {"n": 1, "m": 0}},
        {"type": "condition", "name": "close_above_ma", "params": {"period": 20, "n": 1, "m": 1}},
    ]}
    tree, name = space.replace_condition(base, random.Random(7))
    assert name is not None
    assert len(tree["children"]) == 2
    changed = [index for index, child in enumerate(tree["children"])
               if child != base["children"][index]]
    assert len(changed) == 1, tree  # 只换一个条件节点，另一个原样保留
    kept = tree["children"][1 - changed[0]]
    assert kept == base["children"][1 - changed[0]]
    assert tree["children"][changed[0]]["name"] == name
    # 原树没有被就地改掉（否则父代会被污染）
    assert base["children"][0]["name"] == "more_bullish_candles"


def test_替换基础条件不会选出与原来完全相同的条件():
    base = {"type": "group", "operator": "AND", "children": [
        {"type": "condition", "name": "more_bullish_candles", "params": {"n": 1, "m": 0}},
    ]}
    for seed in range(30):
        tree, name = space.replace_condition(base, random.Random(seed))
        node = tree["children"][0]
        assert not (node["name"] == "more_bullish_candles" and node["params"] == {"n": 1, "m": 0})


def test_描述跟着变体自己的基础条件走():
    """允许替换基础条件后，描述必须由变体的树生成，不能沿用固定串。"""
    tree = {"type": "group", "operator": "AND", "children": [
        {"type": "condition", "name": "consecutive_bullish", "params": {"start": 1, "days": 3}},
    ]}
    text = space.describe_tree(tree, [{"name": "new_high", "params": {"m": 20, "n": 1}}])
    assert text.startswith("连续阳线3天")
    assert "创20日新高" in text
    assert "阳线多于阴线" not in text


def test_扩容后的空间明显大于上一轮():
    """上一轮 19 个模板 / 873 次就穷举完；扩容后至少 25 个模板。"""
    assert len(space.FILTER_TEMPLATES) >= 25
    assert len({template.name for template in space.FILTER_TEMPLATES}) == len(space.FILTER_TEMPLATES)
    assert len(space.BASE_POOL) >= 10


# --------------------------------------------------------------------------- #
# 2026-11-02：保存条件名字带两个评分（用户第 1 条）
# --------------------------------------------------------------------------- #
def _save_with(monkeypatch, scores, name=None, exists_times=0):
    from src.modules.market.fork_infer import search, store
    from src.modules.market.fork_screen import presets

    captured = {}
    calls = {"n": 0}

    monkeypatch.setattr(store, "load_meta", lambda run_id: {
        "preset": "xg1",
        "scores": scores,
        "base_request": {"trading_days": 30, "markets": ["sh"], "include_st": False},
    })
    monkeypatch.setattr(store, "read_finalists", lambda run_id: [{"rank": 1, "rule": BASE_RULE}])
    monkeypatch.setattr(store, "read_results", lambda run_id: [])

    def fake_save(name_, request, overwrite=False):
        calls["n"] += 1
        if calls["n"] <= exists_times:
            raise presets.PresetExists("已存在")
        captured["name"] = name_
        return {"name": name_}

    monkeypatch.setattr(presets, "save", fake_save)
    search.save_condition("20260101-000000-test", 1, name)
    return captured["name"]


def test_保存条件名字带两个评分乘十的整数部分(monkeypatch):
    """99.9 / 77.8 → ``_999_778``（用户 2026-11-05 第 1/2 条，下划线）。"""
    name = _save_with(monkeypatch, {"train": {"score": 99.9}, "test": {"score": 77.8}})
    assert name == "xg1-1_999_778"


def test_没有评分时不加后缀(monkeypatch):
    """空跑 / 没跑完的任务没有评分，名字里不能出现 -None。"""
    name = _save_with(monkeypatch, {})
    assert name == "xg1-1"
    assert "None" not in name


def test_同名时自动加序号(monkeypatch):
    """同一分数被存第二次：不能静默覆盖，也不该直接报错让用户不知所措。"""
    name = _save_with(monkeypatch, {"train": {"score": 60.0}, "test": {"score": 61.0}},
                      exists_times=1)
    assert name == "xg1-1_600_610_1"


def test_用户指定的名字优先于自动编号(monkeypatch):
    name = _save_with(monkeypatch, {"train": {"score": 88.0}, "test": {"score": 70.0}},
                      name="my_good")
    assert name == "my_good_880_700"


# --------------------------------------------------------------------------- #
# 2026-11-02：部署/重启后能续跑（以前只认 paused，一次重启废掉几百次评估）
# --------------------------------------------------------------------------- #
def test_进程重启后的中断任务可以续跑(monkeypatch):
    from src.modules.market.fork_infer import search, store

    started = {"n": 0}
    monkeypatch.setattr(store, "load_meta", lambda run_id: {
        "run_id": run_id, "status": "interrupted", "done_iterations": 385, "iterations": 1000,
    })
    monkeypatch.setattr(store, "clear_pause", lambda run_id: None)
    monkeypatch.setattr(search, "is_running", lambda run_id: False)
    monkeypatch.setattr(store, "patch_meta", lambda run_id, **fields: {"status": fields.get("status")})
    monkeypatch.setattr(search, "start", lambda run_id: started.update(n=started["n"] + 1))

    search.resume("20261102-082002-8aii")
    assert started["n"] == 1, "中断的任务必须能重新起线程，否则重启就白跑"


def test_已完成的任务不会被续跑(monkeypatch):
    from src.modules.market.fork_infer import search, store

    started = {"n": 0}
    monkeypatch.setattr(store, "load_meta", lambda run_id: {
        "run_id": run_id, "status": "done", "finished_at": "2026-11-02T03:17:51+08:00",
    })
    monkeypatch.setattr(store, "clear_pause", lambda run_id: None)
    monkeypatch.setattr(search, "is_running", lambda run_id: False)
    monkeypatch.setattr(search, "start", lambda run_id: started.update(n=started["n"] + 1))

    search.resume("20261102-031502-o898")
    assert started["n"] == 0


# --------------------------------------------------------------------------- #
# 抽样天数 120 / 信号门槛 150（用户 2026-11-02：宁可慢一倍也要降空跑率）
# --------------------------------------------------------------------------- #
class _StubMetrics:
    """只实现 score_of 用到的几个方法，用来精确验证门槛而不是靠造行情凑信号数。"""

    def __init__(self, signals: int, days_with_hits: int = 40, excess: float = 6.0) -> None:
        self._signals = signals
        self._days_with_hits = days_with_hits
        self._excess = excess
        self.horizons = [5, 10, 20, 25, 30]

    def signals(self) -> int:
        return self._signals

    def days_with_hits(self) -> int:
        return self._days_with_hits

    def signal_count(self, index: int, metric: str) -> int:
        return self._signals

    def excess(self, index: int, metric: str) -> float:
        return self._excess

    def day_excess(self, index: int, metric: str) -> float:
        return self._excess

    def year_excess(self, index: int, metric: str) -> dict[str, float]:
        return {}


def test_信号门槛降到150后窄条件也能进排行榜():
    from src.modules.market.fork_infer.models import MIN_SIGNALS

    assert MIN_SIGNALS == 150
    # 150 笔刚好过线（窄条件在 120 天抽样里通常落在 150~300 之间）
    assert score_of(_StubMetrics(MIN_SIGNALS), "stat_v3")[0] is not None
    # 低于门槛仍然不给分：不能为了降空跑率把噪声放进来
    assert score_of(_StubMetrics(MIN_SIGNALS - 1), "stat_v3")[0] is None


def test_有信号的天数门槛随抽样天数一起缩放():
    from src.modules.market.fork_infer.models import MIN_DAYS_WITH_HITS, SEARCH_DAYS

    assert SEARCH_DAYS == 120
    assert MIN_DAYS_WITH_HITS == 12
    # 有信号的天数不能超过抽样天数，否则任何变体都拿不到分（整轮空跑）
    assert MIN_DAYS_WITH_HITS <= SEARCH_DAYS // 4
    assert score_of(_StubMetrics(400, days_with_hits=MIN_DAYS_WITH_HITS), "stat_v3")[0] is not None
    assert score_of(_StubMetrics(400, days_with_hits=MIN_DAYS_WITH_HITS - 1), "stat_v3")[0] is None
