import { readFileSync } from 'node:fs'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InferDialog, INFER_TEXTS_ZH } from '@/components/fork/InferDialog'
import type { InferPreview, InferResults, InferRunMeta } from '@/lib/infer-api'
import type { ScreenPreset } from '@/lib/screen-presets'

/**
 * 条件推理弹窗。
 *
 * 钉住的行为：
 * 1. 表单默认值就是用户要的那套（训练 2024-01-01~2025-12-31、验证 2026-01-01 起、
 *    优化次数 100）；
 * 2. 点「开始推理」把表单原样提交，切到进行中并给出暂停 / 停止；
 * 3. 暂停走 pause 接口；
 * 4. 跑完显示最终验算结果，点「保存条件」调保存接口；
 * 5. 「条件推理」按钮必须排在「数据分析」前面（用户 2026-10-24 明确要求）。
 *
 * 网络层整体打桩：这里测的是弹窗编排，不是后端。
 */

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  getRun: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  results: vi.fn(),
  save: vi.fn(),
  methods: vi.fn(),
}))

vi.mock('@/lib/infer-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/infer-api')>('@/lib/infer-api')
  return {
    INFER_POLL_MS: 2500,
    listInferRuns: mocks.listRuns,
    previewInfer: mocks.preview,
    createInfer: mocks.create,
    getInferRun: mocks.getRun,
    pauseInfer: mocks.pause,
    resumeInfer: mocks.resume,
    stopInfer: mocks.stop,
    getInferResults: mocks.results,
    saveInferVariant: mocks.save,
    formatInferDuration: actual.formatInferDuration,
  }
})

vi.mock('@/lib/analysis-api', () => ({
  getAnalysisMethods: mocks.methods,
}))

const presets: ScreenPreset[] = [
  {
    name: 'xg1',
    saved_at: '2026-10-20T10:00:00+08:00',
    request: {
      trading_days: 30,
      markets: ['sh', 'sz', 'cyb', 'kcb'],
      include_st: false,
      rule: { type: 'group', operator: 'AND', children: [] },
    } as ScreenPreset['request'],
  },
]

const preview = (over: Partial<InferPreview> = {}): InferPreview => ({
  method: 'stat_v3',
  method_name: '统计分析方法 3：条件适用面',
  train_days: 485,
  valid_days: 200,
  train_first: '2024-01-02',
  train_last: '2025-12-31',
  valid_first: '2026-01-05',
  valid_last: '2026-09-30',
  search_days: 120,
  iterations: 100,
  max_verifiable: '2026-09-30',
  latest_trade_date: '2026-10-22',
  base_summary: '连续阳线4天',
  base_trading_days: 30,
  base_bars: 30,
  estimate_seconds: 2400,
  horizons: [5, 10, 20, 25, 30],
  ...over,
})

const runMeta = (over: Partial<InferRunMeta> = {}): InferRunMeta => ({
  run_id: '20261024-150000-abcd',
  created_at: '2026-10-24T15:00:00+08:00',
  status: 'running',
  preset: 'xg1',
  base_summary: '连续阳线4天',
  method: 'stat_v3',
  method_name: '统计分析方法 3',
  train_start: '2024-01-01',
  train_end: '2025-12-31',
  valid_start: '2026-01-01',
  valid_end: '2026-09-30',
  train_day_count: 485,
  valid_day_count: 200,
  search_days: 120,
  iterations: 100,
  done_iterations: 12,
  horizons: [5, 10, 20, 25, 30],
  markets: ['sh', 'sz', 'cyb', 'kcb'],
  include_st: false,
  estimate_seconds: 2400,
  alive: true,
  progress: {
    phase: 'searching',
    done_iterations: 12,
    iterations: 100,
    current: '连续阳线4天 ＋ 均线多头(5/10/20)',
    best_score: 3.42,
    best_desc: '连续阳线4天 ＋ 均线多头(5/10/20)',
    elite: 4,
    elapsed_s: 600,
    eta_s: 2400,
    variants_evaluated: 13,
    load_progress: 1,
  },
  ...over,
})

const horizonRow = (horizon: number, over: Record<string, unknown> = {}) => ({
  horizon,
  close_rate: 52.1, close_base: 47.2, close_excess: 4.9, close_day_excess: 4.1, close_n: 5000,
  exec_rate: 50.2, exec_base: 47.0, exec_excess: 3.2, exec_day_excess: 2.9, exec_n: 4800,
  touch_rate: 40.1, touch_base: 36.0, touch_excess: 4.1, touch_day_excess: 3.8, touch_n: 5000,
  years: { '2024': 3.1, '2025': 3.9 },
  ...over,
})

