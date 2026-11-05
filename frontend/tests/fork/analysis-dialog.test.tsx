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
  result: vi.fn(),
  methods: vi.fn(),
  history: vi.fn(),
  inferList: vi.fn(),
  inferCreate: vi.fn(),
  inferGet: vi.fn(),
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
  getAnalysisResult: mocks.result,
  getAnalysisMethods: mocks.methods,
  listAnalysisHistory: mocks.history,
  getAnalysisStocks: mocks.stocks,
  getAnalysisSignals: mocks.signals,
  downloadAnalysisExcel: mocks.download,
  downloadAnalysisArtifact: vi.fn(),
  getAnalysisDetail: mocks.detail,
  deleteAnalysisRun: mocks.remove,
  recomputeAnalysisRun: vi.fn(),
  formatDuration: (seconds: number | null) => (seconds === null ? '—' : `${Math.round(seconds)} 秒`),
}))

vi.mock('@/lib/infer-api', () => ({
  createInfer: mocks.inferCreate,
  getInferRun: mocks.inferGet,
  listInferRuns: mocks.inferList,
  pauseInfer: vi.fn(),
  resumeInfer: vi.fn(),
  stopInfer: vi.fn(),
  saveInferVariant: vi.fn(),
  getInferResults: vi.fn(async () => ({ run_id: 'x', evaluated: 0, ranked: 0, rows: [], finalists: [] })),
  deleteInferRun: mocks.remove,
  formatInferDuration: (seconds: number | null) => (seconds == null ? '—' : `${Math.round(seconds)} 秒`),
  INFER_POLL_MS: 2000,
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
  method: 'stat_v1',
  method_name: '统计分析方法 1：持有期胜率与超额',
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

const METHODS = [
  {
    id: 'stat_v1',
    name: '统计分析方法 1：持有期胜率与超额',
    version: 'v4',
    summary: '',
    forward_days: 30,
    windows: [5, 10, 15, 20, 25, 30],
    targets: [],
    params: [{ key: 'validate_days', label: '验证天数', kind: 'int', default: 30, hint: '',
      min: 1, max: 30, choices: [] }],
    outputs: ['明细.xlsx'],
    caliber: '',
    entry: '',
    default: true,
  },
  {
    id: 'stat_v2',
    name: '统计分析方法 2：最高价达成率与覆盖率',
    version: 'v1',
    summary: '',
    forward_days: 35,
    windows: [5, 10, 15, 20, 25, 35],
    targets: [0.01, 0.02, 0.03, 0.05, 0.1],
    params: [],
    outputs: ['window_summary.csv', 'report.md'],
    caliber: '',
    entry: '',
  },
]

/** 方法 2 的统一信封（一个结论卡 + 一张表 + 一个产物） */
const standardEnvelope = () => ({
  run: runMeta({
    status: 'done',
    running: false,
    method: 'stat_v2',
    method_name: '统计分析方法 2：最高价达成率与覆盖率',
  }),
  counts: { signals: 900, hits: 900, control: 1200, days: 100 },
  result: {
    schema_version: '1',
    method: METHODS[1],
    parameters: {},
    headline: {
      verdict: 'usable',
      title: '这个条件明显好于同期随机买入',
      detail: '10 日上涨概率 52.5%，基准 47.0%。',
      metrics: [{ key: 'best_window', label: '最优窗口', value: 10, unit: '日', hint: '' }],
    },
    tables: [
      {
        key: 'window_summary',
        title: '各窗口最高价达成率',
        hint: '窗口越长数值越大',
        columns: [
          { key: 'window', label: '窗口', kind: 'int' },
          { key: 'positive_rate', label: '上涨概率', kind: 'percent' },
        ],
        rows: [{ window: 10, positive_rate: 52.5 }],
        total_rows: 1,
        sort: null,
      },
    ],
    artifacts: [{ name: 'report.md', kind: 'md', size: 2048, label: 'report.md', url: '/x' }],
    data_quality: {},
    notes: [],
    generated_at: '',
  },
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
    mocks.history.mockResolvedValue([])
    mocks.inferList.mockResolvedValue([])
    mocks.preview.mockResolvedValue({
      days: 1650,
      first_day: '2020-01-02',
      last_day: '2026-10-21',
      latest_trade_date: '2026-10-21',
      max_end_date: '2026-10-21',
      max_test_end_date: '2026-10-21',
      effective_end_date: '2026-09-09',
      test_effective_end_date: '2026-09-09',
      train_days: 433,
      test_days: 160,
      infer_split: { train_end: '2025-06-30', valid_start: '2025-07-01' },
      validate_days: 30,
      horizons: [5, 10, 15, 20, 25, 30],
      trading_days: 30,
      markets: ['sh', 'sz', 'cyb', 'kcb'],
      include_st: false,
      sample_size: 200,
    })
    mocks.stocks.mockResolvedValue({ total: 0, items: [] })
    mocks.signals.mockResolvedValue([])
    mocks.methods.mockResolvedValue(METHODS)
    mocks.result.mockResolvedValue(standardEnvelope())
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

  it('表单里不再有股票范围：市场与 ST 都不出现，创建请求也不带这两个字段', async () => {
    mocks.create.mockResolvedValue(runMeta())
    renderDialog()
    const user = userEvent.setup()
    await screen.findByText('创建数据分析任务')
    // 用户 2026-11-04 第 1 条：市场由条件自己指定，表单不再选
    expect(screen.queryByRole('button', { name: '上证' })).toBeNull()
    expect(screen.queryByRole('switch', { name: '包含 ST / *ST' })).toBeNull()
    expect(document.body.textContent).not.toContain('股票范围')
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1))
    const payload = mocks.create.mock.calls[0][0]
    expect(payload.markets).toBeUndefined()
    expect(payload.include_st).toBeUndefined()
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
    expect(payload.start_date).toBe('2024-01-01')
    // 用户 2026-11-04 第 1 条：没有测试段、没有股票范围覆盖
    expect(payload.test_start_date).toBeUndefined()
    expect(payload.test_end_date).toBeUndefined()
    expect(payload.markets).toBeUndefined()
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run="running"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
    expect(document.body.textContent).toContain('已完成 100 / 1650 个交易日')
  })

  it('任务在跑时新建表单仍在，排在进行中面板下面，且没有「新建任务」按钮', async () => {
    mocks.create.mockResolvedValue(runMeta())
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run="running"]')).toBeTruthy())

    // 用户 2026-11-04：不再是互斥的两个页面，表单常驻展开
    const form = document.querySelector('[data-fork-analysis-create]')
    const panel = document.querySelector('[data-fork-analysis-run="running"]')
    expect(form).toBeTruthy()
    expect(form?.className).toContain('order-2')
    expect(panel?.className).toContain('order-1')
    // 表单排在面板之后（视觉上在下面），所以创建按钮仍然可点
    expect(document.querySelector('[data-fork-analysis-create-button]')).toBeTruthy()
    // 切换按钮已删除：文案和按钮都不该再出现
    expect(screen.queryByRole('button', { name: '新建任务' })).toBeNull()
    expect(document.body.textContent).not.toContain('新建任务')
  })

  it('不留半屏空白：弹窗贴合内容，不强制 80vh，卡片也不再撑满', async () => {
    mocks.create.mockResolvedValue(runMeta())
    renderDialog()

    // 根因：固定 h-[80vh] 时，内容短就必然在底部留白；把卡片 grow 只是把空白
    // 换成「空卡片」。正确做法是让弹窗高度跟着内容走，只用 max-h 封顶。
    const dlg = document.querySelector('[data-fork-analysis-dialog]') as HTMLElement
    expect(dlg.className).toContain('max-h-[85vh]')
    expect(dlg.className).not.toContain('h-[80vh]')

    const idleCard = document.querySelector('[data-fork-analysis-create] > div') as HTMLElement
    expect(idleCard.className).not.toContain('grow')

    // 内容超高时必须能滚，而不是被 overflow-hidden 裁掉
    const scroller = document.querySelector('[data-fork-analysis-create]')!.parentElement as HTMLElement
    expect(scroller.className).toContain('overflow-y-auto')
    expect(scroller.className).toContain('max-h-[')

    // 有任务面板时也不撑满（同样是为了不留白）
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run="running"]')).toBeTruthy())
    const busyCard = document.querySelector('[data-fork-analysis-create] > div') as HTMLElement
    expect(busyCard.className).not.toContain('grow')
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
    // 结束时间默认 = 最新交易日（显示口径；实际分析到哪天由后端 effective_end_date 决定）
    await waitFor(() => expect((document.querySelector('[data-fork-analysis-end]') as HTMLInputElement).value)
      .toBe('2026-10-21'))
  })

  it('分析结束时间按显示口径收到最新交易日，实际分析到「减验证天数」那天', async () => {
    renderDialog()
    const user = userEvent.setup()
    const end = (await screen.findByLabelText('分析结束时间')) as HTMLInputElement
    // 显示口径 = 最新交易日；提示里写明实际分析到 2026-09-09
    await waitFor(() => expect(end.value).toBe('2026-10-21'))
    // 预估回来之后提示里写明实际分析到哪天（要等 300ms 防抖）
    await waitFor(() =>
      expect(document.querySelector('[data-fork-analysis-end-hint]')?.textContent)
        .toContain('2026-09-09'),
    )
    await user.clear(end)
    await user.type(end, '2026-12-31')
    expect(end.value <= '2026-10-21').toBe(true)
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

  it('历史 tab 里点分析任务在新窗口打开任务详情（不在弹窗里再嵌一层对话框）', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    mocks.history.mockResolvedValue([
      runMeta({ status: 'done', running: false, days_done: 1650, hits: 1800, excel_ready: true,
        kind: 'analysis', score_train: 66.2, score_test: 61.8 }),
    ])
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: '历史任务' }))
    const row = await waitFor(() => {
      const node = document.querySelector('[data-fork-history-row="analysis"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    await user.click(row)
    // 新窗口、无导航无返回：kind 进 URL，由独立页面自己渲染
    expect(open).toHaveBeenCalledWith('/analysis/task/analysis/20261022-120000-abcd', '_blank', 'noopener')
    // 弹窗里不该再出现内嵌详情，也不该替页面去拉详情接口
    expect(document.querySelector('[data-fork-analysis-task-detail]')).toBeNull()
    expect(mocks.detail).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it('历史 tab 直接列出全部任务（不再是简版 + 查看全部两层）', async () => {
    mocks.history.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => runMeta({
        run_id: `2026102${index % 9}-1000${index}-abcd`,
        status: 'done',
        running: false,
        kind: 'analysis',
      })),
    )
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: '历史任务' }))
    await waitFor(() => expect(document.querySelectorAll('[data-fork-history-row]').length).toBe(12))
    expect(screen.queryByRole('button', { name: '查看全部' })).toBeNull()
    expect(mocks.history).toHaveBeenCalledWith(500)
  })

  it('推理任务点开走的是 infer 详情页，不丢给分析详情接口', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    mocks.history.mockResolvedValue([
      runMeta({ run_id: '20261102-031502-o898', status: 'done', running: false, kind: 'infer',
        preset: 'r11020315', score_train: 53.1, score_test: 57.0 }),
    ])
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: '历史任务' }))
    const row = await waitFor(() => {
      const node = document.querySelector('[data-fork-history-row="infer"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    await user.click(row)
    expect(open).toHaveBeenCalledWith('/analysis/task/infer/20261102-031502-o898', '_blank', 'noopener')
    // 关键：不能去问分析详情（那会报「分析任务 xxx 不存在」），也不在弹窗里切到推理面板
    expect(mocks.detail).not.toHaveBeenCalled()
    expect(mocks.inferGet).not.toHaveBeenCalled()
    expect(document.querySelector('[data-fork-infer-panel]')).toBeNull()
    open.mockRestore()
  })

  it('打开时若有任务在跑，直接进那个任务的进度页', async () => {
    mocks.listRuns.mockResolvedValue([runMeta()])
    mocks.history.mockResolvedValue([runMeta()])
    renderDialog()
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-run="running"]')).toBeTruthy())
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy()
  })

  it('历史记录显示有效范围（通用 / 个股）', async () => {
    mocks.listRuns.mockResolvedValue([])
    mocks.history.mockResolvedValue([
      runMeta({ run_id: 'r-general', status: 'done', running: false, kind: 'infer',
        score_train: 66.2, score_test: 64.0, scope_label: '通用' }),
      runMeta({ run_id: 'r-stock', status: 'done', running: false, kind: 'infer',
        score_train: 55.0, score_test: 52.0, scope_label: '个股', stock_best_score: 88.4 }),
    ])
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: '历史任务' }))
    await waitFor(() => expect(document.querySelectorAll('[data-fork-history-scope]').length).toBe(2))
    expect(screen.getByText('有效范围')).toBeTruthy()
    expect(document.querySelector('[data-fork-history-scope="通用"]')).toBeTruthy()
    expect(document.querySelector('[data-fork-history-scope="个股"]')).toBeTruthy()
  })

  it('运行中的推理任务：进推理面板，不显示「已完成 undefined / N 个交易日」', async () => {
    mocks.listRuns.mockResolvedValue([])
    mocks.history.mockResolvedValue([
      runMeta({ run_id: '20261102-134622-ti3b', status: 'running', running: true, kind: 'infer',
        preset: 'r11021346', days_total: 652, days_done: null, score_train: null, score_test: null }),
    ])
    mocks.inferGet.mockResolvedValue({
      run_id: '20261102-134622-ti3b',
      created_at: '2026-11-02T13:46:22+08:00',
      status: 'running',
      preset: 'r11021346',
      iterations: 1000,
      done_iterations: 86,
      alive: true,
      train_start: '2024-01-02',
      train_end: '2025-12-31',
      valid_start: '2026-01-05',
      valid_end: '2026-09-09',
      progress: { phase: 'searching', done_iterations: 86, iterations: 1000 },
    })
    renderDialog()
    await waitFor(() => expect(document.querySelector('[data-fork-infer-panel]')).toBeTruthy())
    expect(document.body.textContent).not.toContain('undefined')
    // 判定的是「分析任务那套进度模板没被套到推理任务上」：
    // 推理没有「天」，套错了就会渲染成「已完成 undefined / 652 个交易日」。
    // 不能再用整页文本查「个交易日」——新建表单常驻，本来就带这句。
    expect(document.querySelector('[data-fork-analysis-run]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/已完成\s*undefined/)
  })

  it('选股条件还在、统计方法下拉已删除（只剩一套方法）', async () => {
    renderDialog()
    await screen.findByText('创建数据分析任务')
    const body = document.body.textContent ?? ''
    expect(body).toContain('选股条件')
    expect(body).not.toContain('已保存条件')
    expect(document.querySelector('[data-fork-analysis-method]')).toBeNull()
    expect(body).not.toContain('统计方法')
  })

  it('两行时间：分析开始 / 分析结束，顺序与默认值正确，下面紧跟验证天数', async () => {
    renderDialog()
    await screen.findByText('创建数据分析任务')
    const start = document.querySelector('[data-fork-analysis-start]') as HTMLElement
    const end = document.querySelector('[data-fork-analysis-end]') as HTMLElement
    const days = document.querySelector('[data-fork-analysis-validate-days]') as HTMLInputElement
    expect(start && end && days).toBeTruthy()
    expect(start.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(end.compareDocumentPosition(days) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect((start as HTMLInputElement).value).toBe('2024-01-01')
    expect(days.value).toBe('30')
    // 用户 2026-11-04 第 1 条：测试段的两个日期框已经删掉
    expect(document.querySelector('[data-fork-analysis-test-start]')).toBeNull()
    expect(document.querySelector('[data-fork-analysis-test-end]')).toBeNull()
  })

  it('条件推理：不勾选时次数不可编辑，勾选后能改，默认 100 次', async () => {
    renderDialog()
    const user = userEvent.setup()
    await screen.findByText('创建数据分析任务')
    const enable = document.querySelector('[data-fork-analysis-infer-enabled]') as HTMLInputElement
    const iterations = document.querySelector('[data-fork-analysis-infer-iterations]') as HTMLInputElement
    expect(enable.checked).toBe(false)
    expect(iterations.disabled).toBe(true)
    expect(iterations.value).toBe('100')
    await user.click(enable)
    expect(iterations.disabled).toBe(false)
    await user.clear(iterations)
    await user.type(iterations, '300')
    expect(iterations.value).toBe('300')
  })

  it('勾选条件推理后创建的是推理任务，不是分析任务', async () => {
    mocks.inferCreate.mockResolvedValue({
      run_id: '20261024-120000-abcd',
      created_at: '2026-10-24T12:00:00+08:00',
      status: 'running',
      preset: 'xg1',
      train_start: '2024-01-01',
      train_end: '2025-12-31',
      valid_start: '2026-01-01',
      valid_end: '2026-09-09',
      iterations: 100,
      done_iterations: 0,
      alive: true,
      progress: { phase: 'searching', done_iterations: 0, iterations: 100, current: '',
        best_score: null, best_desc: '', elite: 0, elapsed_s: 5, eta_s: 600,
        variants_evaluated: 1, load_progress: 1 },
    })
    renderDialog()
    const user = userEvent.setup()
    await screen.findByText('创建数据分析任务')
    await user.click(document.querySelector('[data-fork-analysis-infer-enabled]') as HTMLElement)
    // 切分点是预览接口给的（7:3），拿到之后创建按钮才可点
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-infer-split]')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(mocks.inferCreate).toHaveBeenCalledTimes(1))
    expect(mocks.create).not.toHaveBeenCalled()
    const payload = mocks.inferCreate.mock.calls[0][0]
    expect(payload.train_start).toBe('2024-01-01')
    // 用户 2026-11-04 第 1 条：没有测试日期输入了，切分点由后端预览给出（7:3）
    expect(payload.train_end).toBe('2025-06-30')
    expect(payload.valid_start).toBe('2025-07-01')
    expect(payload.iterations).toBe(100)
    await waitFor(() => expect(document.querySelector('[data-fork-infer-panel]')).toBeTruthy())
    expect(document.body.textContent).toContain('已完成 0 / 100 次')
  })

  it('历史 tab 同时显示两类任务，评分一列（推理任务显示「搜索 / 验算」）', async () => {
    mocks.history.mockResolvedValue([
      runMeta({ status: 'done', running: false, kind: 'analysis', score_train: 66.2, score_test: null }),
      runMeta({ run_id: '20261024-120000-abcd', status: 'done', running: false, kind: 'infer',
        score_train: 78.4, score_test: 70.1, created_at: '2026-10-24T12:00:00+08:00' }),
    ])
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('tab', { name: '历史任务' }))
    await waitFor(() => expect(document.querySelectorAll('[data-fork-history-row]').length).toBe(2))
    const body = document.body.textContent ?? ''
    expect(body).toContain('分析')
    expect(body).toContain('条件推理')
    const scores = Array.from(document.querySelectorAll('[data-fork-history-score]')).map(n => n.textContent)
    // 分析任务：只有一个分；推理任务：搜索分 / 验算分
    expect(scores).toContain('66.2')
    expect(scores).toContain('78.4 / 70.1')
    // 表头只剩一列「评分」，不再有「推理分 / 测试分」两列
    expect(body).not.toContain('推理分')
    expect(body).not.toContain('测试分')
  })

  it('方法 2 跑完：用统一信封渲染（结论卡 + 表 + 产物），没有 Excel 按钮', async () => {
    mocks.create.mockResolvedValue(
      runMeta({ status: 'done', running: false, method: 'stat_v2',
        method_name: '统计分析方法 2：最高价达成率与覆盖率', days_done: 100, hits: 900 }),
    )
    renderDialog()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(document.querySelector('[data-fork-analysis-standard="stat_v2"]')).toBeTruthy())
    expect(document.querySelector('[data-fork-analysis-verdict-text]')?.textContent)
      .toContain('明显好于同期随机买入')
    expect(document.body.textContent).toContain('各窗口最高价达成率')
    // 百分比按 kind 格式化，不是裸数字
    expect(document.body.textContent).toContain('52.50%')
    // 产物按名字列出，点它下载
    expect(document.querySelector('[data-fork-analysis-artifact="report.md"]')).toBeTruthy()
    // 方法 2 不生成 Excel：界面上不该有「下载 Excel」
    expect(screen.queryByRole('button', { name: '下载 Excel' })).toBeNull()
  })

  /**
   * 2026-11-05 第 3 / 4 条：说明搬进「历史任务」tab；弹窗高度固定，切 tab 不跳。
   */
  it('A1 说明只在「历史任务」tab 里显示，顶部只剩屏幕阅读器文本', async () => {
    const user = userEvent.setup()
    renderDialog()

    const content = document.querySelector('[data-fork-analysis-dialog]') as HTMLElement
    const descId = content.getAttribute('aria-describedby')
    const desc = descId ? document.getElementById(descId) : null
    expect(desc).not.toBeNull()
    expect(desc!.className).toContain('sr-only')

    // 创建任务 tab 里没有那句说明
    expect(document.querySelector('[data-fork-analysis-hint="history"]')).toBeNull()

    await user.click(screen.getByRole('tab', { name: '历史任务' }))
    const hint = document.querySelector('[data-fork-analysis-hint="history"]') as HTMLElement
    expect(hint).not.toBeNull()
    expect(hint.textContent).toContain('60 分 = 能和随机买入拉开差距')
  })

  it('A2 弹窗有明确高度上限：切 tab 前后类名不变，且不会溢出视口', async () => {
    const user = userEvent.setup()
    renderDialog()

    const content = () => document.querySelector('[data-fork-analysis-dialog]') as HTMLElement
    const before = content().className
    expect(before).toContain('max-h-[85vh]')
    expect(before).toContain('min-h-[320px]')
    expect(before).toContain('flex-col')

    await user.click(screen.getByRole('tab', { name: '历史任务' }))
    expect(content().className).toBe(before)
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
