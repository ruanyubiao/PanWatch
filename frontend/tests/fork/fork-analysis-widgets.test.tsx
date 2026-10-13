import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAPI } from '@panwatch/api'
import { MarketCalendarPanel } from '@/components/fork/MarketCalendarPanel'
import { MarketStockList } from '@/components/fork/MarketStockList'
import type { MarketStatus } from '@/components/MarketCalendarStatus'

vi.mock('@panwatch/api', () => ({ fetchAPI: vi.fn() }))
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

const catalogItem = { symbol: '600519', name: '贵州茅台', board: 'sh' }
const counts = { all: 5758, sh: 1665, sz: 1447, kcb: 605, cyb: 1371, st: 320 }

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
        existingSymbols={new Set<string>()}
        onAdd={() => {}}
        onRemove={() => {}}
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

  it('未关注显示 + 且点击走关注，已关注显示 X 且点击走取消关注', async () => {
    const onAdd = vi.fn()
    const onRemove = vi.fn()
    mockCatalog()

    const view = render(
      <MarketStockList
        board="all"
        existingSymbols={new Set<string>()}
        onAdd={onAdd}
        onRemove={onRemove}
      />,
    )

    // 未关注：+ 号，没有「已关注」标记
    const addButton = await screen.findByRole('button', { name: '关注' })
    expect(screen.queryByText('已关注')).toBeNull()
    await userEvent.click(addButton)
    expect(onAdd).toHaveBeenCalledWith(catalogItem)
    expect(onRemove).not.toHaveBeenCalled()

    // 已关注：X 号 + 「已关注」标记
    view.rerender(
      <MarketStockList
        board="all"
        existingSymbols={new Set(['600519'])}
        onAdd={onAdd}
        onRemove={onRemove}
      />,
    )
    const removeButton = await screen.findByRole('button', { name: '取消关注' })
    expect(screen.queryByRole('button', { name: '关注' })).toBeNull()
    expect(screen.getByText('已关注')).toBeTruthy()
    await userEvent.click(removeButton)
    expect(onRemove).toHaveBeenCalledWith(catalogItem)
  })
})
