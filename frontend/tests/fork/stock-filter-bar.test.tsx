import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StockFilterBar } from '@/components/fork/StockFilterBar'
import { EMPTY_MARKET_FILTERS, type MarketTableFilters } from '@/lib/market-filters'

/**
 * 分析页筛选行（用户第二轮：控件照「机会页」那套下拉 + 清空筛选）。
 *
 * 钉住四件事：
 *   1. 板块 pill 是单选，顺序 = 全部 / 上证 / 深证 / **创业** / **科创** / ST，带计数
 *   2. 状态与市值是**多选下拉**（勾多项 = 并集，再点一次 = 取消）
 *   3. 涨跌是单选下拉
 *   4. 「清空筛选」连**市场**一起复位；没有任何筛选生效时它不出现
 *
 * 注：Radix 的单选下拉（涨跌）在 jsdom 里点选项不稳，这里只断言它在位并带无障碍名字，
 * 交互本身由 lib 层单测（matchChange / 选项表）与浏览器里的实测覆盖。
 */

const STATUS_OPTIONS = [
  { key: 'buy', label: '买入' },
  { key: 'avoid', label: '回避' },
  { key: 'watch', label: '观望' },
]

const COUNTS = { all: 5574, sh: 1632, sz: 1421, cyb: 1369, kcb: 605, st: 201 }

function renderBar(over: Partial<React.ComponentProps<typeof StockFilterBar>> = {}) {
  const onBoardChange = vi.fn()
  const onFiltersChange = vi.fn()
  render(
    <StockFilterBar
      board="all"
      onBoardChange={onBoardChange}
      counts={COUNTS}
      filters={EMPTY_MARKET_FILTERS}
      onFiltersChange={onFiltersChange}
      statusOptions={STATUS_OPTIONS}
      {...over}
    />,
  )
  return { onBoardChange, onFiltersChange }
}

afterEach(() => cleanup())

const pillTexts = () =>
  Array.from(document.querySelectorAll('button[aria-pressed]')).map(node => node.textContent)

const openSelect = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('button', { name: label }))
}

describe('fork: 分析页筛选行', () => {
  it('板块 pill：单选，顺序 全部 / 上证 / 深证 / 创业 / 科创 / ST，带计数', () => {
    renderBar()
    expect(pillTexts()).toEqual([
      '全部 (5574)',
      '上证 (1632)',
      '深证 (1421)',
      '创业 (1369)',
      '科创 (605)',
      'ST (201)',
    ])
  })

  it('点板块 pill 走 onBoardChange（单选）', async () => {
    const user = userEvent.setup()
    const { onBoardChange } = renderBar()
    await user.click(screen.getByRole('button', { name: '创业 (1369)' }))
    expect(onBoardChange).toHaveBeenCalledWith('cyb')
  })

  it('状态是多选下拉：勾一项 → 数组里多一项；再点一次 → 取消', async () => {
    const user = userEvent.setup()
    const { onFiltersChange } = renderBar()
    await openSelect(user, '全部状态')
    await user.click(await screen.findByRole('option', { name: /买入/ }))
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: ['buy'], change: 'all', cap: [] })

    cleanup()
    const second = renderBar({ filters: { ...EMPTY_MARKET_FILTERS, status: ['buy'] } })
    await openSelect(user, '全部状态')
    await user.click(await screen.findByRole('option', { name: /买入/ }))
    expect(second.onFiltersChange).toHaveBeenLastCalledWith({ status: [], change: 'all', cap: [] })
  })

  it('状态下拉里「全部状态」这一行 = 清空该组', async () => {
    const user = userEvent.setup()
    const { onFiltersChange } = renderBar({ filters: { ...EMPTY_MARKET_FILTERS, status: ['buy', 'avoid'] } })
    await openSelect(user, '全部状态')
    await user.click(await screen.findByRole('option', { name: '全部状态' }))
    expect(onFiltersChange).toHaveBeenLastCalledWith({ status: [], change: 'all', cap: [] })
  })

  it('市值是多选：勾两档 = 并集（数组两个元素）', async () => {
    const user = userEvent.setup()
    const first = renderBar()
    await openSelect(user, '全部市值')
    await user.click(await screen.findByRole('option', { name: /^50亿/ }))
    expect(first.onFiltersChange).toHaveBeenLastCalledWith({ status: [], change: 'all', cap: ['lt50'] })

    cleanup()
    const second = renderBar({
      filters: { ...EMPTY_MARKET_FILTERS, cap: ['lt50'] } as MarketTableFilters,
    })
    await openSelect(user, '全部市值')
    await user.click(await screen.findByRole('option', { name: /^100亿/ }))
    expect(second.onFiltersChange).toHaveBeenLastCalledWith({ status: [], change: 'all', cap: ['lt50', 'lt100'] })
  })

  it('涨跌是单选下拉（选项里「全部涨跌」= 不限）', () => {
    renderBar()
    expect(screen.getByLabelText('全部涨跌')).toBeTruthy()
  })

  it('「清空筛选」把市场一起复位；没有筛选生效时不出现', async () => {
    const user = userEvent.setup()
    const { onBoardChange, onFiltersChange } = renderBar({ board: 'cyb' })
    await user.click(screen.getByRole('button', { name: '清空筛选' }))
    expect(onBoardChange).toHaveBeenCalledWith('all')
    expect(onFiltersChange).toHaveBeenCalledWith(EMPTY_MARKET_FILTERS)

    cleanup()
    renderBar({ board: 'all', filters: EMPTY_MARKET_FILTERS })
    expect(screen.queryByRole('button', { name: '清空筛选' })).toBeNull()
  })

  it('只有其余三组生效时也出现「清空筛选」', () => {
    renderBar({ filters: { status: ['buy'], change: 'all', cap: [] } })
    expect(screen.getByRole('button', { name: '清空筛选' })).toBeTruthy()
  })
})
