"""量价条件 / 第二批条件 / 指定 asof 的单测（2026-10 第二批）。

覆盖四类容易写错的东西：

1. **开区间**：``min < x < max``，等于边界不算命中；
2. **单位**：成交量输入是万手（股 ÷ 1e6）、成交额是亿元（元 ÷ 1e8）；
3. **停牌行**：库里有行但 ``volume/amount/turnover = 0``、``high/low`` 为 NULL ——
   量价条件按**数据不足**处理，不当 0 用；
4. **指定 asof**：日期落到 ≤ 该日的最大交易日，窗口从它往前数。
"""

from __future__ import annotations

import datetime as dt

import pytest

from src.modules.market.fork_screen import repository
from src.modules.market.fork_screen import service as screen_service
from src.modules.market.fork_screen.conditions import (
    CONDITIONS,
    EvalContext,
    StockSeries,
    extras_columns_of,
)
from src.modules.market.fork_screen.evaluator import build_series, compile_rule, required_bars_of_group
from src.modules.market.fork_screen.models import ScreenRequest
from src.modules.market.fork_screen.repository import ScreenData

END = dt.date(2026, 10, 16)


def day(offset: int) -> dt.date:
    return END - dt.timedelta(days=offset)


def rows_of(
    closes: list[float],
    volumes: list[float] | None = None,
    turnovers: list[float] | None = None,
    traded: list[int] | None = None,
    adj: float = 1.0,
) -> list[tuple]:
    """升序日线行；列顺序与 ``repository.extras_select`` 一致。

    带量价列时是 ``(date, open, close, pre_close, adj, traded, volume, amount, turnover)``。
    """
    total = len(closes)
    rows = []
    for index, close in enumerate(closes):
        trade_date = day(total - 1 - index)
        pre = closes[index - 1] if index else close
        volume = volumes[index] if volumes else 1_000_000.0
        turnover = turnovers[index] if turnovers else 1.0
        flag = traded[index] if traded else 1
        rows.append(
            (
                trade_date,
                close,
                close,
                pre,
                adj,
                flag,
                volume,
                volume * close,
                turnover,
            )
        )
    return rows


EXTRAS = ("traded", "volume", "amount", "turnover_rate")


def series_of(closes, **kwargs) -> StockSeries:
    rows = rows_of(closes, **kwargs)
    series = build_series("sh600000", rows, EXTRAS)
    assert series is not None
    return series


def ctx_of(series: StockSeries, trading_days: int = 30) -> EvalContext:
    calendar = [bar.trade_date for bar in reversed(series.bars)]
    return EvalContext(calendar=calendar, trading_days=trading_days, code="600000", name="浦发银行")


def evaluate(name: str, series: StockSeries, trading_days: int = 30, **params):
    """``trading_days`` 与条件自己的 ``days`` 参数是两回事，名字别撞。"""
    spec = CONDITIONS[name]
    parsed = spec.params_model.model_validate(params)
    ctx = ctx_of(series, trading_days)
    return spec.evaluate(series, parsed, ctx), ctx


# ---------------------------------------------------------------- 涨跌幅


def test_涨跌幅开区间_等于边界不算命中():
    series = series_of([10.0, 12.0])  # 最后一根 +20%
    hit, ctx = evaluate("change_pct", series, n=1, min=10, max=20)
    assert hit is False and ctx.insufficient is False
    hit, _ = evaluate("change_pct", series, n=1, min=10, max=20.01)
    assert hit is True


def test_涨跌幅每日_有一天不满足即否():
    series = series_of([10.0, 11.0, 10.0, 11.0])  # +10%, -9.1%, +10%
    hit, _ = evaluate("change_pct_all", series, n=1, m=2, min=0, max=100)
    assert hit is False  # 倒数第 2 天是跌的


def test_涨跌幅任意一天_命中一天即可():
    series = series_of([10.0, 11.0, 10.0, 11.0])
    hit, _ = evaluate("change_pct_any", series, n=1, m=2, min=0, max=100)
    assert hit is True


