"""评分系统（0–100）的回归测试。

评分是「一眼看好坏」的唯一出口，错了不会报错、只会让人误判一个条件，
所以每条规则都钉一个测试：锚点、公式可复算、保守性（用下限）、封顶、两段合成。
"""

from __future__ import annotations

import datetime as _dt

import pytest

from src.modules.market.fork_analysis import scoring


def window(horizon: int, excess: float, *, t: float | None = -4.0, n: int = 5000,
           n_eff: int = 100, expectancy: float | None = 1.0,
           lower: float | None = None) -> dict:
    """构造一个周期行：excess 为正表示条件比随机好（单位 pp）。"""
    row = {
        "window": horizon,
        "n": n,
        "excess_pp": excess,
        "t": t,
        "n_eff": n_eff,
        "expectancy": expectancy,
    }
    if lower is not None:
        row["lower_pp"] = lower
    return row


def test_零超额刚好五十分_这是锚点():
    """50 = 和随机买入完全一样 —— 整个量表都靠这个锚点解释。"""
    result = scoring.score_segment(windows=[window(30, 0.0)], events=5000, days=200)
    assert result["score"] == pytest.approx(50.0, abs=0.6)
    assert result["grade"] == "D"


def test_每多五分就是一个百分点():
    """用户定的换算：50 + 5 × 超额下限(pp)。直接对公式复算。"""
    for excess in (1.0, 2.0, 4.0, 7.0):
        result = scoring.score_segment(windows=[window(30, excess, lower=excess)],
                                       events=5000, days=200)
        assert result["score"] == pytest.approx(50.0 + 5.0 * excess, abs=0.1)


def test_两pp过及格线():
    """60 分 = 比随机好 2pp，这是「能拿去用」的最低门槛。"""
    result = scoring.score_segment(windows=[window(30, 2.0, lower=2.0)],
                                   events=5000, days=200)
    assert result["score"] == pytest.approx(60.0, abs=0.1)
    assert result["grade"] == "C"


def test_十pp封顶一百分():
    """超额 10pp 及以上就是满分，再高不给更多分。"""
    result = scoring.score_segment(windows=[window(30, 18.0, lower=18.0)],
                                   events=5000, days=200)
    assert result["score"] == pytest.approx(100.0, abs=0.1)
    assert result["grade"] == "A"


def test_同样超额_样本少_下界低_分更低():
    """保守性的核心：点估计一样，但 t 小（信息少）分数必须更低。"""
    strong = scoring.score_segment(windows=[window(30, 4.0, t=-20.0)], events=5000, days=200)
    weak = scoring.score_segment(windows=[window(30, 4.0, t=-2.2)], events=5000, days=200)
    assert weak["score"] < strong["score"] - 8


def test_显式下限优先_重叠折进分数():
    """调用方算好 Newey–West 下限时，分数直接由它决定（重叠样本已经折进去了）。"""
    row = window(30, 5.0, lower=0.4)
    result = scoring.score_segment(windows=[row], events=5000, days=200)
    assert result["lower_pp"] == pytest.approx(0.4)
    assert result["score"] == pytest.approx(52.0, abs=0.1)


def test_负超额掉到不可用():
    result = scoring.score_segment(windows=[window(30, -3.0, lower=-3.0)],
                                   events=5000, days=200)
    assert result["score"] == pytest.approx(35.0, abs=0.1)
    assert result["grade"] == "E"


def test_样本不足封顶55():
    result = scoring.score_segment(windows=[window(30, 9.0, lower=9.0)], events=120, days=20)
    assert result["score"] <= 55.0
    assert any("有效样本" in item for item in result["caps"])


def test_独立片段不足封顶55():
    """窗口重叠太多 → 有效样本其实很少，再高的分也不能及格。"""
    result = scoring.score_segment(
        windows=[window(30, 9.0, lower=9.0, n_eff=8)], events=5000, days=200)
    assert result["score"] <= 55.0
    assert any("独立片段" in item for item in result["caps"])


def test_信号太稀疏封顶55():
    """每天不到半个信号 → 挑不出来，再高的概率也没用。"""
    result = scoring.score_segment(windows=[window(30, 9.0, lower=9.0)], events=800, days=4000)
    assert result["score"] <= 55.0
    assert any("挑不出来" in item for item in result["caps"])


def test_成本升到04后转负_封顶55():
    result = scoring.score_segment(windows=[window(30, 6.0, lower=6.0)], events=5000, days=200,
                                   stress_excess=-0.4)
    assert result["score"] <= 55.0
    assert any("0.4%" in item for item in result["caps"])


def test_平均最高盈利为负_封顶55():
    result = scoring.score_segment(windows=[window(30, 6.0, lower=6.0, expectancy=-0.4)],
                                   events=5000, days=200)
    assert result["score"] <= 55.0


def test_没有对照就不给分():
    """没有同日基准时「胜率 47%」没有参照系，宁可返回 None 也不编一个分。"""
    empty = [{"window": 30, "n": 100, "excess_pp": None, "t": None,
              "n_eff": None, "expectancy": 1.0}]
    result = scoring.score_segment(windows=empty, events=100, days=50)
    assert result["score"] is None
    assert result["grade"] == "-"


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


def test_公式函数本身():
    """把公式单独抽出来，方便报告里直接引用同一个实现。"""
    assert scoring.score_from_lower(None) is None
    assert scoring.score_from_lower(0.0) == pytest.approx(50.0)
    assert scoring.score_from_lower(2.0) == pytest.approx(60.0)
    assert scoring.score_from_lower(10.0) == pytest.approx(100.0)
    assert scoring.score_from_lower(30.0) == pytest.approx(100.0)
    assert scoring.score_from_lower(-20.0) == pytest.approx(0.0)


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
