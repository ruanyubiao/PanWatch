import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnalysisHonesty, ANALYSIS_HONESTY_TEXTS_ZH } from '@/components/fork/analysis/AnalysisHonesty'
import type { AnalysisReport } from '@/lib/analysis-api'

/**
 * 统计可信度区块。
 *
 * 钉住两件事：
 * 1. 区间跨 0 时必须写「无法确认」—— 这是重叠样本修正后最重要的一句，
 *    旧的合并 z 会说「显著」，界面不能跟着说。
 * 2. 口径、数据质量、数据版本都要露出来，否则用户不知道数字是在什么前提下算的。
 */

afterEach(cleanup)

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    run: { run_id: 'r1' } as AnalysisReport['run'],
    counts: { signals: 100, hits: 60, control: 40, days: 10 },
    summary: [],
    verdict: {
      usable: false,
      reason: 'not_significant',
      best_horizon: 10,
      best_excess_pp: 1.2,
      honest: {
        verdict: 'mixed',
        primary_horizon: 10,
        primary_excess_pp: 1.2,
        primary_ci_low_pp: -1.5,
        primary_ci_high_pp: 3.9,
        up_count: 0,
        down_count: 0,
      },
    },
    groups: [],
    arrival: { buckets: [], never_positive: 0, median_days: null, total: 0, within: {} },
    by_board: [],
    by_year: [],
    histograms: { edges: [], series: [] },
    density: [],
    horizons: [5, 10],
    validate_days: 30,
    control_hidden: true,
    caliber: 'exec',
    cost: 0.002,
    significance: [
      {
        horizon: 5,
        caliber: 'exec',
        mean_excess_pp: 2.4,
        ci_low_pp: 0.4,
        ci_high_pp: 4.4,
        t: 2.4,
        nw_t: 2.1,
        days: 120,
        n_eff: 24,
        pooled_excess_pp: 5.1,
        significant_up: true,
        significant_down: false,
        mean_return_excess_pp: 0.5,
        return_ci_low_pp: 0.1,
        return_ci_high_pp: 0.9,
      },
      {
        horizon: 10,
        caliber: 'exec',
        mean_excess_pp: 1.2,
        ci_low_pp: -1.5,
        ci_high_pp: 3.9,
        t: 0.8,
        nw_t: 0.7,
        days: 120,
        n_eff: 12,
        pooled_excess_pp: 2.5,
        significant_up: false,
        significant_down: false,
        mean_return_excess_pp: 0.1,
        return_ci_low_pp: -0.3,
        return_ci_high_pp: 0.5,
      },
    ],
    stability: {
      split: '2024-01-01',
      design: [],
      validate: [],
      design_excess_pp: { '5': 3.1, '10': 2.0 },
      validate_excess_pp: { '5': 1.0, '10': 0.2 },
      decay_pp: { '5': -2.1, '10': -1.8 },
    },
    quality: {
      days: 120,
      coverage_median: 5500,
      coverage_threshold: 4950,
      suspect_days: [],
      suspect_days_count: 2,
      rows: 600,
      unverifiable: 7,
      unfillable: 13,
      stale_over_5d: 3,
      adj_missing_rows: 0,
      max_stale_days: 9,
      usable_rate: 98.8,
      caliber: 'exec',
    },
    data_version: { max_trade_date: '2026-10-22', symbols: 5579, recent_rows: [] },
    ...overrides,
  }
}

describe('统计可信度区块', () => {
  it('区间跨 0 的周期标「无法确认」，区间为正的标「显著更高」', () => {
    render(<AnalysisHonesty report={makeReport()} />)
    const rows = screen.getAllByRole('row')
    // 第一行是表头，之后按周期排
    expect(rows[1].textContent).toContain('5 日')
    expect(rows[1].textContent).toContain(ANALYSIS_HONESTY_TEXTS_ZH.verdictUp)
    expect(rows[2].textContent).toContain('10 日')
    expect(rows[2].textContent).toContain(ANALYSIS_HONESTY_TEXTS_ZH.verdictFlat)
  })

  it('展示可执行口径与扣费金额', () => {
    render(<AnalysisHonesty report={makeReport()} />)
    expect(screen.getByText(/次日开盘买入/)).toBeTruthy()
    expect(screen.getByText(/0\.2%/)).toBeTruthy()
  })

  it('把合并口径与本口径的差额写出来', () => {
    render(<AnalysisHonesty report={makeReport()} />)
    expect(screen.getByText(/合并口径 5\.10pp/)).toBeTruthy()
  })

  it('数据质量与数据版本都要露出来', () => {
    render(<AnalysisHonesty report={makeReport()} />)
    expect(screen.getByText(/不可验证 7 条/)).toBeTruthy()
    expect(screen.getByText(/买不进 13 条/)).toBeTruthy()
    expect(screen.getByText(/行情截至 2026-10-22/)).toBeTruthy()
  })
})