def test_区间涨跌幅用复权价():
    # 不复权 20 → 30 看着是 +50%，但 adj 从 1.0 掉到 0.6（除权）时复权价是 20 → 18
    rows = [
        (day(1), 20.0, 20.0, 20.0, 1.0, 1, 1e6, 2e7, 1.0),
        (day(0), 30.0, 30.0, 20.0, 0.6, 1, 1e6, 3e7, 1.0),
    ]
    series = build_series("sh600000", rows, EXTRAS)
    assert series is not None
    # 复权：20 → 18 = -10%
    hit, _ = evaluate("change_pct_span", series, n=1, m=2, min=-11, max=-9)
    assert hit is True


# ---------------------------------------------------------------- 换手率 / 单位


def test_换手率单日_单位是百分数():
    series = series_of([10.0, 10.0], turnovers=[1.0, 5.0])
    hit, _ = evaluate("turnover_single", series, n=1, min=4.9, max=5.1)
    assert hit is True


def test_停牌行的换手率按数据不足处理():
    """停牌日 traded=0（high/low 为 NULL、volume/turnover 都是 0）—— 不能当成「换手率 0 < 5%」命中。"""
    series = series_of(
        [10.0, 10.0],
        volumes=[1e6, 0.0],
        turnovers=[1.0, 0.0],
        traded=[1, 0],
    )
    hit, ctx = evaluate("turnover_all", series, n=1, m=2, min=0, max=100)
    assert hit is False
    assert ctx.insufficient is True


def test_成交量单位是万手():
    series = series_of([10.0, 10.0], volumes=[1_000_000.0, 1_000_000.0])  # 1e6 股 = 1 万手
    hit, _ = evaluate("volume_single", series, n=1, min=0.5, max=1.5)
    assert hit is True
    hit, _ = evaluate("volume_single", series, n=1, min=1.5, max=3)
    assert hit is False


def test_成交额单位是亿元():
    series = series_of([10.0, 10.0], volumes=[1_000_000.0] * 2)  # 1e6 股 × 10 元 = 1e7 元 = 0.1 亿
    hit, _ = evaluate("amount_single", series, n=1, min=0.09, max=0.11)
    assert hit is True


def test_区间累计成交量是合计():
    series = series_of([10.0] * 3, volumes=[1e6, 2e6, 3e6])
    hit, _ = evaluate("volume_span", series, n=1, m=3, min=5.9, max=6.1)  # 1+2+3 万手
    assert hit is True


# ---------------------------------------------------------------- 量比


def test_量比是当日量除以前五日均量():
    series = series_of([10.0] * 6, volumes=[100.0] * 5 + [200.0])
    hit, _ = evaluate("vol_ratio_single", series, n=1, min=1.9, max=2.1)
    assert hit is True


def test_量比_history_不够时判数据不足():
    series = series_of([10.0] * 3, volumes=[100.0, 100.0, 200.0])
    hit, ctx = evaluate("vol_ratio_single", series, n=1, min=0, max=10)
    assert hit is False
    assert ctx.insufficient is True


def test_连续量比_每天都达标才成立():
    series = series_of([10.0] * 6, volumes=[100.0] * 5 + [200.0])
    hit, _ = evaluate("vol_ratio_consecutive", series, start=1, days=1, min=1.5, max=5)
    assert hit is True
    hit, _ = evaluate("vol_ratio_consecutive", series, start=1, days=2, min=1.5, max=5)
    assert hit is False  # 倒数第 2 天量比 = 1.0


def test_连续缩量():
    # 10 根递减量：每一天都要有前 5 日均量，所以至少 6 根才够算第一天
    series = series_of(
        [10.0] * 10,
        volumes=[2000.0, 1800.0, 1600.0, 1400.0, 1200.0, 1000.0, 900.0, 800.0, 700.0, 600.0],
    )
    hit, _ = evaluate("consecutive_shrinking", series, start=1, days=3, min=0, max=1)
    assert hit is True


# ---------------------------------------------------------------- 第二批


def test_连续下跌():
    series = series_of([10.0, 9.8, 9.6, 9.4])
    hit, _ = evaluate("consecutive_falling", series, start=1, days=3)
    assert hit is True
    hit, _ = evaluate("consecutive_falling", series, start=1, days=4)
    assert hit is False


