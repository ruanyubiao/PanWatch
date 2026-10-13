import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import { MarketCalendarPanel } from '@/components/fork/MarketCalendarPanel'
import { MarketStockList, type CatalogCardRenderer } from '@/components/fork/MarketStockList'
import { StockRichCard, type StockRichCardTexts } from '@/components/fork/StockRichCard'
import {
  FORK_PAGE_WIDTH_CLASS,
  STOCK_CARD_GRID_CLASS,
  STOCK_PAGE_SIZE,
} from '@/components/fork/stock-grid'
import { StockListToolbar } from '@/components/fork/StockListToolbar'
import type { MarketStatus } from '@/components/MarketCalendarStatus'

vi.mock('@panwatch/api', () => ({ fetchAPI: vi.fn() }))

const readSource = (relative: string) => {
  for (const base of [process.cwd(), join(process.cwd(), 'frontend')]) {
    const candidate = join(base, 'src', relative)
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
  }
  throw new Error(`source not found: ${relative} (cwd=${process.cwd()})`)
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks() })

const markets: MarketStatus[] = ['CN', 'HK', 'US'].map(code => ({
  code,
  status: code === 'US' ? 'pre_market' : 'closed',
  status_text: '',
  is_trading: false,
  sessions: [],
  local_time: code === 'US' ? '08:23' : '20:23',
  local_date: '2026-10-13',
  timezone: code === 'US' ? 'America/New_York' : 'Asia/Shanghai',
}))
const labelMarket = (code: string) => ({ CN: 'A股', HK: '港股', US: '美股' })[code] ?? code

const calendarData = {
  timezone: 'Asia/Shanghai',
  markets: markets.map(market => ({
    market: market.code,
    status: market.status,
    timezone: market.timezone,
    local_date: market.local_date,
    local_time: market.local_time,
    next_open: '2026-10-14T09:30:00+08:00',
    days: [{
      date: '2026-10-14',
      reason: 'trading',
      is_trading_day: true,
      session_times: market.code === 'US'
        ? [{ open: '2026-10-14T21:30:00-04:00', close: '2026-10-15T04:00:00-04:00' }]
        : [{ open: '2026-10-14T09:30:00+08:00', close: '2026-10-14T15:00:00+08:00' }],
    }],
  })),
}

