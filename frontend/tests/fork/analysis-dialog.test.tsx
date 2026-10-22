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
  detail: vi.fn(),
  remove: vi.fn(),
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
  getAnalysisDetail: mocks.detail,
  deleteAnalysisRun: mocks.remove,
  recomputeAnalysisRun: vi.fn(),
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
  groups: [
    {
      dim: 'industry',
      label: '行业',
      hint: '',
      focus_horizon: 30,
      items: [
        {
          key: '半导体',
          n: 320,
          sample_total: 320,
          win_rate: 58.4,
          edge_pp: 9.2,
          avg_return: 2.4,
          q: 0.02,
          z: 3.1,
          significant: true,
          verdict: 'edge',
          horizons: { '30': { n: 320, win_rate: 58.4, ci_low: 52.9, ci_high: 63.7, avg_return: 2.4, edge_pp: 9.2 } },
        },
      ],
    },
  ],
  arrival: {
    buckets: [{ day: 1, n: 400 }, { day: 3, n: 200 }],
    never_positive: 1200,
    median_days: 4,
    total: 1800,
    within: { '5': 55.6, '10': 62.0 },
  },
  horizons: [5, 10, 15, 20, 25, 30],
  validate_days: 30,
  control_hidden: true,
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
      max_end_date: '2026-09-09',
      validate_days: 30,
      horizons: [5, 10, 15, 20, 25, 30],
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
    // 界面不显示随机对照组（用户第 6 条）：没有「随机胜率」这一列、没有对照图例
    expect(document.body.textContent).not.toContain('随机胜率')
    expect(document.body.textContent).not.toContain('对照组随机')
    // 分组统计与到达天数都要出现（第 11 条）
    expect(document.body.textContent).toContain('哪类股票特别有效')
    expect(document.body.textContent).toContain('半导体')
    expect(document.body.textContent).toContain('中位到达天数')
  })

  it('结束日期在开始日期下面一行，验证天数在再下一行，默认 30', async () => {
    renderDialog()
    await screen.findByText('创建数据分析任务')
    const start = document.querySelector('[data-fork-analysis-start]') as HTMLElement
    const end = document.querySelector('[data-fork-analysis-end]') as HTMLElement
    const days = document.querySelector('[data-fork-analysis-validate-days]') as HTMLInputElement
    expect(start && end && days).toBeTruthy()
    // 三行竖排：DOM 顺序就是显示顺序
    expect(start.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(end.compareDocumentPosition(days) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(days.value).toBe('30')
    expect(days.getAttribute('min')).toBe('1')
    // 结束日默认 = 最后一个「验证得完」的交易日（后端给的 max_end_date）
    await waitFor(() => expect((document.querySelector('[data-fork-analysis-end]') as HTMLInputElement).value)
      .toBe('2026-09-09'))
  })

  it('用户选的结束日不能晚于可验证的最后一天', async () => {
    renderDialog()
    const user = userEvent.setup()
    const end = (await screen.findByLabelText('结束日期')) as HTMLInputElement
    await waitFor(() => expect(end.value).toBe('2026-09-09'))
    await user.clear(end)
    await user.type(end, '2026-12-31')
    expect(end.value <= '2026-09-09').toBe(true)
  })

  it('创建时把验证天数带给后端', async () => {
    mocks.create.mockResolvedValue(runMeta())
    renderDialog()
    const user = userEvent.setup()
    const days = (await screen.findByLabelText('验证天数')) as HTMLInputElement
    await user.clear(days)
    await user.type(days, '12')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    expect(mocks.create.mock.calls[0][0].validate_days).toBe(12)
  })

  it('点历史任务开的是任务详情窗口，不是数据分析界面', async () => {
    mocks.listRuns.mockResolvedValue([
      runMeta({ status: 'done', running: false, days_done: 1650, hits: 1800, excel_ready: true }),
    ])
    mocks.detail.mockResolvedValue({
      run: runMeta({ status: 'done', running: false, excel_ready: true }),
      condition: { name: 'xg1', saved_at: '2026-10-20T10:00:00+08:00', request: presets[0].request },
      verdict: { usable: false, reason: 'no_edge', best_horizon: 10, best_excess_pp: 0.4, sample: 1800 },
      horizons: [5, 10, 15, 20, 25, 30],
    })
    mocks.report.mockResolvedValue(report())
    renderDialog()
    const user = userEvent.setup()
    const item = await screen.findByRole('button', { name: '打开任务详情' })
    await user.click(item)
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-task-detail]')).toBeTruthy())
    expect(document.body.textContent).toContain('条件详情')
    // 详情窗口只给报告与 Excel，不给「新建任务」
    expect(screen.queryByRole('button', { name: '新建任务' })).toBeNull()
    expect(screen.getByRole('button', { name: /查看完整报告/ })).toBeTruthy()
  })

  it('「查看全部」打开完整任务列表', async () => {
    mocks.listRuns.mockResolvedValue([runMeta({ status: 'done', running: false })])
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '查看全部' }))
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run-list]')).toBeTruthy())
    expect(document.body.textContent).toContain('全部历史任务')
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
