import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@panwatch/base-ui/components/ui/toast'
import { ScreenStocksDialog } from '@/components/fork/ScreenStocksDialog'
import type { ScreenResponse } from '@/lib/screen-rule'

/**
 * 条件选股弹窗（需求规格 §12.5 D1–D6）。
 *
 * 钉住的都是「会真的坏掉、而且用户立刻能看出来」的行为：
 * 「全部」按钮的三态推导、校验失败时不能提交、删非空组要确认、第 5 层不能再嵌套、
 * 成功后关闭并回传结果 / 失败后**不关闭也不回传**、提交中点取消要真的 abort。
 *
 * `useConfirm` 与 `screenStocks` 都被替换成桩：这里测的是弹窗的编排，
 * 不是确认框或网络层。
 */

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  screen: vi.fn(),
}))

vi.mock('@panwatch/base-ui/components/ui/confirm-dialog', () => ({
  useConfirm: () => mocks.confirm,
}))
vi.mock('@/lib/screen-api', () => ({
  screenStocks: mocks.screen,
  createScreenAbort: vi.fn(),
}))

const response = (total: number): ScreenResponse => ({
  asof: '2026-10-16',
  total,
  items: [],
  window: { trading_days: 30, fetched_bars: 60, start_date: '2026-07-21' },
  stats: { candidates: 4800, evaluated: 4800, insufficient: 12, elapsed_ms: 2310 },
})

const renderDialog = (props: Partial<React.ComponentProps<typeof ScreenStocksDialog>> = {}) => {
  const onResult = vi.fn()
  const onOpenChange = vi.fn()
  render(
    <ToastProvider>
      <ScreenStocksDialog
        open
        onOpenChange={onOpenChange}
        onResult={onResult}
        asof="2026-10-16"
        {...props}
      />
    </ToastProvider>,
  )
  return { onResult, onOpenChange }
}

const marketButton = (name: string) => screen.getByRole('button', { name })
const submitButton = () => screen.getByRole('button', { name: /开始选股|选股中/ })
const daysInput = () =>
  document.querySelector<HTMLInputElement>('[data-screen-field="trading_days"]')!

/** 填统计窗口：弹窗打开时窗口是**空的**（用户要求不要默认选中值）。 */
const fillDays = async (value: string) => {
  await userEvent.clear(daysInput())
  await userEvent.type(daysInput(), value)
}

