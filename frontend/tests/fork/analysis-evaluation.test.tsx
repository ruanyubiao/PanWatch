import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AnalysisEvaluation,
  ANALYSIS_EVALUATION_TEXTS_ZH,
} from '@/components/fork/analysis/AnalysisEvaluation'
import type { AnalysisReport } from '@/lib/analysis-api'

/**
 * 评估细节（v4）。
 *
 * 钉住的都是「会让用户误判」的呈现：
 * 1. 成本四档必须全列出来 —— 只给 0.2% 那一档等于替用户做了乐观假设；
 * 2. 拿不到的成交价要明确标「不可用」，不能留空让人以为没跑；
 * 3. 控制变量之后剩下的超额必须和原始超额并排，否则「小市值」会被误当成条件有效；
 * 4. 数据被污染时必须显式警告。
 */

const ablationState = {
  status: 'absent' as const,
  variants: [],
  progress: { done: 0, total: 0, current: null },
}

vi.mock('@/lib/analysis-api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/analysis-api')>()
  return {
    ...actual,
    getAnalysisAblation: vi.fn(async () => ablationState),
    startAnalysisAblation: vi.fn(async () => ({ ...ablationState, status: 'running' })),
    getAnalysisLeaderboard: vi.fn(async () => ({ items: [], count: 0, expected_max_pp: null, note: null, calibers: [] })),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(cleanup)

function makeReport(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    run: { run_id: 'r1' } as AnalysisReport['run'],
    counts: { signals: 100, hits: 60, control: 40, days: 10 },
    summary: [],
    verdict: { usable: false, reason: 'no_edge', best_horizon: 10, best_excess_pp: -1.0 },
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
    primary_horizon: 10,
    cost_sensitivity: {
      available: true,
      levels: [
        { key: 'base', label: '0.2%（旧口径）', cost: 0.002, horizons: { '5': -1.2, '10': -3.1 } },
        { key: 'realistic', label: '逐行真实', cost: null, horizons: { '5': -2.4, '10': -4.6 } },
        { key: 'double', label: '0.4%', cost: 0.004, horizons: { '5': -2.9, '10': -5.2 } },
        { key: 'heavy', label: '0.8%（微盘压力测试）', cost: 0.008, horizons: { '5': -4.8, '10': -7.1 } },
      ],
    },
    entry: [
      { base: 'signal_close', label: '信号日收盘（不可执行，仅作上界参考）', executable: false, available: true, n: 600, win_rate: 55.2, excess_pp: 3.4, ci_low_pp: 1.1, ci_high_pp: 5.7, days: 120 },
      { base: 'next_open', label: '次日开盘（主口径）', executable: true, available: true, n: 590, win_rate: 51.2, excess_pp: -0.4, ci_low_pp: -2.2, ci_high_pp: 1.4, days: 120 },
      { base: 'next_vwap', label: '次日典型价 (开+高+收)/3', executable: true, available: false, excess_pp: null },
    ],
    portfolio: {
      config: { top_k: 10, hold_days: 10, caliber: 'exec', cost: 0.002 },
      signal: {
        equity: [
          { d0: '2020-01-02', value: 1.0 },
          { d0: '2023-01-02', value: 1.2 },
          { d0: '2026-09-02', value: 1.36 },
        ],
        metrics: { days: 1600, annualised_pct: 4.7, max_drawdown_pct: -21.3, sharpe: 0.42, avg_positions: 29.3, capital_use_pct: 29.3, idle_days: 3 },
      },
      control: {
        equity: [
          { d0: '2020-01-02', value: 1.0 },
          { d0: '2023-01-02', value: 1.2 },
          { d0: '2026-09-02', value: 1.37 },
        ],
        metrics: { days: 1600, annualised_pct: 4.9, max_drawdown_pct: -18.0, sharpe: 0.46 },
      },
      annualised_excess_pp: -0.2,
      traded: 18200,
      skipped: 2100,
    },
    attribution: {
      n: 400000,
      raw_excess_pp: 3.9,
      adjusted_excess_pp: -1.1,
      explained_pct: 128.2,
      features: [
        { name: '是否命中', coef: 0.02, or: 1.02, pp: -1.1, z: -1.2, p: 0.23 },
        { name: 'log总市值', coef: -0.09, or: 0.91, pp: -2.4, z: -8.1, p: 0.0 },
      ],
    },
    heterogeneity: {
      horizon: 10,
      rows: [
        { year: '2020', effect_pp: 2.1, se_pp: 1.2, days: 240, significant_up: false, significant_down: false },
        { year: '2026', effect_pp: -6.3, se_pp: 1.4, days: 180, significant_up: false, significant_down: true },
      ],
      q: 18.2,
      df: 1,
      p: 0.001,
      i2: 94.5,
      consistent: false,
    },
    quality: {
      days: 1600,
      coverage_median: 5500,
      coverage_threshold: 4950,
      suspect_days: [],
      suspect_days_count: 0,
      rows: 182077,
      unverifiable: 1,
      unfillable: 2128,
      stale_over_5d: 40,
      adj_missing_rows: 0,
      max_stale_days: 26,
      usable_rate: 99.9,
      caliber: 'exec',
      health: {
        score: 62,
        level: 'warn',
        polluted: true,
        total_rows: 182077,
        extreme_rows: 2100,
        extreme_rate: 1.15,
        resume_jump_rows: 300,
        zero_amount_rows: 2,
        adj_missing_rows: 0,
        unverifiable: 1,
        unfillable: 2128,
        suspect_days: 0,
        gaps: [],
        gap_count: 0,
        samples: [{ d0: '2021-06-01', code: '600000', r1: 43.2, stale_days: 0, adj_missing: 0 }],
        thresholds: { extreme_return: 0.215, resume_stale_days: 5, max_calendar_gap: 12 },
      },
    },
    ...overrides,
  }
}