describe('fork: 首页交易日历面板', () => {
  it('首页常显：不渲染任何悬停触发器，挂载即拉取日历', async () => {
    vi.mocked(fetchAPI).mockResolvedValue(calendarData)
    render(<MarketCalendarPanel markets={markets} labelMarket={labelMarket} />)

    // 上游的触发器文案（用户要求删掉的那一行）不应存在
    expect(screen.queryByRole('button', { name: '查看各市场交易日历' })).toBeNull()
    // 也不该出现触发器里的市场状态短句
    expect(screen.queryByText('已收盘')).toBeNull()

    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('columnheader').map(node => node.textContent))
      .toEqual(['交易日期', 'A股', '港股', '美股'])
    expect(fetchAPI).toHaveBeenCalledWith(
      '/stocks/markets/calendar?days=14&timezone=Asia%2FShanghai',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(screen.getByText(/状态按市场当地日期判断/)).toBeTruthy()
  })

  it('读取失败时给出重试入口', async () => {
    vi.mocked(fetchAPI).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(calendarData)
    render(<MarketCalendarPanel markets={markets} labelMarket={labelMarket} />)

    await screen.findByText('交易日历读取失败')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('table')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// fork：股票方块卡片（「关注」与「全部」共用）
// ---------------------------------------------------------------------------

const cardTexts: StockRichCardTexts = {
  etf: 'ETF',
  notConfigured: '未配置 Agent',
  noAnalysis: '暂无分析',
  klineIndicator: 'K线指标',
  relatedNews: '相关资讯',
  deepAnalysis: '深度分析',
  detail: '详情',
  follow: '关注',
  unfollow: '取消关注',
  agentCount: count => `${count} 个 Agent`,
}

const noop = () => {}

function renderCard(props: Partial<Parameters<typeof StockRichCard>[0]> = {}) {
  return render(
    <StockRichCard
      symbol="600519"
      name="贵州茅台"
      market="CN"
      badge={{ label: 'A', style: 'bg-blue-500/10 text-blue-600' }}
      followed={false}
      quote={{ current_price: 1712.5, change_pct: 1.35 }}
      priceText="1712.50"
      texts={cardTexts}
      onOpenDetail={noop}
      onOpenKline={noop}
      onOpenNews={noop}
      {...props}
    />,
  )
}

describe('fork: 共用股票卡片 StockRichCard', () => {
  it('「关注」与「全部」的卡片结构完全一致，只有右下角操作不同', () => {
    const notFollowed = renderCard({ followed: false })
    const notFollowedIcons = screen.getAllByRole('button').map(b => b.getAttribute('aria-label') || b.textContent)
    notFollowed.unmount()

    renderCard({ followed: true })
    const followedIcons = screen.getAllByRole('button').map(b => b.getAttribute('aria-label') || b.textContent)

    // 除最后一颗按钮（+/X）外，两侧按钮数量与内容完全一致 —— 这正是用户要的「UI 一样」
    expect(followedIcons.length).toBe(notFollowedIcons.length)
    expect(followedIcons.slice(0, -1)).toEqual(notFollowedIcons.slice(0, -1))
    expect(notFollowedIcons.at(-1)).toBe('关注')
    expect(followedIcons.at(-1)).toBe('取消关注')
  })

  it('未关注时渲染 + 且点击走关注；已关注时渲染 X 且点击走取消关注', async () => {
    const onFollow = vi.fn()
    const onUnfollow = vi.fn()
    const view = renderCard({ followed: false, onFollow, onUnfollow })

    await userEvent.click(screen.getByRole('button', { name: '关注' }))
    expect(onFollow).toHaveBeenCalledTimes(1)
    expect(onUnfollow).not.toHaveBeenCalled()

    view.rerender(
      <StockRichCard
        symbol="600519"
        name="贵州茅台"
        market="CN"
        badge={{ label: 'A', style: 'bg-blue-500/10 text-blue-600' }}
        followed
        priceText="1712.50"
        texts={cardTexts}
        onOpenDetail={noop}
        onOpenKline={noop}
        onOpenNews={noop}
        onFollow={onFollow}
        onUnfollow={onUnfollow}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: '取消关注' }))
    expect(onUnfollow).toHaveBeenCalledTimes(1)
  })

  it('未关注（无 id）时深度分析同样可点，不置灰、不提示先关注', async () => {
    const onDeepAnalysis = vi.fn()
    renderCard({ followed: false, onDeepAnalysis })
    const brain = screen.getByRole('button', { name: '深度分析' })
    expect((brain as HTMLButtonElement).disabled).toBe(false)
    expect(brain.getAttribute('title')).toBe('深度分析')
    await userEvent.click(brain)
    expect(onDeepAnalysis).toHaveBeenCalledTimes(1)

    cleanup()
    renderCard({ followed: true, onDeepAnalysis: noop })
    const enabled = screen.getByRole('button', { name: '深度分析' })
    expect((enabled as HTMLButtonElement).disabled).toBe(false)
    expect(enabled.getAttribute('title')).toBe('深度分析')
  })

  it('带上 agent 数量与「未配置 Agent」两种状态', () => {
    const first = renderCard({ agentCount: 4 })
    expect(screen.getByText('4 个 Agent')).toBeTruthy()
    first.unmount()

    renderCard({ agentCount: 0 })
    expect(screen.getByText('未配置 Agent')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// fork：「全部」（A 股全市场）列表
// ---------------------------------------------------------------------------

const catalogItem = { symbol: '600519', name: '贵州茅台', board: 'sh' }
const counts = { all: 5758, sh: 1665, sz: 1447, kcb: 605, cyb: 1371, st: 320 }

/** 与 ForkAnalysis 里的 renderCatalogCard 同构：交给同一个 StockRichCard 渲染 */
const testRenderer: CatalogCardRenderer = (item, state) => (
  <StockRichCard
    symbol={item.symbol}
    name={item.name}
    market="CN"
    badge={{ label: 'A', style: 'bg-blue-500/10 text-blue-600' }}
    followed={state.followed}
    quote={state.quote}
    priceText={state.quote?.current_price != null ? state.quote.current_price.toFixed(2) : '--'}
    texts={cardTexts}
    onOpenDetail={noop}
    onOpenKline={noop}
    onOpenNews={noop}
    onFollow={state.onFollow}
    onUnfollow={state.onUnfollow}
    followBusy={state.busy}
  />
)

function mockCatalog() {
  vi.mocked(fetchAPI).mockImplementation(async (path: string) => {
    if (path.startsWith('/stocks/catalog')) {
      return {
        total: 1,
        offset: 0,
        limit: 100,
        counts,
        items: [{ symbol: '600519', name: '贵州茅台', board: 'sh' }],
      }
    }
    if (path === '/quotes/batch') {
      return [{ symbol: '600519', current_price: 1712.5, change_pct: 1.35 }]
    }
    throw new Error(`unexpected ${path}`)
  })
}

describe('fork: 全部列表（A 股全市场）', () => {
  it('每页最多 100 只，只给当前页拉行情', async () => {
    mockCatalog()
    render(
      <MarketStockList
        board="all"
        query=""
        onQueryChange={() => {}}
        existingSymbols={new Set<string>()}
        onAdd={() => {}}
        onRemove={() => {}}
        renderCard={testRenderer}
      />,
    )

    await waitFor(() => expect(fetchAPI).toHaveBeenCalledWith(
      '/stocks/catalog?board=all&q=&offset=0&limit=100',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    await waitFor(() => expect(fetchAPI).toHaveBeenCalledWith(
      '/quotes/batch',
      expect.objectContaining({ method: 'POST' }),
    ))
    expect(await screen.findByText('共 1 只，当前 1-1')).toBeTruthy()
  })

  it('行交给 renderCard 渲染，用的是与「关注」同一张卡片和同一套网格', async () => {
    mockCatalog()
    const { container } = render(
      <MarketStockList
        board="all"
        query=""
        onQueryChange={() => {}}
        existingSymbols={new Set<string>()}
        onAdd={() => {}}
        onRemove={() => {}}
        renderCard={testRenderer}
      />,
    )

    // 同一张卡片组件：带 data-fork-stock-card 标识，且带「未配置 Agent」等关注卡片才有的行
    const card = await waitFor(() => {
      const node = container.querySelector('[data-fork-stock-card="600519"]')
      expect(node).toBeTruthy()
      return node as HTMLElement
    })
    expect(within(card).getByText('未配置 Agent')).toBeTruthy()
    expect(within(card).getByText('暂无分析')).toBeTruthy()
    // 网格类来自 stock-grid.ts，与「关注」列表共用 → 列数一致
    expect(container.querySelector(`.${STOCK_CARD_GRID_CLASS.split(' ')[0]}`)?.className).toBe(STOCK_CARD_GRID_CLASS)
  })

  it('未关注显示 + 且点击走关注，已关注显示 X 且点击走取消关注', async () => {
    const onAdd = vi.fn()
    const onRemove = vi.fn()
    mockCatalog()

    const view = render(
      <MarketStockList
        board="all"
        query=""
        onQueryChange={() => {}}
        existingSymbols={new Set<string>()}
        onAdd={onAdd}
        onRemove={onRemove}
        renderCard={testRenderer}
      />,
    )

    const addButton = await screen.findByRole('button', { name: '关注' })
    await userEvent.click(addButton)
    expect(onAdd).toHaveBeenCalledWith(catalogItem)
    expect(onRemove).not.toHaveBeenCalled()

    view.rerender(
      <MarketStockList
        board="all"
        query=""
        onQueryChange={() => {}}
        existingSymbols={new Set(['600519'])}
        onAdd={onAdd}
        onRemove={onRemove}
        renderCard={testRenderer}
      />,
    )
    const removeButton = await screen.findByRole('button', { name: '取消关注' })
    expect(screen.queryByRole('button', { name: '关注' })).toBeNull()
    await userEvent.click(removeButton)
    expect(onRemove).toHaveBeenCalledWith(catalogItem)
  })
})

describe('fork: 两个列表共用一个 UI（切换范围只换数据）', () => {
  it('「全部」范围渲染共用的工具栏（搜索框），搜索词由页面持有并进入请求', async () => {
    mockCatalog()
    render(
      <MarketStockList
        board="all"
        query="茅台"
        onQueryChange={() => {}}
        existingSymbols={new Set<string>()}
        onAdd={() => {}}
        onRemove={() => {}}
        renderCard={testRenderer}
      />,
    )

    expect(await screen.findByPlaceholderText('搜索代码或名称')).toBeTruthy()
    // 受控搜索词经过 300ms 防抖后进入服务端请求
    await waitFor(() => expect(fetchAPI).toHaveBeenCalledWith(
      '/stocks/catalog?board=all&q=%E8%8C%85%E5%8F%B0&offset=0&limit=100',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
  })

  it('工具栏高度固定（h-8），两个范围切换不会位移', () => {
    const { container } = render(
      <StockListToolbar value="" onChange={() => {}} placeholder="搜索代码或名称" status="共 21 只" />,
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain('h-8')
    expect(container.querySelector('input')?.className).toContain('h-8')
    expect(screen.getByText('共 21 只')).toBeTruthy()
  })

  it('当前页股票回传给页面（用于批量预取 K 线摘要 → 未关注也能显示技术面徽章）', async () => {
    mockCatalog()
    const onPageItems = vi.fn()
    render(
      <MarketStockList
        board="all"
        query=""
        onQueryChange={() => {}}
        existingSymbols={new Set<string>()}
        onAdd={() => {}}
        onRemove={() => {}}
        onPageItems={onPageItems}
        renderCard={testRenderer}
      />,
    )

    await waitFor(() => expect(onPageItems).toHaveBeenCalled())
    expect(onPageItems.mock.calls[0][0]).toEqual([catalogItem])
  })

  it('内容宽度与导航条一致（不加 max-w），超宽屏靠加列而不是限宽', () => {
    expect(FORK_PAGE_WIDTH_CLASS).toBe('w-full')
    expect(STOCK_PAGE_SIZE).toBe(100)
    // 3828px 屏：≥3700px 出 8 列 → 单卡约 460px（用户认可的密度）
    expect(STOCK_CARD_GRID_CLASS).toContain('min-[3700px]:grid-cols-8')
    expect(STOCK_CARD_GRID_CLASS).toContain('min-[1900px]:grid-cols-5')
  })

  it('「仅预警」按钮已按用户要求移除，分析页两个范围都走共用工具栏', () => {
    const page = readSource('pages/ForkAnalysis.tsx')
    expect(page).not.toContain('onlyAlerts')
    expect(page).not.toContain('仅预警')
    expect(page).not.toContain('max-w-[2400px]')
    // 关注范围 = StockListToolbar 自己渲染；全部范围 = MarketStockList 内部渲染
    expect(page).toContain('<StockListToolbar')
  })

  it('首页：收盘复盘与交易日历横向并列，放不下时转竖直', () => {
    const dashboard = readSource('pages/ForkDashboard.tsx')
    expect(dashboard).toContain('xl:grid-cols-2')
    expect(dashboard).toContain('FORK_PAGE_WIDTH_CLASS')
    expect(dashboard).not.toContain('max-w-4xl')
  })
})
