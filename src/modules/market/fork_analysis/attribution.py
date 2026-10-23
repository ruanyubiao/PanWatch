"""因子归因：条件剩下的超额，有多少是它自己带来的。

为什么需要
----------
分组表能看出「小市值 +3.9pp」，但那只能一次挡一个变量。真实情况是：命中股票
天然偏小市值、偏低流动性、偏高波动，而这些属性本身就对应不同的胜率。市值匹配
的对照组只挡掉了市值一个维度，剩下的（行业、年份、换手、振幅、大盘环境）还在
里面，于是「条件的优势」被高估。

做法
----
把命中与对照**合在一起**做一个 logistic 回归：

    P(上涨) = σ(β₀ + β₁·是否命中 + γ·控制变量 + 年度/行业虚拟变量)

β₁ 就是「控制掉这些变量之后，命中相对没命中还剩多少」。报告给三个数：

- ``raw_excess_pp``：不控制任何变量时的胜率差（就是合并超额）；
- ``adjusted_excess_pp``：控制后剩下的（β₁ 在均值处的边际效应，百分点）；
- ``explained_pct``：被这些变量解释掉的比例。100% 意味着条件没有独立信息，
  优势全来自「它选中了小盘股」。

系数用岭回归（λ = 1e-4）稳定，虚拟变量多的时候不会因为完全分离而发散。
"""

from __future__ import annotations

import math
import sqlite3
from typing import Any, Optional, Sequence

import numpy as np

#: 参与归因的最大行数（信号 + 对照）。超过就按行号等距抽对照，信号全留。
MAX_ROWS = 400_000
#: 岭回归强度（只作用于非常数项）
RIDGE = 1e-4
#: 行业虚拟变量最多保留的类别数（按样本量取前 N）
TOP_INDUSTRIES = 12

_NUMERIC = (
    ("mcap", "总市值"),
    ("amount", "成交额"),
    ("turnover", "换手率"),
    ("amplitude", "振幅"),
    ("listed_days", "上市天数"),
    ("breadth", "大盘环境"),
)


def _log(value: Optional[float]) -> Optional[float]:
    if value is None or value <= 0:
        return None
    return math.log(value)


def _load(conn: sqlite3.Connection, horizon: int, prefix: str, cost: Any) -> list[tuple]:
    """读归因用的行：``(is_control, y, 数值特征…, industry, year, pe)``。"""
    base = f"{prefix}{horizon}"
    col = f"({base} - {cost})" if cost else base
    columns = {str(row[1]) for row in conn.execute("PRAGMA table_info(signals)")}
    has_snapshot = "mcap" in columns
    numeric = ["mcap", "amount", "turnover", "amplitude", "listed_days", "breadth"] if has_snapshot \
        else ["NULL", "NULL", "NULL", "NULL", "NULL", "NULL"]
    industry = "COALESCE(NULLIF(industry, ''), '未知')" if has_snapshot else "'未知'"
    pe = "pe" if has_snapshot else "NULL"
    valid = "(verif IS NULL OR verif = 1)"
    if prefix == "x":
        valid += " AND (unfillable IS NULL OR unfillable = 0)"
    sql = (
        f"SELECT is_control, CASE WHEN {col} > 0 THEN 1 ELSE 0 END AS y, "
        + ", ".join(numeric) + f", {industry} AS industry, SUBSTR(d0, 1, 4) AS year, {pe} AS pe, d0 "
        f"FROM signals WHERE {base} IS NOT NULL AND {valid}"
    )
    return [tuple(row) for row in conn.execute(sql)]


def _thin(rows: Sequence[tuple]) -> list[tuple]:
    """信号全留，对照等距抽样，总行数不超过 ``MAX_ROWS``。"""
    signals = [row for row in rows if int(row[0]) == 0]
    controls = [row for row in rows if int(row[0]) == 1]
    budget = max(1, MAX_ROWS - len(signals))
    if len(controls) > budget:
        step = len(controls) / budget
        controls = [controls[int(index * step)] for index in range(budget)]
    return signals + controls


def _standardise(matrix: np.ndarray, columns: list[int]) -> None:
    for column in columns:
        values = matrix[:, column]
        mean = float(np.mean(values))
        std = float(np.std(values))
        if std <= 0:
            matrix[:, column] = 0.0
            continue
        matrix[:, column] = (values - mean) / std


