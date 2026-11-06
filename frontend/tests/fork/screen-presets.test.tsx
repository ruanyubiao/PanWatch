import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@panwatch/base-ui/components/ui/toast'
import { SaveConditionDialog } from '@/components/fork/SaveConditionDialog'
import { ScreenStocksDialog } from '@/components/fork/ScreenStocksDialog'
import { SCREEN_PRESET_TEXTS_ZH, presetNameError } from '@/lib/screen-presets'
import { SCREEN_TEXTS_ZH } from '@/lib/screen-rule'
import type { ScreenRequest } from '@/lib/screen-rule'

/**
 * 已保存条件（用户反馈 2026-10-20 第 1 / 2 / 5 条）。
 *
 * 钉住的是用户点得到的那几条：
 *   名字 = 文件名，所以 32 个字符上限、`/` 这类字符要**当场**拦住；
 *   保存弹窗的输入框自己限长，但列表和确认按钮也得跟着灰；
 *   一个条件都没有时，弹窗里的下拉**不能操作**；
 *   只有「从已保存条件进来」的弹窗才在「取消」前面多一个「删除」。
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

const baseRequest = (): ScreenRequest => ({
  trading_days: 30,
  markets: ['sh', 'sz', 'cyb', 'kcb'],
  include_st: false,
  market_cap: { min_yi: 100, max_yi: 200 },
  rule: {
    type: 'group',
    id: 'g-root',
    operator: 'AND',
    children: [
      {
        type: 'condition',
        id: 'c1',
        name: 'consecutive_bullish',
        params: { start: 1, days: 4 },
      },
    ],
  } as ScreenRequest['rule'],
})

const preset = (name: string, over: Partial<ScreenRequest> = {}) => ({
  name,
  saved_at: '2026-10-20T18:00:00+08:00',
  request: { ...baseRequest(), ...over },
})

beforeEach(() => {
  mocks.confirm.mockReset()
  mocks.confirm.mockResolvedValue(true)
  mocks.screen.mockReset()
})

afterEach(cleanup)

describe('保存条件：名字规则', () => {
  it('N1 十个字符以内可用，中文一个字算一个', () => {
    expect(presetNameError('四连阳')).toBeNull()
    expect(presetNameError('低市值四连阳啊')).toBeNull() // 8 个字符
    expect(presetNameError('abcdefghij')).toBeNull() // 正好 10
  })

  it('N2 空、超长、含文件名非法字符、以点开头结尾都被拒', () => {
    expect(presetNameError('   ')).toBe(SCREEN_PRESET_TEXTS_ZH.nameRequired)
    // 32 个字符上限：33 个超长，32 个刚好
    expect(presetNameError('a'.repeat(33))).toBe(SCREEN_PRESET_TEXTS_ZH.nameTooLong)
    expect(presetNameError('低'.repeat(33))).toBe(SCREEN_PRESET_TEXTS_ZH.nameTooLong)
    expect(presetNameError('a'.repeat(32))).toBe(null)
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a|b', 'a"b', 'a<b']) {
      expect(presetNameError(bad)).toBe(SCREEN_PRESET_TEXTS_ZH.nameForbidden)
    }
    expect(presetNameError('.hidden')).toBe(SCREEN_PRESET_TEXTS_ZH.nameDot)
    expect(presetNameError('name.')).toBe(SCREEN_PRESET_TEXTS_ZH.nameDot)
  })
})

describe('保存条件弹窗', () => {
  const renderSave = (over: Partial<React.ComponentProps<typeof SaveConditionDialog>> = {}) => {
    const onSave = vi.fn().mockResolvedValue(true)
    const onOpenChange = vi.fn()
    render(
      <ToastProvider>
        <SaveConditionDialog open onOpenChange={onOpenChange} onSave={onSave} {...over} />
      </ToastProvider>,
    )
    return { onSave, onOpenChange }
  }

  const nameInput = () =>
    document.querySelector<HTMLInputElement>('[data-fork-preset-name]') as HTMLInputElement
  const confirmButton = () => screen.getByRole('button', { name: '确定' }) as HTMLButtonElement

  it('N3 输入框自己限长 32（带两个评分也放得下），字数提示跟着走', async () => {
    renderSave()
    expect(nameInput().maxLength).toBe(32)
    expect(screen.getByText('0/32')).toBeTruthy()

    await userEvent.type(nameInput(), '四连阳')
    expect(screen.getByText('3/32')).toBeTruthy()
  })

  it('N4 非法字符当场报错，确认按钮灰掉', async () => {
    renderSave()
    await userEvent.type(nameInput(), 'a/b')
    expect(screen.getByText(SCREEN_PRESET_TEXTS_ZH.nameForbidden)).toBeTruthy()
    expect(confirmButton().disabled).toBe(true)

    await userEvent.clear(nameInput())
    await userEvent.type(nameInput(), '四连阳')
    expect(confirmButton().disabled).toBe(false)
  })

  it('N5 确认后把去掉两端空格的名字交给页面；页面说存好了才关窗', async () => {
    const { onSave, onOpenChange } = renderSave()
    await userEvent.type(nameInput(), '  四连阳  ')
    await userEvent.click(confirmButton())

    await waitFor(() => expect(onSave).toHaveBeenCalledWith('四连阳'))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('N6 页面返回 false（用户放弃覆盖）时留在弹窗里', async () => {
    const onSave = vi.fn().mockResolvedValue(false)
    const onOpenChange = vi.fn()
    render(
      <ToastProvider>
        <SaveConditionDialog open onOpenChange={onOpenChange} onSave={onSave} />
      </ToastProvider>,
    )
    await userEvent.type(nameInput(), '四连阳')
    await userEvent.click(confirmButton())

    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe('条件选股弹窗：标题下的「选股条件」下拉（2026-11-04 第 1 条）', () => {
  const renderPicker = (over: Partial<React.ComponentProps<typeof ScreenStocksDialog>> = {}) => {
    const props = {
      open: true,
      onOpenChange: vi.fn(),
      onResult: vi.fn(),
      asof: '2026-10-20',
      ...over,
    }
    const utils = render(
      <ToastProvider>
        <ScreenStocksDialog {...props} />
      </ToastProvider>,
    )
    /** 换 props 再渲染一次：模拟用户在页面下拉里切换 / 清空 */
    const rerenderWith = (next: Partial<React.ComponentProps<typeof ScreenStocksDialog>>) =>
      utils.rerender(
        <ToastProvider>
          <ScreenStocksDialog {...props} {...next} />
        </ToastProvider>,
      )
    return { rerenderWith }
  }

  it('N7 一个条件都没有时下拉禁用、提示「暂无已保存条件」、没有叉叉', () => {
    renderPicker()

    const trigger = document.querySelector('[data-fork-preset-select]') as HTMLButtonElement
    expect(trigger).toBeTruthy()
    expect(trigger.disabled).toBe(true)
    expect(screen.getByText(SCREEN_PRESET_TEXTS_ZH.menuEmpty)).toBeTruthy()
    expect(document.querySelector('[data-fork-preset-clear]')).toBeNull()
  })

  it('N8 下拉选中即编辑：内容进草稿，并把「正在改哪一条」交给父组件；叉叉清空', async () => {
    const onSelectPreset = vi.fn()
    renderPicker({ presets: [preset('四连阳'), preset('低市值')], onSelectPreset })

    const previewText = () => document.querySelector('[data-fork-screen-preview]')?.textContent || ''

    // 没选中 → 不显示叉叉
    expect(document.querySelector('[data-fork-preset-clear]')).toBeNull()

    await userEvent.click(document.querySelector('[data-fork-preset-select]') as HTMLElement)
    await userEvent.click(await screen.findByRole('option', { name: '四连阳' }))

    // 合并成一个 tab 后，「选中」就是「要改这一条」：内容进草稿，并通知页面
    expect(onSelectPreset).toHaveBeenLastCalledWith('四连阳')
    expect(previewText()).toContain('连续')

    const clear = document.querySelector('[data-fork-preset-clear]') as HTMLButtonElement
    expect(clear).toBeTruthy()
    // 叉叉挂在触发框那一块里，且没展开下拉就已经在文档中（hover 才显形）
    expect(clear.closest('[data-fork-screen-preset-picker]')).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.click(clear)
    // 点叉叉 = 回到新增条件：草稿清空、告诉页面不再关联任何条件
    expect(onSelectPreset).toHaveBeenLastCalledWith(null)
    expect(previewText()).not.toContain('连续')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('N8b 页面把名字回传（presetName 变化）不会把刚装好的草稿冲掉', () => {
    // 合并后选中条件 → 弹窗装内容 → 通知页面 → 页面把 presetName 传回来。
    // 如果 presetName 也被写进「重置草稿」那个 effect，回传一次草稿就没了。
    const { rerenderWith } = renderPicker({ presets: [preset('四连阳')] })
    const previewText = () => document.querySelector('[data-fork-screen-preview]')?.textContent || ''

    expect(previewText()).not.toContain('连续')

    rerenderWith({ presetName: '四连阳' })
    // 只是名字变了，草稿该保留（这里本来就是空的，关键是没有被换成 initialRequest 的默认值）
    expect(previewText()).not.toContain('连续')
    expect(document.querySelector('[data-fork-preset-clear]')).toBeTruthy()
  })
})

