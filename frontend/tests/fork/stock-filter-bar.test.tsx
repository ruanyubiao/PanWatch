import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StockFilterBar } from '@/components/fork/StockFilterBar'
import { EMPTY_MARKET_FILTERS, type MarketTableFilters } from '@/lib/market-filters'

/**
 * 分析页筛选行（2026-10-20 第四批反馈后的样子）。
 *
 * 钉住这几件事：
 *   1. 板块是**单选下拉**（选项顺序 = 全部 / 上证 / 深证 / **创业** / **科创** / ST，带计数），
 *      触发器宽度从 208 减到 **138**（第 3 条：减 70px）
 *   2. **指标**（原「状态」，第 4 条改名）与市值、状态都是**多选下拉**
 *   3. 新增的「全部状态」（交易日状态：正常 / 停牌 / ST …）排在「全部市值」**后面**（第 6 条）
 *   4. 「清空筛选」连**市场**一起复位，且位置**紧跟在下拉菜单后面**
 *   5. 元信息（数据时间/版本/提交）已经从这里搬走 —— 第 1 条把它挪到工具条第一行右侧
 *
 * 注：Radix 的下拉在 jsdom 里能开能点（tests/setup.ts 已补 PointerEvent / scrollIntoView 等），
 * 所以单选下拉这里也直接断言选项顺序与点击结果。
 */

const INDICATOR_OPTIONS = [
  { key: 'buy', label: '买入' },
  { key: 'avoid', label: '回避' },
  { key: 'watch', label: '观望' },
]

const COUNTS = { all: 5577, sh: 1632, sz: 1421, cyb: 1369, kcb: 605, st: 201 }

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
      indicatorOptions={INDICATOR_OPTIONS}
      {...over}
    />,
  )
  return { onBoardChange, onFiltersChange }
}

afterEach(() => cleanup())

const openSelect = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByLabelText(label))
}

/** 断言 onFiltersChange 收到的对象 —— 四组一起比对，缺字段会被发现。 */
const expectFilters = (fn: ReturnType<typeof vi.fn>, expected: Partial<MarketTableFilters>) => {
  expect(fn).toHaveBeenLastCalledWith({ ...EMPTY_MARKET_FILTERS, ...expected })
}