def _fit(matrix: np.ndarray, target: np.ndarray, ridge: float = RIDGE,
         iterations: int = 30) -> tuple[np.ndarray, np.ndarray]:
    """IRLS 求 logistic 系数，返回 ``(beta, 标准误)``。"""
    n, k = matrix.shape
    beta = np.zeros(k, dtype=np.float64)
    penalty = np.full(k, ridge, dtype=np.float64)
    penalty[0] = 0.0
    hessian = np.eye(k)
    for _ in range(iterations):
        eta = matrix @ beta
        np.clip(eta, -35.0, 35.0, out=eta)
        p = 1.0 / (1.0 + np.exp(-eta))
        weight = np.maximum(p * (1.0 - p), 1e-6)
        weighted = matrix.T * weight
        hessian = weighted @ matrix + np.diag(penalty)
        score = matrix.T @ (target - p) - penalty * beta
        try:
            step = np.linalg.solve(hessian, score)
        except np.linalg.LinAlgError:
            break
        beta = beta + step
        if float(np.max(np.abs(step))) < 1e-7:
            break
    try:
        covariance = np.linalg.inv(hessian)
    except np.linalg.LinAlgError:
        covariance = np.diag(np.full(k, np.inf))
    return beta, np.sqrt(np.maximum(np.diag(covariance), 0.0))


def _cluster_se(matrix: np.ndarray, target: np.ndarray, beta: np.ndarray,
                cluster_ids: Sequence[str]) -> np.ndarray:
    """按信号日聚类的稳健标准误（sandwich）。

    同一只股票连续命中、同一天几百只股票共享一段行情 —— 把 40 万行当独立样本，
    p 值会小到没有意义（和两比例 z 检验是同一个错误）。这里按 ``d0`` 聚类。
    """
    n, k = matrix.shape
    eta = np.clip(matrix @ beta, -35.0, 35.0)
    p = 1.0 / (1.0 + np.exp(-eta))
    weight = np.maximum(p * (1.0 - p), 1e-6)
    bread = np.linalg.pinv((matrix.T * weight) @ matrix)
    codes = {value: index for index, value in enumerate(sorted(set(cluster_ids)))}
    groups = np.array([codes[value] for value in cluster_ids])
    count = len(codes)
    scores = np.zeros((count, k), dtype=np.float64)
    residuals = target - p
    for group in range(count):
        mask = groups == group
        # 得分函数是 X'(y−p)；再乘一次 W 会把「肉」压小一个数量级（踩过）。
        scores[group] = matrix[mask].T @ residuals[mask]
    meat = scores.T @ scores
    if count > 1:
        meat *= count / (count - 1)
    covariance = bread @ meat @ bread
    return np.sqrt(np.maximum(np.diag(covariance), 0.0))


def _two_sided_p(z: float) -> float:
    return math.erfc(abs(z) / math.sqrt(2.0))