const results = (over: Partial<InferResults> = {}): InferResults => ({
  run_id: '20261024-150000-abcd',
  evaluated: 40,
  ranked: 12,
  rows: [
    {
      index: 7,
      desc: '连续阳线4天 ＋ 量比1.2~3倍',
      operator: 'add',
      parent: 2,
      score: 4.2,
      best_horizon: 10,
      signals: 3200,
      days_with_hits: 160,
      days: 120,
      seconds: 12.3,
      rows: [horizonRow(5), horizonRow(10)],
    },
  ],
  finalists: [
    {
      rank: 1,
      desc: '连续阳线4天 ＋ 均线多头(5/10/20)',
      operator: 'add',
      trial_score: 3.4,
      train_score: 3.1,
      train_horizon: 10,
      train_signals: 5200,
      train_days: 485,
      valid_score: 2.2,
      valid_horizon: 10,
      valid_signals: 2100,
      valid_days: 200,
      passed: true,
      train_rows: [horizonRow(5), horizonRow(10)],
      valid_rows: [horizonRow(5, { exec_rate: 51.0 }), horizonRow(10, { exec_rate: 50.5 })],
    },
  ],
  ...over,
})

function setup() {
  return render(<InferDialog open onOpenChange={() => undefined} presets={presets} />)
}

beforeEach(() => {
  mocks.listRuns.mockResolvedValue([])
  mocks.preview.mockResolvedValue(preview())
  mocks.methods.mockResolvedValue([{ id: 'stat_v3', name: '统计分析方法 3' }])
  mocks.getRun.mockResolvedValue(runMeta())
  mocks.results.mockResolvedValue(results())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('条件推理弹窗', () => {
  it('默认值就是用户指定的一套', async () => {
    setup()
    await waitFor(() => expect(mocks.preview).toHaveBeenCalled())
    const iterations = screen.getByLabelText(INFER_TEXTS_ZH.iterations) as HTMLInputElement
    expect(iterations.value).toBe('100')
    const trainStart = screen.getByLabelText(INFER_TEXTS_ZH.trainStart) as HTMLInputElement
    const trainEnd = screen.getByLabelText(INFER_TEXTS_ZH.trainEnd) as HTMLInputElement
    const validStart = screen.getByLabelText(INFER_TEXTS_ZH.validStart) as HTMLInputElement
    expect(trainStart.value).toBe('2024-01-01')
    expect(trainEnd.value).toBe('2025-12-31')
    expect(validStart.value).toBe('2026-01-01')
  })

  it('提交时带上表单里的日期与优化次数，并切到进行中', async () => {
    mocks.create.mockResolvedValue(runMeta())
    setup()
    await waitFor(() => expect(mocks.preview).toHaveBeenCalled())
    await userEvent.click(screen.getByText(INFER_TEXTS_ZH.create))
    await waitFor(() => expect(mocks.create).toHaveBeenCalled())
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      preset: 'xg1',
      train_start: '2024-01-01',
      train_end: '2025-12-31',
      valid_start: '2026-01-01',
      iterations: 100,
    })
    await waitFor(() => expect(screen.getByText(INFER_TEXTS_ZH.pause)).toBeTruthy())
    expect(screen.getByText(INFER_TEXTS_ZH.stop)).toBeTruthy()
  })

  it('暂停调用 pause 接口', async () => {
    mocks.create.mockResolvedValue(runMeta())
    mocks.pause.mockResolvedValue(runMeta({ status: 'paused' }))
    setup()
    await waitFor(() => expect(mocks.preview).toHaveBeenCalled())
    await userEvent.click(screen.getByText(INFER_TEXTS_ZH.create))
    await waitFor(() => expect(screen.getByText(INFER_TEXTS_ZH.pause)).toBeTruthy())
    await userEvent.click(screen.getByText(INFER_TEXTS_ZH.pause))
    await waitFor(() => expect(mocks.pause).toHaveBeenCalledWith('20261024-150000-abcd'))
  })

  it('跑完显示最终验算并可保存条件', async () => {
    mocks.listRuns.mockResolvedValue([runMeta({ status: 'done' })])
    mocks.getRun.mockResolvedValue(runMeta({ status: 'done' }))
    mocks.save.mockResolvedValue({ name: 'xg1_1' })
    setup()
    await waitFor(() => expect(screen.getByText(INFER_TEXTS_ZH.finalTitle)).toBeTruthy())
    expect(screen.getAllByText(/均线多头/).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByText(INFER_TEXTS_ZH.save))
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('20261024-150000-abcd', 1))
    await waitFor(() => expect(screen.getByText(INFER_TEXTS_ZH.saved('xg1_1'))).toBeTruthy())
  })

  it('条件推理按钮排在数据分析前面', () => {
    // 源码顺序断言：两个按钮由同一段 JSX 渲染，顺序变了用户会立刻发现（要求 2026-10-24）
    const source = readFileSync('src/pages/ForkAnalysis.tsx', 'utf8')
    const infer = source.indexOf('data-fork-infer-button')
    const analysis = source.indexOf('data-tour="analyze-condition"')
    expect(infer).toBeGreaterThan(0)
    expect(analysis).toBeGreaterThan(0)
    expect(infer).toBeLessThan(analysis)
  })
})
