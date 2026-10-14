import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import { StockMarketTable, MARKET_FETCH_LIMIT } from '@/components/fork/StockMarketTable'
import type { MarketRow, MarketTableResponse } from '@/lib/fork-kline-summary'

vi.mock('@panwatch/api', () => ({ fetchAPI: vi.fn() }))

/**
 * fork 分析页的行表格。这里钉住用户明确要求过的事：
 *   1. 列的**顺序与名称**（市场 代码 名称 昨收价 现价 涨跌 最高价 最低价 总市值 状态 Agent状态 来源 操作）
 *   2. 数据**只**来自 /stocks/market-table —— 再也不发 /quotes/batch 与
 *      /klines/summary/batch（那两条就是「查外网次数太多被屏蔽」的元凶）
 *   3. 市场列只出 沪/深/北
 *   4. **全量取一次**，此后筛选/排序/翻页/搜索全在前端（不再打接口）
 *   5. 表头可排序，「状态」按库里 tech_score 排、无分恒排最后
 *   6. 分页条上下各一条（同一种形式）
 */

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  code: '600519',
  symbol: 'sh600519',
  exchange: 'SH',
  name: '贵州茅台',
  board: 'sh',
  trade_date: '2026-10-14',
  pre_close: 1286.0,
  open: 1280,
  close: 1290.5,
  high: 1299,
  low: 1276.02,
  change_amount: 4.5,
  change_pct: 0.35,
  total_market_cap: 1607604938886,
  source: 'sina',
  adj_factor: 1,
  ma: { ma5: 1280, ma10: 1270, ma20: 1250, ma60: 1200 },
  tech: {
    score: 6,
    trend: '多头排列',
    macd: '金叉(5日)',
    rsi: '偏强',
    kdj: '金叉',
    boll: '正常波动',
    volume: '平量',
    support: 1250,
    resistance: 1300,
  },
  ...over,
})

/** 三只票：沪（score 6）／深（score -3）／北（无 tech_*） */
const threeRows = (): MarketRow[] => [
  row(),
  row({
    code: '000001',
    symbol: 'sz000001',
    exchange: 'SZ',
    name: '平安银行',
    board: 'sz',
    close: 11.59,
    change_pct: -1.61,
    total_market_cap: 224914591914.82,
    tech: { ...row().tech!, score: -3 },
  }),
  row({
    code: '920000',
    symbol: 'bj920000',
    exchange: 'BJ',
    name: '安徽凤凰',
    board: 'other',
    close: 12.3,
    pre_close: 12.5,
    change_pct: -1.6,
    high: 12.6,
    low: 12.2,
    total_market_cap: 1000000000,
    tech: null,
  }),
]

const response = (items: MarketRow[] = threeRows()): MarketTableResponse => ({
  asof: '2026-10-14',
  total: items.length,
  offset: 0,
  limit: MARKET_FETCH_LIMIT,
  counts: { all: items.length, sh: 1, sz: 1, kcb: 0, cyb: 0, st: 0 },
  items,
})

const renderTable = (props: Partial<React.ComponentProps<typeof StockMarketTable>> = {}) => {
  const onAdd = vi.fn()
  const onRemove = vi.fn()
  const onCounts = vi.fn()
  const onOpenDetail = vi.fn()
  render(
    <StockMarketTable
      board="all"
      query=""
      existingSymbols={new Set<string>()}
      onCounts={onCounts}
      onAdd={onAdd}
      onRemove={onRemove}
      onOpenDetail={onOpenDetail}
      renderStatus={r => <span>状态-{r.code}</span>}
      renderAgentStatus={() => <span>未配置 Agent</span>}
      renderSource={r => <span>技术指标 · {r.trade_date?.slice(5)}</span>}
      renderActions={(r, state) => (
        <button onClick={() => (state.followed ? state.onUnfollow() : state.onFollow())}>
          操作-{r.code}
        </button>
      )}
      {...props}
    />,
  )
  return { onAdd, onRemove, onCounts, onOpenDetail }
}