def fit(conn: sqlite3.Connection, horizon: int = 10, prefix: str = "r",
        cost: Any = 0.0) -> dict[str, Any]:
    """跑一次归因，返回原始/调整后超额与逐特征系数。"""
    raw = _load(conn, horizon, prefix, cost)
    empty = {
        "horizon": horizon, "n": 0, "signals": 0, "controls": 0,
        "raw_excess_pp": None, "adjusted_excess_pp": None, "explained_pct": None,
        "signal_coef": None, "signal_or": None, "signal_z": None, "signal_p": None,
        "features": [], "years": [], "note": "样本不足或缺少横截面字段",
    }
    if not raw:
        return empty
    rows = _thin(raw)
    signals_n = sum(1 for row in rows if int(row[0]) == 0)
    controls_n = len(rows) - signals_n
    if signals_n < 50 or controls_n < 50:
        return {**empty, "n": len(rows), "signals": signals_n, "controls": controls_n}

    # 列顺序：0 is_control, 1 y, 2 mcap, 3 amount, 4 turnover, 5 amplitude,
    # 6 listed_days, 7 breadth, 8 industry, 9 year, 10 pe
    years = sorted({str(row[9]) for row in rows})
    counts: dict[str, int] = {}
    for row in rows:
        counts[str(row[8])] = counts.get(str(row[8]), 0) + 1
    top_industries = [name for name, _n in sorted(counts.items(), key=lambda kv: -kv[1])][:TOP_INDUSTRIES]
    base_industry = top_industries[0] if top_industries else None

    names = ["常数", "是否命中", "log总市值", "log成交额", "换手率", "振幅", "log上市天数",
             "大盘环境", "亏损(PE<0)", "特征缺失"]
    year_columns = years[1:]  # 第一年做基准
    industry_columns = [name for name in top_industries if name != base_industry]
    names += [f"年份{year}" for year in year_columns]
    names += [f"行业:{name}" for name in industry_columns]

    n = len(rows)
    matrix = np.zeros((n, len(names)), dtype=np.float64)
    target = np.zeros(n, dtype=np.float64)
    cluster_ids: list[str] = []
    for index, row in enumerate(rows):
        is_control, y = int(row[0]), int(row[1])
        mcap, amount, turnover, amplitude, listed, breadth = row[2:8]
        industry, year, pe = str(row[8]), str(row[9]), row[10]
        cluster_ids.append(str(row[11]))
        target[index] = y
        matrix[index, 1] = 1.0 if is_control == 0 else 0.0
        matrix[index, 2] = _log(mcap) if mcap is not None else 0.0
        matrix[index, 3] = _log(amount) if amount is not None else 0.0
        matrix[index, 4] = float(turnover) if turnover is not None else 0.0
        matrix[index, 5] = float(amplitude) if amplitude is not None else 0.0
        matrix[index, 6] = math.log(float(listed) + 1.0) if listed is not None else 0.0
        matrix[index, 7] = float(breadth) if breadth is not None else 0.5
        matrix[index, 8] = 1.0 if (pe is not None and float(pe) < 0) else 0.0
        missing = any(value is None for value in (mcap, amount, turnover, amplitude, listed, breadth))
        matrix[index, 9] = 1.0 if missing else 0.0
        if year in year_columns:
            matrix[index, 10 + year_columns.index(year)] = 1.0
        if industry in industry_columns:
            matrix[index, 10 + len(year_columns) + industry_columns.index(industry)] = 1.0
    matrix[:, 0] = 1.0
    # 老任务的对照组没有横截面（只有信号组回填过）：这时「特征缺失」这一列
    # 就等于「是不是对照组」，is_signal 会被它吃掉，归因结果毫无意义。
    signal_missing = float(np.mean(matrix[matrix[:, 1] > 0.5, 9])) if signals_n else 0.0
    control_missing = float(np.mean(matrix[matrix[:, 1] <= 0.5, 9])) if controls_n else 0.0
    if abs(signal_missing - control_missing) > 0.9:
        return {**empty, "n": n, "signals": signals_n, "controls": controls_n,
                "note": "cross_section_missing"}
    _standardise(matrix, [2, 3, 4, 5, 6])

    beta, _plain_se = _fit(matrix, target)
    se = _cluster_se(matrix, target, beta, cluster_ids)
    eta = np.clip(matrix @ beta, -35.0, 35.0)
    p = 1.0 / (1.0 + np.exp(-eta))
    mean_p = float(np.mean(p))

    signal_index = 1
    coef = float(beta[signal_index])
    signal_se = float(se[signal_index])
    z = coef / signal_se if signal_se > 0 else 0.0
    # 平均边际效应（AME）：把「是否命中」在每一行上来回切换，算预测概率差的均值。
    # 用 β·p̄(1−p̄) 这种「均值处的导数」在效应很大（接近 0/1）时会严重高估。
    eta_signal = np.clip(eta + coef * (1.0 - matrix[:, 1]), -35.0, 35.0)
    eta_base = np.clip(eta - coef * matrix[:, 1], -35.0, 35.0)
    p_signal = 1.0 / (1.0 + np.exp(-eta_signal))
    p_base = 1.0 / (1.0 + np.exp(-eta_base))
    marginal = float(np.mean(p_signal - p_base))

    hit_rate = float(np.mean(target[matrix[:, 1] > 0.5]))
    base_rate = float(np.mean(target[matrix[:, 1] <= 0.5]))
    raw_excess = (hit_rate - base_rate) * 100
    adjusted = marginal * 100
    explained = (1.0 - adjusted / raw_excess) * 100 if abs(raw_excess) > 1e-9 else None

    features = []
    for index, name in enumerate(names):
        features.append({
            "name": name,
            "coef": round(float(beta[index]), 5),
            "or": round(math.exp(float(np.clip(beta[index], -20, 20))), 4),
            "pp": round(float(beta[index]) * mean_p * (1.0 - mean_p) * 100, 3),
            "z": round(float(beta[index] / se[index]), 2) if se[index] > 0 else None,
            "p": round(_two_sided_p(float(beta[index] / se[index])), 4) if se[index] > 0 else None,
        })
    features.sort(key=lambda item: -abs(item["coef"]))
    year_effects = []
    for offset, year in enumerate(year_columns):
        index = 10 + offset
        year_effects.append({
            "year": year,
            "pp": round(float(beta[index]) * mean_p * (1.0 - mean_p) * 100, 3),
            "z": round(float(beta[index] / se[index]), 2) if se[index] > 0 else None,
        })

    return {
        "horizon": horizon,
        "n": n,
        "signals": signals_n,
        "controls": controls_n,
        "base_win_rate": round(base_rate * 100, 2),
        "hit_win_rate": round(hit_rate * 100, 2),
        "raw_excess_pp": round(raw_excess, 3),
        "adjusted_excess_pp": round(adjusted, 3),
        "explained_pct": round(explained, 1) if explained is not None else None,
        "signal_coef": round(coef, 5),
        "signal_or": round(math.exp(float(np.clip(coef, -20, 20))), 4),
        "signal_z": round(z, 2),
        "signal_p": round(_two_sided_p(z), 5),
        "features": features[:10],
        "years": year_effects,
        "note": None,
    }