describe('fork: 分析页筛选行', () => {
  it('市场是单选下拉：选项 全部市场 / 上证 / 深证 / 创业 / 科创，各带计数（第 8 条去掉 ST）', async () => {
    const user = userEvent.setup()
    renderBar()
    await openSelect(user, '全部市场')
    const options = await screen.findAllByRole('option')
    expect(options.map(o => o.textContent)).toEqual([
      '全部市场 (5577)',
      '上证 (1632)',
      '深证 (1421)',
      '创业 (1369)',
      '科创 (605)',
    ])
  })

  it('市场触发器宽度减到 138px（208 − 70），其余几组仍是 104', () => {
    renderBar()
    expect(screen.getByLabelText('全部市场').className).toContain('w-[138px]')
    expect(screen.getByLabelText('全部涨跌').className).toContain('w-[104px]')
    expect(screen.getByLabelText('全部指标').className).toContain('w-[104px]')
    expect(screen.getByLabelText('全部市值').className).toContain('w-[104px]')
    expect(screen.getByLabelText('全部状态').className).toContain('w-[104px]')
  })

  it('市场下拉里「全部市场」就是不限（board=all），触发器也显示这个文案', () => {
    renderBar({ board: 'all' })
    expect(screen.getByLabelText('全部市场').textContent).toContain('全部市场 (5577)')
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

  it('指标（原「状态」）是多选下拉：勾一项 → indicator 里多一项；再点一次 → 取消', async () => {
    const user = userEvent.setup()
    const { onFiltersChange } = renderBar()
    await openSelect(user, '全部指标')
    await user.click(await screen.findByRole('option', { name: /买入/ }))
    expectFilters(onFiltersChange, { indicator: ['buy'] })

    cleanup()
    const second = renderBar({ filters: { ...EMPTY_MARKET_FILTERS, indicator: ['buy'] } })
    await openSelect(user, '全部指标')
    await user.click(await screen.findByRole('option', { name: /买入/ }))
    expectFilters(second.onFiltersChange, { indicator: [] })
  })

  it('指标下拉里「全部指标」这一行 = 清空该组', async () => {
    const user = userEvent.setup()
    const { onFiltersChange } = renderBar({
      filters: { ...EMPTY_MARKET_FILTERS, indicator: ['buy', 'avoid'] },
    })
    await openSelect(user, '全部指标')
    await user.click(await screen.findByRole('option', { name: '全部指标' }))
    expectFilters(onFiltersChange, { indicator: [] })
  })

  it('市值是多选：勾两档 = 并集（数组两个元素）', async () => {
    const user = userEvent.setup()
    const first = renderBar()
    await openSelect(user, '全部市值')
    await user.click(await screen.findByRole('option', { name: /^50亿/ }))
    expectFilters(first.onFiltersChange, { cap: ['lt50'] })

    cleanup()
    const second = renderBar({
      filters: { ...EMPTY_MARKET_FILTERS, cap: ['lt50'] } as MarketTableFilters,
    })
    await openSelect(user, '全部市值')
    await user.click(await screen.findByRole('option', { name: /^100亿/ }))
    expectFilters(second.onFiltersChange, { cap: ['lt50', 'lt100'] })
  })

  it('状态（交易日状态）是多选：勾「停牌」→ tradeStatus 里多一项', async () => {
    const user = userEvent.setup()
    const { onFiltersChange } = renderBar()
    await openSelect(user, '全部状态')
    await user.click(await screen.findByRole('option', { name: /停牌/ }))
    expectFilters(onFiltersChange, { tradeStatus: ['suspended'] })
  })

  it('状态下拉的选项：全部状态 / 正常 / 停牌 / ST / *ST / 退市 / 新股 / 其他', async () => {
    const user = userEvent.setup()
    renderBar()
    await openSelect(user, '全部状态')
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(8)
    expect(options[0].textContent).toBe('全部状态')
    expect(options.slice(1).map(o => o.textContent?.slice(0, 2))).toEqual([
      '正常',
      '停牌',
      'ST',
      '*S',
      '退市',
      '新股',
      '其他',
    ])
  })

  it('涨跌是单选下拉（选项里「全部涨跌」= 不限）', () => {
    renderBar()
    expect(screen.getByLabelText('全部涨跌')).toBeTruthy()
  })

  it('五组都是下拉，一个 pill 都不剩', () => {
    renderBar()
    expect(document.querySelectorAll('button[aria-pressed]')).toHaveLength(0)
    // 单选下拉：市场、涨跌
    expect(document.querySelectorAll('[role="combobox"]')).toHaveLength(2)
    // 多选下拉：指标、市值、状态
    expect(document.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(3)
  })

  it('「全部状态」排在「全部市值」后面（第 6 条）', () => {
    renderBar()
    const bar = screen.getByLabelText('全部市场').parentElement as HTMLElement
    const labels = Array.from(bar.querySelectorAll('[aria-label]')).map(node =>
      node.getAttribute('aria-label'),
    )
    const capIndex = labels.indexOf('全部市值')
    const statusIndex = labels.indexOf('全部状态')
    expect(capIndex).toBeGreaterThan(-1)
    expect(statusIndex).toBe(capIndex + 1)
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

  it('只有指标那组生效时也出现「清空筛选」', () => {
    renderBar({ filters: { ...EMPTY_MARKET_FILTERS, indicator: ['buy'] } })
    expect(screen.getByRole('button', { name: '清空筛选' })).toBeTruthy()
  })

  it('只有状态那组生效时也出现「清空筛选」', () => {
    renderBar({ filters: { ...EMPTY_MARKET_FILTERS, tradeStatus: ['suspended'] } })
    expect(screen.getByRole('button', { name: '清空筛选' })).toBeTruthy()
  })

  it('市值下拉的面板够宽，档位不被压成「1000…」', async () => {
    const user = userEvent.setup()
    renderBar()
    await user.click(screen.getByLabelText('全部市值'))
    const menu = await screen.findByRole('listbox')
    // 面板宽度由 menuClassName 给（默认 w-52 装不下「1000亿 + 总市值 500 亿 ~ 1000 亿」）
    expect(menu.className).toContain('w-[288px]')
    const options = await screen.findAllByRole('option')
    const cap = options.find(o => o.textContent?.includes('1000亿')) as HTMLElement
    // 档位那一格**不参与压缩**：要挤只能挤右边的区间说明
    const label = cap.querySelector('span.whitespace-nowrap') as HTMLElement
    expect(label.textContent).toBe('1000亿')
    expect(label.className).toContain('shrink-0')
    expect(label.className).not.toContain('truncate')
  })

  it('元信息不再挂在筛选行上（第 1 条已挪到工具条第一行右侧）', () => {
    renderBar()
    const bar = screen.getByLabelText('全部市场').parentElement as HTMLElement
    expect(bar.querySelectorAll('[data-fork-build-meta]')).toHaveLength(0)
  })
})
