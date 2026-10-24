"""评分系统（0–100）的回归测试。

评分是「一眼看好坏」的唯一出口，错了不会报错、只会让人误判一个条件，
所以每条规则都钉一个测试：锚点、保守性、封顶、两段合成。
"""

from __future__ import annotations

import datetime as _dt

import pytest

from src.modules.market.fork_analysis import scoring


def window(horizon: int, excess: float, *, t: float | None = -4.0, n: int = 5000,
           n_eff: int = 100, expectancy: float | None = 0.01) -> dict:
    """构造一个周期行：excess 为正表示条件比随机好。"""
    return {
        "window": horizon,
        "n": n,
        "p_net": 50.0,
        "base_p": 50.0 - excess,
        "excess_pp": excess,
        "t": t,
        "n_eff": n_eff,
        "expectancy": expectancy,
        "payoff": 1.3,
        "median": 0.0,
    }


def test_零超额刚好五十分_这是锚点():
    """50 = 和随机买入完全一样 —— 整个量表都靠这个锚点解释。"""
    result = scoring.score_segment(windows=[window(5, 0.0), window(10, 0.0)],
                                   events=5000, days=200)
    assert result["score"] == pytest.approx(50.0, abs=0.6)
    assert result["grade"] == "D"


def test_两pp下界能到及格线附近():
    """下界 2pp 应该落在 60 分上下：这是「能用」的最低门槛。"""
    # t 大 → 下界≈点估计，2pp 的下界 = 2pp 的超额
    result = scoring.score_segment(windows=[window(10, 2.0, t=-20.0)],
                                   events=5000, days=200)
    assert 58.0 <= result["score"] <= 66.0
    assert result["grade"] in ("C", "D")


def test_超额八pp以上拿满分_edge():
    """下界到 8pp 就吃满 40 分优势分（点估计 8pp 但 t 很大时下界才够）。"""
    result = scoring.score_segment(windows=[window(20, 10.0, t=-40.0)], events=5000, days=200)
    assert result["components"]["edge"] == pytest.approx(scoring.EDGE_MAX, abs=0.2)
    assert result["score"] >= 85.0
    assert result["grade"] == "A"


def test_同样超额_样本少_下界低_分更低():
    """保守性的核心：点估计一样，但 t 小（信息少）分数必须更低。"""
    strong = scoring.score_segment(windows=[window(10, 4.0, t=-20.0)], events=5000, days=200)
    weak = scoring.score_segment(windows=[window(10, 4.0, t=-2.2)], events=5000, days=200)
    assert weak["score"] < strong["score"] - 8


def test_负超额掉到不可用():
    result = scoring.score_segment(windows=[window(10, -3.0, t=-8.0)], events=5000, days=200)
    assert result["score"] < 45.0
    assert result["grade"] == "E"


def test_样本不足封顶55():
    result = scoring.score_segment(windows=[window(10, 9.0, t=-20.0)], events=120, days=20)
    assert result["score"] <= 55.0
    assert any("有效样本" in item for item in result["caps"])


def test_信号太稀疏封顶55():
    """每天不到半个信号 → 挑不出来，再高的概率也没用。"""
    result = scoring.score_segment(windows=[window(10, 9.0, t=-20.0)], events=800, days=4000)
    assert result["score"] <= 55.0
    assert any("挑不出来" in item for item in result["caps"])


def test_成本升到04后转负_封顶55():
    result = scoring.score_segment(windows=[window(10, 6.0, t=-20.0)], events=5000, days=200,
                                   stress_excess=-0.4)
    assert result["score"] <= 55.0
    assert any("0.4%" in item for item in result["caps"])


def test_期望收益为负_封顶55():
    result = scoring.score_segment(windows=[window(10, 6.0, t=-20.0, expectancy=-0.004)],
                                   events=5000, days=200)
    assert result["score"] <= 55.0


def test_稳健分看三个一致性():
    """只在单周期/单年/单板块有效，拿不到稳健分。"""
    solo = scoring.score_segment(windows=[window(10, 4.0, t=-20.0), window(20, -1.0, t=-4)],
                                 events=5000, days=200, year_excess=[3.0, -1.0],
                                 layer_excess=[2.0, -2.0])
    broad = scoring.score_segment(
        windows=[window(5, 3.0, t=-9.0), window(10, 4.0, t=-9.0), window(20, 4.0, t=-9.0)],
        events=5000, days=200, year_excess=[3.0, 2.0, 1.0], layer_excess=[2.0, 1.0])
    assert broad["components"]["robust"] > solo["components"]["robust"] + 3
    assert broad["score"] > solo["score"]


def test_没有对照就不给分():
    """没有同日基准时「胜率 47%」没有参照系，宁可返回 None 也不编一个分。"""
    empty = [{"window": 5, "n": 100, "p_net": 47.0, "base_p": None,
              "excess_pp": None, "t": None, "n_eff": None, "expectancy": 0.01}]
    result = scoring.score_segment(windows=empty, events=100, days=50)
    assert result["score"] is None
    assert result["grade"] == "-"


def test_测试段衰减扣分():
    train = scoring.score_segment(windows=[window(10, 6.0, t=-14.0)], events=5000, days=200)
    valid = scoring.score_segment(windows=[window(10, 0.5, t=-1.0)], events=3000, days=150,
                                  reference=train)
    assert valid["components"]["decay"] < 0
    assert valid["score"] < train["score"]


def test_两段合成规则():
    good = {"score": 72.0}
    bad = {"score": 38.0}
    assert scoring.combined(good, good)["verdict"] == "pass"
    assert scoring.combined(good, bad)["verdict"] == "fragile"
    assert scoring.combined(bad, bad)["verdict"] == "fail"
    assert scoring.combined({"score": 52.0}, {"score": 55.0})["verdict"] == "watch"
    assert scoring.combined({"score": None}, None)["verdict"] == "unknown"


def test_等级边界():
    assert scoring.grade_of(86.0)[0] == "A"
    assert scoring.grade_of(70.0)[0] == "B"
    assert scoring.grade_of(60.0)[0] == "C"
    assert scoring.grade_of(45.0)[0] == "D"
    assert scoring.grade_of(10.0)[0] == "E"
    assert scoring.grade_of(None)[0] == "-"


# --------------------------------------------------------------------------- #
# 两段时间（推理段 + 测试段）
# --------------------------------------------------------------------------- #
def test_分析任务支持测试段字段():
    """创建表单要能带测试段；不传时是 None（老客户端不受影响）。"""
    from src.modules.market.fork_analysis.models import AnalysisCreate

    single = AnalysisCreate(preset="xg1", start_date=_dt.date(2024, 1, 1))
    assert single.test_start_date is None and single.test_end_date is None
    both = AnalysisCreate(
        preset="xg1",
        start_date=_dt.date(2024, 1, 1),
        end_date=_dt.date(2025, 12, 31),
        test_start_date=_dt.date(2026, 1, 1),
        test_end_date=_dt.date(2026, 9, 1),
    )
    assert both.test_start_date == _dt.date(2026, 1, 1)
    assert both.method == "stat_v3"