describe('条件弹窗：已保存条件模式', () => {
  /**
   * 2026-11-06 合并 tab 后：默认就停在「新建条件」，保存 / 删除都在这一页，
   * 所以这里的用例不再需要切 tab（参数留着只是为了旧用例读起来不变）。
   */
  const renderDialog = (
    over: Partial<React.ComponentProps<typeof ScreenStocksDialog>> = {},
    tab: 'build' | 'list' = 'build',
  ) => {
    const onResult = vi.fn()
    render(
      <ToastProvider>
        <ScreenStocksDialog open onOpenChange={vi.fn()} onResult={onResult} asof="2026-10-20" {...over} />
      </ToastProvider>,
    )
    if (tab === 'list') {
      // Radix 的 TabsTrigger 靠 mousedown 激活（click 不触发），这里必须用 mouseDown
      fireEvent.mouseDown(document.querySelector('[data-fork-screen-tab="list"]') as HTMLElement, {
        button: 0,
      })
    }
    return { onResult }
  }

  it('N9 删除按钮一直在：没保存过时禁用；从已保存条件打开时可用，且排在「保存」前面', () => {
    renderDialog({}, 'build')
    // 第 5 条：删除按钮不再是「只有编辑模式才出现」，而是常在 + 禁用
    const disabled = document.querySelector('[data-fork-screen-delete-preset]') as HTMLButtonElement
    expect(disabled).toBeTruthy()
    expect(disabled.disabled).toBe(true)
    // 「取消」文字按钮已去掉（右上角有 X）
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    cleanup()

    const onDeletePreset = vi.fn()
    renderDialog(
      {
        initialRequest: baseRequest(),
        presetName: '四连阳',
        onDeletePreset,
      },
      'build',
    )

    const remove = document.querySelector('[data-fork-screen-delete-preset]') as HTMLButtonElement
    const save = document.querySelector('[data-fork-screen-save-preset]') as HTMLButtonElement
    expect(remove).toBeTruthy()
    expect(remove.textContent).toContain('删除')
    expect(remove.disabled).toBe(false)
    // 已保存 → 文案仍是「保存」（覆盖行为不变，只是不再换词）
    expect(save.textContent?.trim()).toBe('保存')
    // 文档顺序：删除 → 保存
    expect(remove.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 顶部说明点名正在编辑哪个条件
    expect(screen.getByText(SCREEN_PRESET_TEXTS_ZH.editingPreset('四连阳'))).toBeTruthy()
  })

  it('N9b 弹窗「保存」交出去的是当前草稿：没保存过 → name=null；已保存 → 带上原名', async () => {
    const onSavePreset = vi.fn()
    renderDialog({ onSavePreset }, 'build')

    await userEvent.click(document.querySelector('[data-fork-screen-save-preset]') as HTMLElement)
    expect(onSavePreset).toHaveBeenCalledTimes(1)
    const [request, name] = onSavePreset.mock.calls[0]
    expect(name).toBeNull()
    // 整份请求都交出去了（窗口 / 市场 / 条件树）；市值已经是条件，不再有基础区间
    expect(request).toMatchObject({
      trading_days: 30,
      markets: ['sh', 'sz', 'cyb', 'kcb'],
    })
    expect(request.market_cap).toBeUndefined()
    cleanup()

    const overlay = vi.fn()
    renderDialog({ initialRequest: baseRequest(), presetName: '四连阳', onSavePreset: overlay }, 'build')
    await userEvent.click(document.querySelector('[data-fork-screen-save-preset]') as HTMLElement)
    // 已保存过的也照旧只交出「请求 + 原名」，由页面弹输入框（名字预填原名，可改名）
    expect(overlay.mock.calls[0][1]).toBe('四连阳')
    expect(overlay.mock.calls[0][0]).toMatchObject({ trading_days: 30 })
  })

  it('N10 已保存条件的完整请求被回填（窗口 / 市值条件 / 条件树）', () => {
    renderDialog({ initialRequest: baseRequest(), presetName: '四连阳' }, 'build')

    const days = document.querySelector<HTMLInputElement>('[data-screen-field="trading_days"]')!
    expect(days.value).toBe('30')
    // 老文件里的 market_cap {100, 200} 被翻译成两条市值条件
    const preview = document.querySelector('[data-fork-screen-preview]')!.textContent || ''
    expect(preview).toContain('连续')
    expect(preview).toContain('总市值 > 100 亿元')
    expect(preview).toContain('总市值 < 200 亿元')
  })
})

describe('提示与「选择条件」下拉（2026-11-06 合并 tab 后）', () => {
  const open = (over: Partial<React.ComponentProps<typeof ScreenStocksDialog>> = {}) => {
    render(
      <ToastProvider>
        <ScreenStocksDialog open onOpenChange={vi.fn()} onResult={vi.fn()} asof="2026-10-20" {...over} />
      </ToastProvider>,
    )
  }

  it('H1 顶部那条说明不再是可见文本：提示落在各自的 tab 里', () => {
    open()
    // 弹窗顶部（DialogDescription）只剩给屏幕阅读器的文本
    const content = document.querySelector('[data-fork-screen-dialog]') as HTMLElement
    const descId = content.getAttribute('aria-describedby')
    const desc = descId ? document.getElementById(descId) : null
    expect(desc).not.toBeNull()
    expect(desc!.className).toContain('sr-only')

    // 新建条件 tab 的提示讲的是「怎么建 / 怎么改」
    const buildHint = document.querySelector('[data-fork-screen-hint="build"]') as HTMLElement
    expect(buildHint).not.toBeNull()
    expect(buildHint.textContent).toContain(SCREEN_TEXTS_ZH.buildHint)
    // 「条件选股」那个 tab 已经合并掉了
    expect(document.querySelector('[data-fork-screen-hint="use"]')).toBeNull()
    cleanup()

    // 条件列表 tab 有自己的提示
    open()
    fireEvent.mouseDown(document.querySelector('[data-fork-screen-tab="list"]') as HTMLElement, {
      button: 0,
    })
    const listHint = document.querySelector('[data-fork-screen-hint="list"]') as HTMLElement
    expect(listHint).not.toBeNull()
    expect(listHint.textContent).toContain(SCREEN_TEXTS_ZH.listHint)
    expect(buildHint.isConnected).toBe(false)
  })

  it('H2 正在编辑某条已保存条件：只有新建条件的提示点名那一条', () => {
    open({ presets: [preset('四连阳')], presetName: '四连阳' })
    expect(
      document.querySelector('[data-fork-screen-hint="build"]')!.textContent,
    ).toContain(SCREEN_PRESET_TEXTS_ZH.editingPreset('四连阳'))
    // 列表 tab 不该被「正在编辑」污染
    fireEvent.mouseDown(document.querySelector('[data-fork-screen-tab="list"]') as HTMLElement, {
      button: 0,
    })
    expect(
      document.querySelector('[data-fork-screen-hint="list"]')!.textContent,
    ).not.toContain('正在编辑')
  })

  it('H3 下拉只有一份：选中即交给父组件', async () => {
    const onSelectPreset = vi.fn()
    open({ presets: [preset('四连阳'), preset('低市值')], onSelectPreset })

    const picker = document.querySelector('[data-fork-screen-preset-picker="build"]') as HTMLElement
    expect(picker).not.toBeNull()
    expect(picker.textContent).toContain(SCREEN_TEXTS_ZH.buildConditionTitle)
    // 合并后只剩一份（另一个 tab 是列表，没有下拉）
    expect(document.querySelectorAll('[data-fork-screen-preset-picker]')).toHaveLength(1)

    await userEvent.click(picker.querySelector('[data-fork-preset-select="build"]') as HTMLElement)
    await userEvent.click(await screen.findByRole('option', { name: '低市值' }))
    expect(onSelectPreset).toHaveBeenCalledWith('低市值')
  })
})