def test_创M日新高_不含当日():
    series = series_of([10.0, 11.0, 12.0, 13.0])
    hit, _ = evaluate("new_high", series, m=3)
    assert hit is True
    hit, _ = evaluate("new_low", series, m=3)
    assert hit is False


def test_创M日新高_历史不够判数据不足():
    series = series_of([10.0, 11.0])
    hit, ctx = evaluate("new_high", series, m=5)
    assert hit is False
    assert ctx.insufficient is True


def test_均线金叉():
    closes = [10.0] * 10 + [11.0]  # 最后一根 MA5 上穿 MA10
    series = series_of(closes)
    hit, _ = evaluate("ma_golden_cross", series, fast=5, slow=10)
    assert hit is True
    hit, _ = evaluate("ma_dead_cross", series, fast=5, slow=10)
    assert hit is False


# ---------------------------------------------------------------- 股票代码/名称


def test_股票代码或名称完整匹配():
    series = series_of([10.0, 10.0])
    hit, _ = evaluate("stock_match", series, text="600000")
    assert hit is True
    hit, _ = evaluate("stock_match", series, text="浦发银行")
    assert hit is True
    hit, _ = evaluate("stock_match", series, text="600000, 浦发银行")
    assert hit is True


def test_股票代码必须完整相等():
    series = series_of([10.0, 10.0])
    for text in ("60000", "6000001", "浦发", "浦发银行股份有限公司"):
        hit, _ = evaluate("stock_match", series, text=text)
        assert hit is False, text


# ---------------------------------------------------------------- 校验


def test_区间形状的校验文案():
    spec = CONDITIONS["turnover_all"]
    issues = spec.validate(spec.params_model.model_validate({"n": 5, "m": 3}), 30)
    assert any("M ≥ N" in issue for issue in issues)

    issues = spec.validate(spec.params_model.model_validate({"n": 1, "m": 31}), 40)
    assert any("跨度" in issue for issue in issues)

    issues = spec.validate(spec.params_model.model_validate({"n": 1, "m": 5, "min": 9, "max": 1}), 30)
    assert any("下限必须小于上限" in issue for issue in issues)


def test_均线金叉校验快线必须小于慢线():
    spec = CONDITIONS["ma_golden_cross"]
    issues = spec.validate(spec.params_model.model_validate({"fast": 10, "slow": 5}), 30)
    assert issues


def test_股票匹配校验空文本():
    spec = CONDITIONS["stock_match"]
    assert spec.validate(spec.params_model.model_validate({"text": "  "}), 30)


# ---------------------------------------------------------------- 取列与根数


def test_bars_sql_按需取列():
    plain = repository.bars_sql()
    assert "volume" not in plain and "traded" not in plain

    # 换手率只要 turnover_rate + traded（停牌标记），不带 volume/amount
    turnover = repository.bars_sql(("turnover_rate",))
    assert "turnover_rate" in turnover and "traded" in turnover
    assert "volume" not in turnover and "amount" not in turnover

    # 成交额只要 amount
    amount = repository.bars_sql(("amount",))
    assert "amount" in amount and "volume" not in amount

    # 量比要 volume
    ratio = repository.bars_sql(("volume",))
    assert "volume" in ratio and "amount" not in ratio


def test_extras_select_顺序固定且总带_traded():
    assert repository.extras_select(()) == ()
    assert repository.extras_select({"turnover_rate", "volume"}) == ("traded", "volume", "turnover_rate")


def test_needs_extras_只在量价条件上为真():
    assert CONDITIONS["turnover_single"].extras_columns == ("turnover_rate",)
    assert CONDITIONS["amount_all"].extras_columns == ("amount",)
    assert CONDITIONS["vol_ratio_single"].extras_columns == ("volume",)
    assert CONDITIONS["change_pct_all"].extras_columns == ()
    assert CONDITIONS["close_above_ma"].extras_columns == ()


def _request(rule: dict) -> ScreenRequest:
    return ScreenRequest.model_validate(
        {
            "trading_days": 30,
            "markets": ["sh"],
            "include_st": False,
            "market_cap": {"min_yi": 1, "max_yi": 100000},
            "rule": {"type": "group", "id": "root", "operator": "AND", "children": [rule]},
        }
    )