const urlsOf = () => vi.mocked(fetchAPI).mock.calls.map(call => String(call[0]))

/** 表格里第 n 行的代码列文本（用于验证排序结果）。 */
const codesInOrder = (): string[] =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map(node => within(node).getAllByRole('cell')[1].textContent?.trim() || '')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('fork: 分析页全市场表格', () => {
  it('表头顺序与用户给的列序完全一致', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const table = screen.getByRole('table')
    const headers = within(table)
      .getAllByRole('columnheader')
      .map(node => node.textContent?.trim())
    expect(headers).toEqual([
      '市场',
      '代码',
      '名称',
      '昨收价',
      '现价',
      '涨跌',
      '最高价',
      '最低价',
      '总市值',
      '状态',
      'Agent 状态',
      '来源',
      '操作',
    ])
  })

  it('全量只取一次，且不再发外网批量行情/技术面请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const urls = urlsOf()
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/stocks/market-table')
    expect(urls[0]).toContain('board=all')
    expect(urls[0]).toContain(`limit=${MARKET_FETCH_LIMIT}`)
    // 被数据源限流的那两条，全市场列表中必须一条都不发
    expect(urls.filter(url => url.includes('/quotes/batch'))).toHaveLength(0)
    expect(urls.filter(url => url.includes('/klines/summary/batch'))).toHaveLength(0)
  })

  it('板块筛选与搜索都在前端做：换了不发新请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { rerender } = render(
      <StockMarketTable
        board="all"
        query=""
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderStatus={() => null}
        renderAgentStatus={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    // 换板块 → 只剩沪市那只
    rerender(
      <StockMarketTable
        board="sh"
        query=""
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderStatus={() => null}
        renderAgentStatus={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )
    await waitFor(() => expect(screen.queryByText('平安银行')).toBeNull())
    expect(screen.getByText('贵州茅台')).toBeTruthy()

    expect(urlsOf()).toHaveLength(1)
  })

  it('市场列只出 沪/深/北 + 数值按列格式化', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    // 默认按代码升序：000001 → 600519 → 920000
    const [shen, hu, bei] = rows

    expect(within(hu).getByText('沪')).toBeTruthy()
    expect(within(hu).getByText('600519')).toBeTruthy()
    expect(within(hu).getByText('1286.00')).toBeTruthy() // 昨收价
    expect(within(hu).getByText('1290.50')).toBeTruthy() // 现价
    expect(within(hu).getByText('+0.35%')).toBeTruthy()
    expect(within(hu).getByText('1299.00')).toBeTruthy() // 最高价
    expect(within(hu).getByText('1276.02')).toBeTruthy() // 最低价
    expect(within(hu).getByText('1.61万亿')).toBeTruthy() // 总市值

    expect(within(shen).getByText('深')).toBeTruthy()
    expect(within(shen).getByText('-1.61%')).toBeTruthy()
    expect(within(shen).getByText('2249.15亿')).toBeTruthy()

    expect(within(bei).getByText('北')).toBeTruthy()
    // 富列由页面注入
    expect(within(hu).getByText('状态-600519')).toBeTruthy()
    expect(within(hu).getByText('未配置 Agent')).toBeTruthy()
    expect(within(hu).getByText('技术指标 · 10-14')).toBeTruthy()
    expect(within(hu).getByText('操作-600519')).toBeTruthy()
  })

  it('代码与名称是文字按钮，点击回调到页面的详情弹窗', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { onOpenDetail } = renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: '贵州茅台' }))
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
    expect(onOpenDetail.mock.calls[0][0].code).toBe('600519')

    await userEvent.click(screen.getByRole('button', { name: '600519' }))
    expect(onOpenDetail).toHaveBeenCalledTimes(2)
  })

  it('各板块计数从全量数据里数出来并回传（pill 上的数字）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { onCounts } = renderTable()

    await waitFor(() => expect(onCounts).toHaveBeenCalled())
    // 北交所那只 board='other'：只计入「全部」
    expect(onCounts.mock.calls[0][0]).toEqual({ all: 3, sh: 1, sz: 1, kcb: 0, cyb: 0, st: 0 })
  })

  it('翻页只切前端切片，不再打接口', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    await userEvent.click(screen.getAllByRole('button', { name: '下一页' })[0])

    expect(urlsOf()).toHaveLength(1)
    expect(screen.getByText('贵州茅台')).toBeTruthy()
  })

  it('分页条上下各一条，且都显示「共 N 条」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    expect(screen.getAllByText('共 3 条')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '上一页' })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: '下一页' })).toHaveLength(2)
    // 每页条数下拉（默认 100 条/页）
    expect(screen.getAllByText('100 条/页').length).toBeGreaterThan(0)
  })

  it('表头点击排序：状态列按库里分数，无分的新股恒排最后', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    expect(codesInOrder()).toEqual(['000001', '600519', '920000'])

    // 第一次点「状态」→ 分数降序（6 在前，-3 在后，无分的最后）
    await userEvent.click(screen.getByRole('button', { name: '按状态排序' }))
    await waitFor(() => expect(codesInOrder()).toEqual(['600519', '000001', '920000']))

    // 再点一次 → 升序，但「无分」仍然在最后（不是跑到最前）
    await userEvent.click(screen.getByRole('button', { name: '按状态排序' }))
    await waitFor(() => expect(codesInOrder()).toEqual(['000001', '600519', '920000']))

    // 数值列：涨跌降序
    await userEvent.click(screen.getByRole('button', { name: '按涨跌排序' }))
    await waitFor(() => expect(codesInOrder()).toEqual(['600519', '920000', '000001']))
  })

  it('搜索走 Everything 语法，匹配「代码 + 名称」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())

    const view = (query: string) => (
      <StockMarketTable
        board="all"
        query={query}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderStatus={() => null}
        renderAgentStatus={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />
    )
    const { rerender } = render(view(''))
    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())

    // OR：平安 或 茅台 → 两只；安徽凤凰被滤掉
    rerender(view('平安|茅台'))
    await waitFor(() => expect(screen.queryByText('安徽凤凰')).toBeNull())
    expect(screen.getByText('平安银行')).toBeTruthy()
    expect(screen.getByText('贵州茅台')).toBeTruthy()

    // 空格 = AND，代码 + 名称合并匹配：600519 且 茅台
    rerender(view('600519 茅台'))
    await waitFor(() => expect(screen.queryByText('平安银行')).toBeNull())
    expect(screen.getByText('贵州茅台')).toBeTruthy()

    // AND 的两半分别落在代码和名称上也能命中
    rerender(view('000001 平安'))
    await waitFor(() => expect(screen.queryByText('贵州茅台')).toBeNull())
    expect(screen.getByText('平安银行')).toBeTruthy()

    // NOT：去掉含「银行」的
    rerender(view('!银行'))
    await waitFor(() => expect(screen.queryByText('平安银行')).toBeNull())
    expect(screen.getByText('贵州茅台')).toBeTruthy()
  })

  it('状态列口径：库里无 tech_*（新股）时不显示徽章而是「数据不足」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response([row(), row({ code: '688825', name: '长鑫科技', tech: null })]))
    render(
      <StockMarketTable
        board="all"
        query=""
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onOpenDetail={vi.fn()}
        renderStatus={r => (r.tech ? <span>badge-{r.tech.score}</span> : <span>数据不足</span>)}
        renderAgentStatus={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )

    await waitFor(() => expect(screen.getByText('badge-6')).toBeTruthy())
    expect(screen.getByText('数据不足')).toBeTruthy()
  })

  it('已关注的行给出 X（取消关注），未关注给出 +（关注）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { onAdd, onRemove } = renderTable({ existingSymbols: new Set(['000001']) })

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    await userEvent.click(screen.getByText('操作-600519'))
    expect(onAdd).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByText('操作-000001'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
