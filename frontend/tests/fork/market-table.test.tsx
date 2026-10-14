import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import { StockMarketTable } from '@/components/fork/StockMarketTable'
import { STOCK_PAGE_SIZE } from '@/components/fork/stock-grid'
import type { MarketRow, MarketTableResponse } from '@/lib/fork-kline-summary'

vi.mock('@panwatch/api', () => ({ fetchAPI: vi.fn() }))

/**
 * fork 分析页的行表格。这里钉住三件用户明确要求过的事：
 *   1. 列的**顺序与名称**（市场 代码 名称 昨收价 现价 涨跌 最高价 最低价 总市值 状态 Agent状态 来源 操作）
 *   2. 数据**只**来自 /stocks/market-table —— 再也不发 /quotes/batch 与
 *      /klines/summary/batch（那两条就是「查外网次数太多被屏蔽」的元凶）
 *   3. 市场列只出 沪/深/北
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

const response = (over: Partial<MarketTableResponse> = {}): MarketTableResponse => ({
  asof: '2026-10-14',
  total: 5574,
  offset: 0,
  limit: STOCK_PAGE_SIZE,
  counts: { all: 5574, sh: 1632, sz: 1420, kcb: 605, cyb: 1370, st: 201 },
  items: [
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
    }),
  ],
  ...over,
})

const renderTable = (props: Partial<React.ComponentProps<typeof StockMarketTable>> = {}) => {
  const onAdd = vi.fn()
  const onRemove = vi.fn()
  const onCounts = vi.fn()
  render(
    <StockMarketTable
      board="all"
      query=""
      onQueryChange={vi.fn()}
      existingSymbols={new Set<string>()}
      onCounts={onCounts}
      onAdd={onAdd}
      onRemove={onRemove}
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
  return { onAdd, onRemove, onCounts }
}

const urlsOf = () => vi.mocked(fetchAPI).mock.calls.map(call => String(call[0]))

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

  it('数据只走 /stocks/market-table —— 不再发外网批量行情/技术面请求', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable({ board: 'st' })

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const urls = urlsOf()
    expect(urls.some(url => url.startsWith('/stocks/market-table'))).toBe(true)
    expect(urls.some(url => url.includes('board=st'))).toBe(true)
    // 被数据源限流的那两条，全市场列表中必须一条都不发
    expect(urls.filter(url => url.includes('/quotes/batch'))).toHaveLength(0)
    expect(urls.filter(url => url.includes('/klines/summary/batch'))).toHaveLength(0)
  })

  it('市场列只出 沪/深/北 + 数值按列格式化', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText('贵州茅台')).toBeTruthy())
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row').slice(1)

    expect(within(rows[0]).getByText('沪')).toBeTruthy()
    expect(within(rows[0]).getByText('600519')).toBeTruthy()
    expect(within(rows[0]).getByText('1286.00')).toBeTruthy() // 昨收价
    expect(within(rows[0]).getByText('1290.50')).toBeTruthy() // 现价
    expect(within(rows[0]).getByText('+0.35%')).toBeTruthy()
    expect(within(rows[0]).getByText('1299.00')).toBeTruthy() // 最高价
    expect(within(rows[0]).getByText('1276.02')).toBeTruthy() // 最低价
    expect(within(rows[0]).getByText('1.61万亿')).toBeTruthy() // 总市值

    expect(within(rows[1]).getByText('深')).toBeTruthy()
    expect(within(rows[1]).getByText('-1.61%')).toBeTruthy()
    expect(within(rows[1]).getByText('2249.15亿')).toBeTruthy()

    expect(within(rows[2]).getByText('北')).toBeTruthy()
    // 富列由页面注入
    expect(within(rows[0]).getByText('状态-600519')).toBeTruthy()
    expect(within(rows[0]).getByText('未配置 Agent')).toBeTruthy()
    expect(within(rows[0]).getByText('技术指标 · 10-14')).toBeTruthy()
    expect(within(rows[0]).getByText('操作-600519')).toBeTruthy()
  })

  it('各板块计数回传给页面（pill 上的数字）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    const { onCounts } = renderTable()

    await waitFor(() => expect(onCounts).toHaveBeenCalled())
    expect(onCounts.mock.calls[0][0]).toEqual({
      all: 5574,
      sh: 1632,
      sz: 1420,
      kcb: 605,
      cyb: 1370,
      st: 201,
    })
  })

  it('翻页改的是 offset，不重新取板块计数（服务端分页）', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(response())
    renderTable()

    await waitFor(() => expect(screen.getByText(/共 5574 只/)).toBeTruthy())
    await userEvent.click(screen.getByRole('button', { name: /下一页/ }))

    await waitFor(() => expect(urlsOf().some(url => url.includes(`offset=${STOCK_PAGE_SIZE}`))).toBe(true))
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

  it('状态列口径：库里无 tech_*（新股）时不显示徽章而是「数据不足」', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(
      response({ total: 2, items: [row(), row({ code: '688825', name: '长鑫科技', tech: null })] }),
    )
    render(
      <StockMarketTable
        board="all"
        query=""
        onQueryChange={vi.fn()}
        existingSymbols={new Set<string>()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        renderStatus={r =>
          r.tech ? <span>badge-{r.tech.score}</span> : <span>数据不足</span>
        }
        renderAgentStatus={() => null}
        renderSource={() => null}
        renderActions={() => null}
      />,
    )

    await waitFor(() => expect(screen.getByText('badge-6')).toBeTruthy())
    expect(screen.getByText('数据不足')).toBeTruthy()
  })
})
