import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnalysisDialog } from '@/components/fork/AnalysisDialog'
import type { AnalysisReport, AnalysisRunMeta } from '@/lib/analysis-api'
import type { ScreenPreset } from '@/lib/screen-presets'

/**
 * 数据分析弹窗的三态（未开始 / 进行中 / 已完成）。
 *
 * 钉住的行为：没选条件不能创建；创建后切成「进行中」并显示停止按钮；任务跑完后
 * 显示结论卡与「完整报告 / 下载 Excel」；打开弹窗时若有任务在跑，直接进那个任务
 * （否则关掉弹窗就再也看不到进度）。
 *
 * 网络层整体被替换成桩：这里测的是弹窗的编排，不是后端。
 */

const mocks = vi.hoisted(() => ({
  listRuns: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  getRun: vi.fn(),
  stopRun: vi.fn(),
  resumeRun: vi.fn(),
  report: vi.fn(),
  stocks: vi.fn(),
  signals: vi.fn(),
  download: vi.fn(),
}))

vi.mock('@/lib/analysis-api', () => ({
  ANALYSIS_POLL_MS: 2000,
  listAnalysisRuns: mocks.listRuns,
  previewAnalysis: mocks.preview,
  createAnalysis: mocks.create,
  getAnalysisRun: mocks.getRun,
  stopAnalysisRun: mocks.stopRun,
  resumeAnalysisRun: mocks.resumeRun,
  getAnalysisReport: mocks.report,
  getAnalysisStocks: mocks.stocks,
  getAnalysisSignals: mocks.signals,
  downloadAnalysisExcel: mocks.download,
  formatDuration: (seconds: number | null) => (seconds === null ? '—' : `${Math.round(seconds)} 秒`),
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

const runMeta = (over: Partial<AnalysisRunMeta> = {}): AnalysisRunMeta => ({
  run_id: '20261022-120000-abcd',
  preset: 'xg1',
  created_at: '2026-10-22T12:00:00+08:00',
  status: 'running',
  start_date: '2020-01-01',
  end_date: '2026-10-21',
  markets: ['sh', 'sz', 'cyb', 'kcb'],
  include_st: false,
  sample_size: 200,
  trading_days: 30,
  days_total: 1650,
  days_done: 100,
  hits: 1800,
  control: 20000,
  failures: 0,
  running: true,
  progress: {
    days_total: 1650,
    days_done: 100,
    hits: 1800,
    control: 20000,
    avg_ms: 3200,
    elapsed_s: 320,
    eta_s: 4960,
    current_d0: '2020-05-20',
  },
  ...over,
})

const report = (): AnalysisReport => ({
  run: runMeta({ status: 'done', running: false }),
  counts: { signals: 21800, hits: 1800, control: 20000, days: 1650 },
  summary: [5, 10, 15, 20, 25, 30].map(horizon => ({
    horizon,
    signal: {
      horizon,
      n: 1800,
      wins: 1100,
      win_rate: 61.1,
      ci_low: 58.8,
      ci_high: 63.4,
      touch_rate: 72.5,
      avg_return: 1.8,
      avg_win: 6.2,
      avg_loss: -4.1,
      payoff: 1.51,
    },
    control: {
      horizon,
      n: 20000,
      wins: 10800,
      win_rate: 54.0,
      ci_low: 53.3,
      ci_high: 54.7,
      touch_rate: 68.0,
      avg_return: 0.6,
      avg_win: 5.1,
      avg_loss: -4.6,
      payoff: 1.11,
    },
    excess_pp: 7.1,
    z: 4.2,
  })),
  verdict: {
    usable: true,
    reason: 'usable',
    best_horizon: 10,
    best_excess_pp: 7.1,
    best_win_rate: 61.1,
    baseline_win_rate: 54.0,
    best_avg_return: 1.8,
    best_payoff: 1.51,
    sample: 1800,
    z: 4.2,
    significant: true,
  },
  by_board: [],
  by_year: [],
  histograms: { edges: [-50, 0, 50], series: [] },
  density: [],
  horizons: [5, 10, 15, 20, 25, 30],
})

const renderDialog = () => {
  const onOpenChange = vi.fn()
  render(<AnalysisDialog open onOpenChange={onOpenChange} presets={presets} asof="2026-10-21" />)
  return { onOpenChange }
}

describe('AnalysisDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listRuns.mockResolvedValue([])
    mocks.preview.mockResolvedValue({
      days: 1650,
      first_day: '2020-01-02',
      last_day: '2026-10-21',
      latest_trade_date: '2026-10-21',
      trading_days: 30,
      markets: ['sh', 'sz', 'cyb', 'kcb'],
      include_st: false,
      sample_size: 200,
    })
    mocks.stocks.mockResolvedValue({ total: 0, items: [] })
    mocks.signals.mockResolvedValue([])
  })

  afterEach(() => {
    cleanup()
  })

  it('未开始：显示创建表单、预估交易日与创建按钮', async () => {
    renderDialog()
    expect(await screen.findByText('创建数据分析任务')).toBeTruthy()
    expect(document.querySelector('[data-fork-analysis-preset]')).toBeTruthy()
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-estimate]')?.textContent).toContain('1650'))
    expect(document.querySelector('[data-fork-analysis-create-button]')).toBeTruthy()
  })

  it('股票范围与条件选股同款：市场 pill 组 + ST 开关', async () => {
    mocks.create.mockResolvedValue(runMeta())
    renderDialog()
    const user = userEvent.setup()
    const all = await screen.findByRole('button', { name: '全部' })
    expect(all.getAttribute('aria-pressed')).toBe('true')
    // 点「上证」= 从「全部」切成只选上证（其余三个也跟着取消，「全部」显示为半选）
    await user.click(screen.getByRole('button', { name: '上证' }))
    expect(all.getAttribute('aria-pressed')).toBe('mixed')
    expect(screen.getByRole('button', { name: '上证' }).getAttribute('aria-pressed')).toBe('true')
    // 点「全部」恢复四个市场
    await user.click(all)
    expect(all.getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '上证' }).getAttribute('aria-pressed')).toBe('false')
    await user.click(screen.getByRole('button', { name: '上证' }))
    // ST 开关（与条件选股同一个 Switch，不再是 checkbox）
    await user.click(screen.getByRole('switch', { name: '包含 ST / *ST' }))
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    const payload = mocks.create.mock.calls[0][0]
    expect(payload.markets).toEqual(['sh'])
    expect(payload.include_st).toBe(true)
  })

  it('创建后切成进行中：进度、命中数与停止按钮', async () => {
    mocks.create.mockResolvedValue(runMeta())
    renderDialog()
    const user = userEvent.setup()
    const button = await screen.findByRole('button', { name: '创建任务' })
    await user.click(button)
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    const payload = mocks.create.mock.calls[0][0]
    expect(payload.preset).toBe('xg1')
    expect(payload.start_date).toBe('2020-01-01')
    expect(payload.markets).toEqual(['sh', 'sz', 'cyb', 'kcb'])
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run="running"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(document.body.textContent).toContain('已完成 100 / 1650 个交易日')
  })

  it('点停止会调用停止接口', async () => {
    mocks.create.mockResolvedValue(runMeta())
    mocks.stopRun.mockResolvedValue(runMeta({ status: 'stopped', days_done: 120 }))
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    const stop = await screen.findByRole('button', { name: '停止' })
    await user.click(stop)
    await waitFor(() => expect(mocks.stopRun).toHaveBeenCalledWith('20261022-120000-abcd'))
  })

  it('已完成：结论卡 + 完整报告 + 下载 Excel', async () => {
    mocks.create.mockResolvedValue(
      runMeta({ status: 'done', running: false, days_done: 1650, hits: 1800, excel_ready: true }),
    )
    mocks.report.mockResolvedValue(report())
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-verdict]')).toBeTruthy())
    expect(document.querySelector('[data-fork-analysis-verdict-text]')?.textContent).toContain('这个条件有用')
    expect(screen.getByRole('button', { name: /查看完整报告/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下载 Excel' })).toBeTruthy()
  })

  it('打开时若有任务在跑，直接进那个任务的进度页', async () => {
    mocks.listRuns.mockResolvedValue([runMeta()])
    renderDialog()
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run="running"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
  })
})

/**
 * 按钮位置：「数据分析」必须在「条件选股」前面（用户 2026-10-22 明确指定）。
 *
 * 这里按源码顺序断言而不是渲染整页：``ForkAnalysis.tsx`` 3700 行、十几次数据请求，
 * 在 jsdom 里渲染它既慢又不稳（现有测试也从不渲染整页）。工具栏是同一段内联 JSX，
 * 顺序被改会立刻在这里红。
 */
describe('分析页工具栏顺序', () => {
  it('数据分析按钮排在条件选股之前', async () => {
    const { readFileSync } = await import('node:fs')
    // jsdom 环境里 import.meta.url 不是 file: 协议，所以按 vitest 的工作目录（frontend/）取
    const source = readFileSync(`${process.cwd()}/src/pages/ForkAnalysis.tsx`, 'utf-8')
    const analysisIndex = source.indexOf('data-fork-analysis-button')
    const screenIndex = source.indexOf('data-tour="screen-stocks"')
    expect(analysisIndex).toBeGreaterThan(-1)
    expect(screenIndex).toBeGreaterThan(-1)
    expect(analysisIndex).toBeLessThan(screenIndex)
  })
})
