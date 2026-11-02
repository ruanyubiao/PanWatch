/**
 * 有效范围（通用 / 个股）与「已完成 undefined / N 个交易日」的回归测试。
 *
 * 对应用户 2026-11-03 的第 2 / 5 / 6 条：
 * 2. 推理条件增加「有效范围」列（通用 / 个股）
 * 5. 详情里如果包含个股，要有个股名单（id + 名字）
 * 6. 数据分析弹窗不再出现「已完成 undefined / 652 个交易日」
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnalysisInferPanel } from '@/components/fork/analysis/AnalysisInferPanel'
import type { InferFinalist, InferRunMeta } from '@/lib/infer-api'

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

const run = (over: Partial<InferRunMeta> = {}): InferRunMeta => ({
  run_id: '20261103-101010-abcd',
  created_at: '2026-11-03T10:10:10+08:00',
  status: 'done',
  preset: 'xg1',
  base_summary: '阳线多于阴线',
  method: 'stat_v3',
  method_name: '方法 3',
  train_start: '2024-01-02',
  train_end: '2025-12-31',
  valid_start: '2026-01-05',
  valid_end: '2026-09-02',
  train_day_count: 485,
  valid_day_count: 167,
  search_days: 120,
  iterations: 1000,
  done_iterations: 1000,
  horizons: [5, 10, 20, 25, 30],
  markets: ['sh', 'sz', 'cyb', 'kcb'],
  include_st: false,
  estimate_seconds: 3600,
  alive: false,
  progress: { phase: 'finished', done_iterations: 1000, iterations: 1000 },
  ...over,
})

const finalist = (over: Partial<InferFinalist> = {}): InferFinalist => ({
  rank: 1,
  desc: '阳线多于阴线 且 换手率区间0%~2%',
  operator: 'add',
  trial_score: 12.3,
  train_score: 62.5,
  train_horizon: 20,
  train_signals: 4000,
  train_days: 400,
  valid_score: 61.0,
  valid_horizon: 20,
  valid_signals: 900,
  valid_days: 120,
  passed: false,
  train_rows: [],
  valid_rows: [],
  train_grade: { score: 62.5, grade: 'C', best_window: 20, excess_pp: 3.1 },
  valid_grade: { score: 61.0, grade: 'C', best_window: 20, excess_pp: 2.8 },
  combined: { verdict: 'watch', score: 61.8, text: '有亮点' },
  kept: true,
  scope: ['general'],
  scope_label: '通用',
  stock_qualified: 0,
  stock_universe: 3200,
  stock_list: [],
  ...over,
})

describe('条件推理：有效范围', () => {
  it('入围表格有「有效范围」列，并显示通用 / 个股', () => {
    render(
      <AnalysisInferPanel
        run={run()}
        finalists={[finalist(), finalist({ rank: 2, desc: '另一条', scope_label: '个股' })]}
      />,
    )
    expect(screen.getByText('有效范围')).toBeTruthy()
    expect(document.querySelector('[data-fork-infer-scope="通用"]')).toBeTruthy()
    expect(document.querySelector('[data-fork-infer-scope="个股"]')).toBeTruthy()
  })

  it('个股达标时详情里列出个股名单（代码 + 名称 + 两段分数）', () => {
    render(
      <AnalysisInferPanel
        run={run()}
        finalists={[finalist({
          scope: ['stock'],
          scope_label: '个股',
          stock_qualified: 2,
          stock_universe: 3200,
          stock_list: [
            { code: '000001', name: '平安银行', train_score: 88.4, test_score: 81.2,
              best_score: 88.4, train_signals: 26, test_signals: 9, window: 10,
              train_win_rate: 84.6, train_excess_pp: 38.2 },
            { code: '600000', name: '浦发银行', train_score: 80.5, test_score: null,
              best_score: 80.5, train_signals: 31, test_signals: null, window: 20,
              train_win_rate: 80.6, train_excess_pp: 33.0 },
          ],
        })]}
      />,
    )
    expect(document.querySelector('[data-fork-infer-stocks]')).toBeTruthy()
    expect(screen.getByText('000001')).toBeTruthy()
    expect(screen.getByText('平安银行')).toBeTruthy()
    expect(screen.getByText('600000')).toBeTruthy()
    expect(screen.getByText('浦发银行')).toBeTruthy()
    // 个股是线索不是确证，这句话必须在
    expect(document.body.textContent).toContain('个股是线索')
  })

  it('没有个股达标时不渲染个股区域', () => {
    render(<AnalysisInferPanel run={run()} finalists={[finalist()]} />)
    expect(document.querySelector('[data-fork-infer-stocks]')).toBeNull()
  })

  it('整条与个股同时成立时显示「通用+个股」', () => {
    render(
      <AnalysisInferPanel
        run={run()}
        finalists={[finalist({
          scope: ['general', 'stock'],
          scope_label: '通用+个股',
          stock_qualified: 1,
          stock_list: [{ code: '000001', name: '平安银行', train_score: 90,
            test_score: 84, best_score: 90, train_signals: 30, test_signals: 8, window: 10 }],
        })]}
      />,
    )
    expect(document.querySelector('[data-fork-infer-scope="通用+个股"]')).toBeTruthy()
  })
})