function renderReport(overrides: Partial<AnalysisReport> = {}) {
  return render(<AnalysisEvaluation report={makeReport(overrides)} runId="r1" />)
}

describe('评估细节', () => {
  it('成本四档全部列出，并跟着周期展开列', () => {
    renderReport()
    expect(screen.getByText('0.2%（旧口径）')).toBeTruthy()
    expect(screen.getByText('逐行真实')).toBeTruthy()
    expect(screen.getByText('0.4%')).toBeTruthy()
    expect(screen.getByText('0.8%（微盘压力测试）')).toBeTruthy()
    expect(screen.getAllByText('-3.10pp').length).toBeGreaterThan(0)
  })

  it('拿不到的成交价标「不可用」而不是留空', () => {
    renderReport()
    expect(screen.getByText(ANALYSIS_EVALUATION_TEXTS_ZH.entryUnavailable)).toBeTruthy()
    expect(screen.getByText('次日开盘（主口径）')).toBeTruthy()
  })

  it('组合模拟给年化、回撤与随机基准', () => {
    renderReport()
    expect(screen.getByText('4.70%')).toBeTruthy()
    expect(screen.getByText('-21.30%')).toBeTruthy()
    expect(screen.getByText('4.90%')).toBeTruthy()
    expect(screen.getByText('-0.20pp')).toBeTruthy()
  })

  it('因子归因并排显示原始与控制后超额', () => {
    renderReport()
    expect(screen.getByText('+3.90pp')).toBeTruthy()
    expect(screen.getByText('-1.10pp')).toBeTruthy()
    expect(screen.getByText(/128\.2%/)).toBeTruthy()
  })

  it('年度不一致时明确说「集中在部分年份」', () => {
    renderReport()
    expect(screen.getByText(ANALYSIS_EVALUATION_TEXTS_ZH.heterogeneityInconsistent)).toBeTruthy()
    expect(screen.getByText(/I²=94.5%/)).toBeTruthy()
  })

  it('数据被污染时给红色警告', () => {
    renderReport()
    expect(screen.getByText(ANALYSIS_EVALUATION_TEXTS_ZH.healthScore(62) + ' · ' + ANALYSIS_EVALUATION_TEXTS_ZH.healthLevel.warn)).toBeTruthy()
    expect(screen.getByText(ANALYSIS_EVALUATION_TEXTS_ZH.healthPolluted)).toBeTruthy()
  })

  it('消融没跑过时给按钮和说明', async () => {
    renderReport()
    expect(await screen.findByText(ANALYSIS_EVALUATION_TEXTS_ZH.ablationStart)).toBeTruthy()
    expect(screen.getByText(ANALYSIS_EVALUATION_TEXTS_ZH.ablationEmpty)).toBeTruthy()
  })
})
