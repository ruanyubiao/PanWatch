import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

/** 填统计窗口：打开时预填 30（默认值，但不聚焦），要换值先清空。 */
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
  it('默认值：窗口预填 30 但不抢焦点、四个市场全选、不含 ST、空根组', () => {
    renderDialog()
    // 窗口有默认值 30……
    expect(daysInput().value).toBe('30')
    // ……但打开时不聚焦它，否则带焦点描边看着像「已选中」
    expect(document.activeElement).not.toBe(daysInput())
    expect(daysInput().className).not.toContain('ring')
    // 焦点确实被接住了（落在弹窗容器上），不是「谁都没聚焦」的空过
    expect(document.activeElement).toBe(document.querySelector('[data-fork-screen-dialog]'))
    for (const name of ['上证', '深证', '创业', '科创']) {
      expect(marketButton(name).getAttribute('aria-pressed')).toBe('true')
    }
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('未添加技术条件：将仅按基础筛选选股')).toBeTruthy()
    expect(screen.getByText('（无技术条件，仅按基础筛选）')).toBeTruthy()
    // footer 显示数据截止日与预计读取根数（空树 → 0 根）
    expect(screen.getByText(/数据截至 2026-10-16/)).toBeTruthy()
  })

  it('D1 市场是「全部 / 其他」二选一的组：全选状态不能再点「全部」取消', async () => {
    renderDialog()

    // ① 全选状态下点「全部」→ 仍然是全选（不能取消）
    await userEvent.click(marketButton('全部'))
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('true')
    for (const name of ['上证', '深证', '创业', '科创']) {
      expect(marketButton(name).getAttribute('aria-pressed')).toBe('true')
    }

    // ② 全选状态下点「上证」→ 只剩上证（「全部」被取消选中）
    await userEvent.click(marketButton('上证'))
    expect(marketButton('上证').getAttribute('aria-pressed')).toBe('true')
    for (const name of ['深证', '创业', '科创']) {
      expect(marketButton(name).getAttribute('aria-pressed')).toBe('false')
    }
    expect(marketButton('全部').getAttribute('aria-pressed')).toBe('mixed')

    // ③ 最后一个市场不能取消：再点一次「上证」仍然选中（不会出现一个都没选）
    await userEvent.click(marketButton('上证'))
    expect(marketButton('上证').getAttribute('aria-pressed')).toBe('true')

    // ④ 点「全部」→ 四个全选
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

  it('D6 提交中关闭弹窗会 abort 请求（第 5 条去掉了「取消」文字按钮，走 Esc / X）', async () => {
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

    await userEvent.keyboard('{Escape}')
    expect(signal?.aborted).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('D6b 底部按钮是「删除 / 保存 / 开始选股」，没有「取消」文字按钮', () => {
    renderDialog({ onSavePreset: vi.fn() })
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    expect(document.querySelector('[data-fork-screen-submit]')!.textContent).toContain('开始选股')
    // 没保存过：删除禁用、保存按钮在
    const remove = document.querySelector('[data-fork-screen-delete-preset]') as HTMLButtonElement
    expect(remove).toBeTruthy()
    expect(remove.disabled).toBe(true)
    const save = document.querySelector('[data-fork-screen-save-preset]') as HTMLButtonElement
    expect(save.textContent).toContain('保存')
    expect(save.disabled).toBe(false)
    // 顺序：删除 → 保存 → 开始选股
    const submit = document.querySelector('[data-fork-screen-submit]') as HTMLElement
    expect(remove.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(save.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('D6c 从已保存条件打开时，保存按钮文案仍是「保存」而不是「覆盖保存」', () => {
    renderDialog({ presetName: '四连阳', onSavePreset: vi.fn(), onDeletePreset: vi.fn() })
    const save = document.querySelector('[data-fork-screen-save-preset]') as HTMLButtonElement
    expect(save.textContent?.trim()).toBe('保存')
    // 行为仍是覆盖：删除按钮此时可用
    const remove = document.querySelector('[data-fork-screen-delete-preset]') as HTMLButtonElement
    expect(remove.disabled).toBe(false)
  })

  it('「修改条件」把上次的请求原样带回弹窗', () => {
    renderDialog({
      initialRequest: {
        trading_days: 45,
        markets: ['sh', 'kcb'],
        include_st: true,
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
    expect(screen.getAllByText('倒数第3～1天连续3日阳线').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-fork-screen-preview]')?.textContent).toBe('倒数第3～1天连续3日阳线')
    const radios = screen.getAllByRole('radio')
    expect(within(radios[0].parentElement as HTMLElement).getAllByRole('radio')).toHaveLength(2)
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
  })

  it('L1 基础筛选：标题与控件同一行；窗口截止日带「启用」；ST 开关跟在市场后面', () => {
    renderDialog()

    // 统计窗口：标题与输入框在同一个 flex 行容器里
    // （输入框外面多套了一层 span —— 右侧的加减按钮定位用，所以往上找两层）
    const days = daysInput()
    const daysRow = days.parentElement!.parentElement as HTMLElement
    expect(daysRow.className).toContain('flex')
    expect(daysRow.textContent).toContain('统计窗口')

    // 窗口截止日：日期框 +「启用」复选框同一行；默认不启用（框禁用、不带日期）
    const asofInput = document.querySelector<HTMLInputElement>('[data-screen-field="asof"]')!
    const asofToggle = document.querySelector<HTMLInputElement>('[data-screen-field="asof_enabled"]')!
    expect(asofToggle.checked).toBe(false)
    expect(asofInput.disabled).toBe(true)
    expect(asofInput.value).toBe('')
    expect(asofInput.parentElement!.textContent).toContain('窗口截止日')
    expect(asofInput.parentElement!.contains(asofToggle)).toBe(true)

    // 总市值已经搬进条件列表：基础筛选里不该再有市值输入框
    expect(document.querySelector('[data-screen-field="market_cap.min_yi"]')).toBeNull()

    // 市场 + ST：同一个行容器；「ST 股票」这个单独标题已删除
    const marketGroup = document.querySelector('[aria-label="市场"]')!
    const marketRow = marketGroup.parentElement as HTMLElement
    const stSwitch = document.querySelector<HTMLElement>('[data-screen-field="include_st"]')!
    expect(marketRow.contains(stSwitch)).toBe(true)
    expect(marketRow.textContent).toContain('包含 ST / *ST')
    expect(screen.queryByText('ST 股票')).toBeNull()
  })

  it('L1b 勾上「启用」才提交日期：不勾时 asof 为 null，勾上后带日期', async () => {
    const onSavePreset = vi.fn()
    renderDialog({ initialRequest: null, onSavePreset })

    const toggle = document.querySelector<HTMLInputElement>('[data-screen-field="asof_enabled"]')!
    const input = document.querySelector<HTMLInputElement>('[data-screen-field="asof"]')!

    // 不勾：日期框禁用，草稿里的日期是空串
    expect(input.disabled).toBe(true)

    await userEvent.click(toggle)
    expect(input.disabled).toBe(false)
    // 勾上时预填一个可用起点（当前数据日期）
    expect(input.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // 日期框是分段输入，直接派发 change 比逐字符 type 稳
    fireEvent.change(input, { target: { value: '2026-09-30' } })
    expect(input.value).toBe('2026-09-30')

    // 取消勾选 → 日期清空、再次禁用
    await userEvent.click(toggle)
    expect(input.value).toBe('')
    expect(input.disabled).toBe(true)
  })

  it('L2 连续阳线两个参数：倒数第几个交易日（默认 1）+ 天数（默认 4）', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: '+ 条件' }))
    await userEvent.click(await screen.findByText('连续阳线（收盘 > 开盘）'))

    const start = document.querySelector<HTMLInputElement>('[data-screen-param-field="start"]')!
    const days = document.querySelector<HTMLInputElement>('[data-screen-param-field="days"]')!
    expect(start.value).toBe('1')
    expect(days.value).toBe('4')

    // 输入时就把「从倒数第几日、连续几日」念一遍
    const hint = () => document.querySelector('[data-fork-screen-consecutive-hint]')?.textContent
    expect(hint()).toBe('自倒数第 1 个交易日起连续 4 个交易日都收阳（收盘价 > 开盘价）')

    // 越界由控件自己夹回（不是填进去再弹红字）
    await userEvent.clear(start)
    await userEvent.type(start, '99')
    expect(start.value).toBe('30')
    await userEvent.clear(start)
    await userEvent.type(start, '5')
    expect(hint()).toBe('自倒数第 5 个交易日起连续 4 个交易日都收阳（收盘价 > 开盘价）')

    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(document.querySelectorAll('[data-fork-screen-condition]')).toHaveLength(1),
    )
    // 起点 5 + 连续 4 天 → 覆盖倒数第 8～5 天（用户第 4 条要求的写法）
    expect(document.querySelector('[data-fork-screen-preview]')?.textContent).toBe(
      '倒数第8～5天连续4日阳线',
    )
  })

  it('L7 连续上涨（涨幅 > 0）：两个参数，提示语说「收盘价 > 前收」', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: '+ 条件' }))
    await userEvent.click(await screen.findByText('连续上涨（涨幅 > 0）'))

    const start = document.querySelector<HTMLInputElement>('[data-screen-param-field="start"]')!
    const days = document.querySelector<HTMLInputElement>('[data-screen-param-field="days"]')!
    expect(start.value).toBe('1')
    expect(days.value).toBe('3')

    const hint = document.querySelector('[data-fork-screen-consecutive-hint]')?.textContent
    expect(hint).toBe('自倒数第 1 个交易日起连续 3 个交易日都上涨（收盘价 > 前收）')

    await userEvent.click(screen.getByRole('button', { name: '确定' }))
    await waitFor(() =>
      expect(document.querySelectorAll('[data-fork-screen-condition]')).toHaveLength(1),
    )
    expect(document.querySelector('[data-fork-screen-preview]')?.textContent).toBe('倒数第3～1天连续3日上涨')
  })

  it('L3 数字框右侧有加减按钮：点一次 ±1、到边界禁用、键盘 ↑/↓ 等价', async () => {
    renderDialog()
    const up = () => screen.getByRole('button', { name: '统计窗口 +1' }) as HTMLButtonElement
    const down = () => screen.getByRole('button', { name: '统计窗口 -1' }) as HTMLButtonElement
    const input = daysInput()

    // 默认 30 → +1 / -1
    await userEvent.click(up())
    expect(input.value).toBe('31')
    await userEvent.click(down())
    expect(input.value).toBe('30')

    // 清空后点 +1：先落到下限，不是从 0 或 NaN 起飞
    await userEvent.clear(input)
    await userEvent.click(up())
    expect(input.value).toBe('1')
    // 到边界按钮直接禁用（点了不会有反应，也不会越界）
    expect(down().disabled).toBe(true)
    expect(up().disabled).toBe(false)

    await fillDays('250')
    expect(up().disabled).toBe(true)
    expect(down().disabled).toBe(false)

    // 键盘等价物
    input.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(input.value).toBe('249')
    await userEvent.keyboard('{ArrowUp}')
    expect(input.value).toBe('250')
  })

  it('L4 条件参数的加减按钮：连续阳线起点 1 → 2，上限跟着窗口走', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: '+ 条件' }))
    await userEvent.click(await screen.findByText('连续阳线（收盘 > 开盘）'))

    const start = document.querySelector<HTMLInputElement>('[data-screen-param-field="start"]')!
    const up = screen.getByRole('button', { name: '倒数第几个交易日 +1' }) as HTMLButtonElement
    expect(start.value).toBe('1')
    await userEvent.click(up)
    expect(start.value).toBe('2')

    // 参数框里也有一个「上下箭头」，说明浮层没有因为按钮变宽而裁切
    const form = document.querySelector('[data-fork-screen-param="consecutive_bullish"]')!
    expect(form.querySelectorAll('[data-fork-screen-stepper]')).toHaveLength(2)
  })

  it('L5 弹窗宽 968px；「+ 条件 / + 条件组」只有一个加号', () => {
    renderDialog()
    expect(document.querySelector('[data-fork-screen-dialog]')!.className).toContain('max-w-[968px]')

    const addCondition = screen.getByRole('button', { name: '+ 条件' })
    // 文案自带「+」，图标已去掉：文本里只有一个加号，也没有 svg
    expect(addCondition.textContent).toBe('+ 条件')
    expect(addCondition.querySelector('svg')).toBeNull()
    const addGroup = screen.getByRole('button', { name: '+ 条件组' })
    expect(addGroup.textContent).toBe('+ 条件组')
    expect(addGroup.querySelector('svg')).toBeNull()
  })

  it('L6 条件列表：浮层加宽 + 滚轮真的能滚（自己 preventDefault 改 scrollTop）', async () => {
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: '+ 条件' }))
    await screen.findByText('均线多头排列')

    const panel = document.querySelector('[data-fork-screen-picker]') as HTMLElement
    // w-80（320px）下说明文字会折行；27rem = 432px
    expect(panel.className).toContain('w-[27rem]')

    const list = document.querySelector('[data-fork-screen-picker-list]') as HTMLElement
    // jsdom 没有布局：手工声明「内容 800 高、可视区 200 高」
    Object.defineProperty(list, 'scrollHeight', { value: 800, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true })

    // 模拟 Dialog 的滚动锁：document 上的冒泡监听（react-remove-scroll 就是在这一步
    // preventDefault 的，而我们的监听必须抢在它之前把事件吃掉）
    const blocker = vi.fn()
    document.addEventListener('wheel', blocker)
    try {
      const wheel = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })
      list.dispatchEvent(wheel)
      expect(list.scrollTop).toBe(120)
      expect(wheel.defaultPrevented).toBe(true)
      expect(blocker).not.toHaveBeenCalled()

      // 往上滚回顶部；不会滚成负数
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true, cancelable: true }))
      expect(list.scrollTop).toBe(0)
      // 滚到底部；不会越界
      list.dispatchEvent(new WheelEvent('wheel', { deltaY: 99999, bubbles: true, cancelable: true }))
      expect(list.scrollTop).toBe(600)
    } finally {
      document.removeEventListener('wheel', blocker)
    }
  })
})
