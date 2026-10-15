import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StockFilterBar } from '@/components/fork/StockFilterBar'
import { EMPTY_MARKET_FILTERS, type MarketTableFilters } from '@/lib/market-filters'

/**
 * 分析页筛选行（第四轮：四组**全部**做成下拉 + 清空筛选紧跟其后）。
 *
 * 钉住四件事：
 *   1. 板块也是**单选下拉**（不再是 pill），选项顺序 = 全部 / 上证 / 深证 / **创业** / **科创** / ST，带计数
 *   2. 状态与市值是**多选下拉**（勾多项 = 并集，再点一次 = 取消）
 *   3. 涨跌是单选下拉
 *   4. 「清空筛选」连**市场**一起复位，且位置**紧跟在下拉菜单后面**（不是被推到行尾）；
 *      没有任何筛选生效时它不出现
 *
 * 注：Radix 的下拉在 jsdom 里能开能点（tests/setup.ts 已补 PointerEvent / scrollIntoView 等），
 * 所以单选下拉这里也直接断言选项顺序与点击结果。
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

const openSelect = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByLabelText(label))
}

describe('fork: 分析页筛选行', () => {
  it('市场是单选下拉：选项 全部市场 / 上证 / 深证 / 创业 / 科创 / ST，各带计数', async () => {
    const user = userEvent.setup()
    renderBar()
    await openSelect(user, '全部市场')
    const options = await screen.findAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual([
      '全部市场 (5574)',
      '上证 (1632)',
      '深证 (1421)',
      '创业 (1369)',
      '科创 (605)',
      'ST (201)',
    ])
  })

  it('市场下拉的触发器宽度是另外三组的两倍（104 → 208）', () => {
    renderBar()
    const market = screen.getByLabelText('全部市场')
    expect(market.className).toContain('w-[208px]')
    // 另外三组仍是 104，别跟着一起变宽
    expect(screen.getByLabelText('全部涨跌').className).toContain('w-[104px]')
    expect(screen.getByLabelText('全部状态').className).toContain('w-[104px]')
    expect(screen.getByLabelText('全部市值').className).toContain('w-[104px]')
  })

  it('市场下拉里「全部市场」就是不限（board=all），触发器也显示这个文案', () => {
    renderBar({ board: 'all' })
    expect(screen.getByLabelText('全部市场').textContent).toContain('全部市场 (5574)')
  })

  it('市场下拉的触发器显示当前板块（带计数）', () => {
    renderBar({ board: 'cyb' })
    expect(screen.getByLabelText('全部市场').textContent).toContain('创业 (1369)')
  })

  it('点市场下拉的某一项走 onBoardChange（单选）', async () => {
    const user = userEvent.setup()
    const { onBoardChange } = renderBar()
    await openSelect(user, '全部市场')
    const options = await screen.findAllByRole('option')
    await user.click(options[4])
    expect(onBoardChange).toHaveBeenCalledWith('kcb')
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

  it('四组都是下拉，一个 pill 都不剩', () => {
    renderBar()
    expect(document.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
    expect(document.querySelectorAll('[role="combobox"]')).toHaveLength(2)
    expect(document.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(2)
  })

  it('「清空筛选」紧跟在下拉菜单后面（DOM 里就是筛选行的最后一个元素）', () => {
    renderBar({ board: 'cyb' })
    const bar = screen.getByLabelText('全部市场').parentElement as HTMLElement
    const clear = screen.getByRole('button', { name: '清空筛选' })
    expect(bar.lastElementChild).toBe(clear)
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