def _condition(name: str, **params) -> dict:
    return {"type": "condition", "id": name, "name": name, "params": params}


def test_extras_columns_of_识别树里的量价条件():
    plain = compile_rule(_request(_condition("close_above_ma", period=5)))
    assert extras_columns_of(plain) == frozenset()
    mixed = compile_rule(
        _request(
            {
                "type": "group",
                "id": "g",
                "operator": "OR",
                "children": [_condition("close_above_ma", period=5), _condition("volume_single", n=1)],
            }
        )
    )
    assert extras_columns_of(mixed) == frozenset({"volume"})
    both = compile_rule(
        _request(
            {
                "type": "group",
                "id": "g",
                "operator": "AND",
                "children": [
                    _condition("turnover_single", n=1),
                    _condition("amount_span", n=1, m=5),
                ],
            }
        )
    )
    assert extras_columns_of(both) == frozenset({"turnover_rate", "amount"})


def test_量价条件的_K_含预热根数():
    # vol_ratio_single 需要 n + window 根
    rule = compile_rule(_request(_condition("vol_ratio_single", n=1, window=5, min=0, max=10)))
    assert required_bars_of_group(rule, 30) == 30  # 窗口 30 更大
    rule = compile_rule(_request(_condition("vol_ratio_single", n=28, window=5, min=0, max=10)))
    assert required_bars_of_group(rule, 30) == 33


# ---------------------------------------------------------------- 指定 asof


def test_候选SQL_锚点能被替换成指定日期():
    sql = repository.candidate_sql(dt.date(2026, 9, 1))
    assert "DATE '2026-09-01'" in sql
    assert repository._LATEST_ANCHOR not in sql
    # 不带日期时保持原样
    assert repository._LATEST_ANCHOR in repository.candidate_sql()


def test_锚点在_WITH_UNI_里只出现一次():
    """替换是字符串级的：锚点出现两次就会只替换掉一处，静默算错日期。"""
    from src.modules.market.api import fork_market

    assert fork_market._WITH_UNI.count(repository._LATEST_ANCHOR) == 1


def test_run_screen_把指定日期解析成交易日并传给取数层(monkeypatch):
    captured: dict = {}

    def fake_resolve(day_value):
        captured["requested"] = day_value
        return dt.date(2026, 9, 1)  # 9/1 是周二，这里假装解析成功

    def fake_fetch(req, k, **kwargs):
        captured["asof"] = kwargs.get("asof")
        captured["extras"] = kwargs.get("extras")
        return ScreenData(asof=dt.date(2026, 9, 1), candidates=[], calendar=[dt.date(2026, 9, 1)])

    monkeypatch.setattr(screen_service, "resolve_asof", fake_resolve)
    monkeypatch.setattr(screen_service, "fetch_screen_data", fake_fetch)

    body = screen_service.run_screen(_request(_condition("volume_single", n=1)), asof=dt.date(2026, 9, 5))
    assert captured["requested"] == dt.date(2026, 9, 5)
    assert captured["asof"] == dt.date(2026, 9, 1)
    assert captured["extras"] == frozenset({"volume"})
    assert body["asof"] == "2026-09-01"
    assert body["requested_asof"] == "2026-09-05"


def test_run_screen_日期早于全部数据时报错(monkeypatch):
    monkeypatch.setattr(screen_service, "resolve_asof", lambda day_value: None)
    with pytest.raises(screen_service.ScreenNoData):
        screen_service.run_screen(_request(_condition("close_above_ma", period=5)), asof=dt.date(1990, 1, 1))


def test_请求体可以带_asof_也会被存进已保存条件():
    req = ScreenRequest.model_validate(
        {
            "trading_days": 30,
            "markets": ["sh"],
            "market_cap": {"min_yi": 1, "max_yi": 100},
            "rule": {"type": "group", "id": "root", "operator": "AND", "children": []},
            "asof": "2026-09-01",
        }
    )
    assert req.asof == dt.date(2026, 9, 1)
    assert req.model_dump(mode="json")["asof"] == "2026-09-01"