beforeEach(() => {
  mocks.confirm.mockReset()
  mocks.confirm.mockResolvedValue(true)
  mocks.screen.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('条件选股弹窗', () => {
  it('默认值：窗口留空、四个市场全选、不含 ST、空根组', () => {
    renderDialog()
    // 用户反馈：这个界面打开时不要有默认选中的窗口值（之前预填 30）
    expect(daysInput().value).toBe('')
    for (const name of ['上证', '深证', '创业', '科创']) {
      expect(marketButton(name).getAttribute('aria-pressed')).toBe('true')
    }
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('未添加技术条件：将仅按基础筛选选股')).toBeTruthy()
    expect(screen.getByText('（无技术条件，仅按基础筛选）')).toBeTruthy()
    // footer 显示数据截止日与预计读取根数（空树 → 0 根）
    expect(screen.getByText(/数据截至 2026-10-16/)).toBeTruthy()
  })

  it('D1 「全部」是三态推导出来的：全选 → 全不选 → mixed → 全选', async () => {
    renderDialog()

    // 全选状态下点「全部」→ 四个都取消
    await userEvent.click(marketButton('全部'))
    for (const name of ['上证', '深证', '创业', '科创']) {
      expect(marketButton(name).getAttribute('aria-pressed')).toBe('false')
    }
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('false')

    // 一个都没选 → 校验报错「至少选择一个市场」
    await userEvent.click(submitButton())
    expect(screen.getByText(/至少选择一个市场/)).toBeTruthy()
    expect(mocks.screen).not.toHaveBeenCalled()

    // 只选上证 → 「全部」变成 mixed
    await userEvent.click(marketButton('上证'))
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('mixed')

    // mixed 状态点「全部」→ 四个全选（不是「全不选」）
    await userEvent.click(marketButton('全部'))
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('true')
    for (const name of ['上证', '深证', '创业', '科创']) {
      expect(marketButton(name).getAttribute('aria-pressed')).toBe('true')
    }
  })

  it('D2 控件挡住非法窗口值；留空提交被拦并给出错误', async () => {
    renderDialog()
    const input = daysInput()

    // 0 / 999 都进不去：控件直接夹到 [1, 250]
    await fillDays('0')
    expect(input.value).toBe('1')
    await fillDays('999')
    expect(input.value).toBe('250')

    // 清空 → 提交被拦（窗口必填），错误条里点名
    await userEvent.clear(input)
    await userEvent.click(submitButton())
    const issues = document.querySelector('[data-fork-screen-issues]')!
    expect(issues.textContent).toContain('有 1 处需要修正')
    expect(issues.textContent).toContain('统计窗口需为 1–250 的整数')
    await waitFor(() => expect((submitButton() as HTMLButtonElement).disabled).toBe(true))
    expect(mocks.screen).not.toHaveBeenCalled()

    // 填回合法值 → 错误消失、按钮恢复
    await fillDays('30')
    await waitFor(() => expect(document.querySelector('[data-fork-screen-issues]')).toBeNull())
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('D3 删除非空条件组要先确认；取消后树不变', async () => {
    renderDialog()
    const condRows = () => document.querySelectorAll('[data-fork-screen-condition]')

    // 加一个子组，再往子组里塞一个无参数条件（直接插入，不弹参数表单）
    await userEvent.click(screen.getByRole('button', { name: '+ 条件组' }))
    const addConditionButtons = screen.getAllByRole('button', { name: '+ 条件' })
    await userEvent.click(addConditionButtons[addConditionButtons.length - 1])
    await userEvent.click(await screen.findByText('阳线多于阴线'))
    await waitFor(() => expect(condRows()).toHaveLength(1))
    expect(condRows()[0].textContent).toContain('阳线多于阴线（统计窗口内）')

    // 取消确认 → 子树还在
    mocks.confirm.mockResolvedValueOnce(false)
    await userEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    expect(mocks.confirm).toHaveBeenCalledTimes(1)
    expect(mocks.confirm.mock.calls[0][0]).toContain('1 个条件')
    expect(condRows()).toHaveLength(1)

    // 确认 → 子树连同条件一起消失
    mocks.confirm.mockResolvedValueOnce(true)
    await userEvent.click(screen.getAllByRole('button', { name: '删除' })[0])
    await waitFor(() => expect(condRows()).toHaveLength(0))
  })

  it('D4 第 5 层的「+ 条件组」被禁用', async () => {
    renderDialog()
    // 连点四次「最后一个 + 条件组」，得到 2、3、4、5 层
    for (let level = 2; level <= 5; level += 1) {
      const buttons = screen.getAllByRole('button', { name: '+ 条件组' })
      await userEvent.click(buttons[buttons.length - 1])
    }
    const buttons = screen.getAllByRole('button', { name: '+ 条件组' })
    expect(buttons).toHaveLength(5)
    expect((buttons[buttons.length - 1] as HTMLButtonElement).disabled).toBe(true)
    expect(buttons[buttons.length - 1].getAttribute('title')).toBe('最多嵌套 5 层')
    // 第 4 层仍然可以继续加组
    expect((buttons[buttons.length - 2] as HTMLButtonElement).disabled).toBe(false)
  })

  it('D5 成功：回传结果并关闭弹窗', async () => {
    mocks.screen.mockResolvedValue(response(37))
    const { onResult, onOpenChange } = renderDialog()

    await fillDays('30')
    await userEvent.click(submitButton())
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1))
    expect(onResult.mock.calls[0][0].total).toBe(37)
    // 回传的请求里 markets 只含具体市场，没有 'all'
    expect(onResult.mock.calls[0][1].markets).toEqual(['sh', 'sz', 'cyb', 'kcb'])
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // 关闭动作由页面控制；弹窗自己不再改表格
  })

  it('D5 失败：弹窗不关闭、显示错误、不回传结果', async () => {
    mocks.screen.mockRejectedValue(new Error('选股任务繁忙，请稍后重试'))
    const { onResult, onOpenChange } = renderDialog()

    await fillDays('30')
    await userEvent.click(submitButton())
    expect(await screen.findByText(/选股失败：选股任务繁忙，请稍后重试/)).toBeTruthy()
    expect(onResult).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    // 还能再点一次重试
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false)
  })

  it('D6 提交中点「取消」会 abort 请求', async () => {
    let signal: AbortSignal | undefined
    mocks.screen.mockImplementation((_req: unknown, provided?: AbortSignal) => {
      signal = provided
      return new Promise(() => {})
    })
    const { onOpenChange } = renderDialog()

    await fillDays('30')
    await userEvent.click(submitButton())
    await waitFor(() => expect(mocks.screen).toHaveBeenCalledTimes(1))
    expect(signal?.aborted).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(signal?.aborted).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('「修改条件」把上次的请求原样带回弹窗', () => {
    renderDialog({
      initialRequest: {
        trading_days: 45,
        markets: ['sh', 'kcb'],
        include_st: true,
        market_cap: { min_yi: 50, max_yi: 500 },
        rule: {
          type: 'group',
          id: 'g-root',
          operator: 'OR',
          children: [
            {
              type: 'condition',
              id: 'c1',
              name: 'consecutive_bullish',
              params: { days: 3 },
            },
          ],
        },
      },
    })

    expect(daysInput().value).toBe('45')
    expect(marketButton('上证').getAttribute('aria-pressed')).toBe('true')
    expect(marketButton('深证').getAttribute('aria-pressed')).toBe('false')
    expect(marketButton('科创').getAttribute('aria-pressed')).toBe('true')
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('mixed')
    expect(screen.getAllByText('连续 3 日阳线').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-fork-screen-preview]')?.textContent).toBe('连续 3 日阳线')
    const radios = screen.getAllByRole('radio')
    expect(within(radios[0].parentElement as HTMLElement).getAllByRole('radio')).toHaveLength(2)
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
  })

  it('L1 基础筛选三行：标题与控件同一行；ST 开关跟在市场后面', () => {
    renderDialog()

    // 统计窗口：标题与输入框在同一个 flex 行容器里
    const days = daysInput()
    const daysRow = days.parentElement as HTMLElement
    expect(daysRow.className).toContain('flex')
    expect(daysRow.textContent).toContain('统计窗口')

    // 总市值：标题与两个输入框同一行
    const capMin = document.querySelector<HTMLInputElement>('[data-screen-field="market_cap.min_yi"]')!
    const capRow = capMin.parentElement as HTMLElement
    expect(capRow.textContent).toContain('总市值（亿元）')

    // 市场 + ST：同一个行容器；「ST 股票」这个单独标题已删除
    const marketGroup = document.querySelector('[aria-label="市场"]')!
    const marketRow = marketGroup.parentElement as HTMLElement
    const stSwitch = document.querySelector<HTMLElement>('[data-screen-field="include_st"]')!
    expect(marketRow.contains(stSwitch)).toBe(true)
    expect(marketRow.textContent).toContain('包含 ST / *ST')
    expect(screen.queryByText('ST 股票')).toBeNull()
  })

  it('L2 连续阳线两个参数：倒数第几个交易日（默认 1）+ 天数（默认 4）', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: '+ 条件' }))
    await userEvent.click(await screen.findByText('连续 N 日阳线'))

    const start = document.querySelector<HTMLInputElement>('[data-screen-param-field="start"]')!
    const days = document.querySelector<HTMLInputElement>('[data-screen-param-field="days"]')!
    expect(start.value).toBe('1')
    expect(days.value).toBe('4')

    // 越界由控件自己夹回（不是填进去再弹红字）
    await userEvent.clear(start)
    await userEvent.type(start, '99')
    expect(start.value).toBe('30')
    await userEvent.clear(start)
    await userEvent.type(start, '5')

    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(document.querySelectorAll('[data-fork-screen-condition]')).toHaveLength(1),
    )
    // 起点 1 时才显示成「连续 N 日阳线」，否则点名起点
    expect(document.querySelector('[data-fork-screen-preview]')?.textContent).toBe(
      '自倒数第 5 日起连续 4 日阳线',
    )
  })
})
