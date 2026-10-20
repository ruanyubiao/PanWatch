import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '@panwatch/base-ui/components/ui/toast'
import { SaveConditionDialog } from '@/components/fork/SaveConditionDialog'
import { ScreenPresetMenu } from '@/components/fork/ScreenPresetMenu'
import { ScreenStocksDialog } from '@/components/fork/ScreenStocksDialog'
import { SCREEN_PRESET_TEXTS_ZH, presetNameError } from '@/lib/screen-presets'
import type { ScreenRequest } from '@/lib/screen-rule'

/**
 * 已保存条件（用户反馈 2026-10-20 第 1 / 2 / 5 条）。
 *
 * 钉住的是用户点得到的那几条：
 *   名字 = 文件名，所以 10 个字符上限、`/` 这类字符要**当场**拦住；
 *   保存弹窗的输入框自己限长，但列表和确认按钮也得跟着灰；
 *   一个条件都没有时，下拉与编辑**都不能操作**；
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
    expect(presetNameError('abcdefghijk')).toBe(SCREEN_PRESET_TEXTS_ZH.nameTooLong)
    expect(presetNameError('低市值四连阳条件啊呀好')).toBe(SCREEN_PRESET_TEXTS_ZH.nameTooLong)
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

  it('N3 输入框自己限长 10，字数提示跟着走', async () => {
    renderSave()
    expect(nameInput().maxLength).toBe(10)
    expect(screen.getByText('0/10')).toBeTruthy()

    await userEvent.type(nameInput(), '四连阳')
    expect(screen.getByText('3/10')).toBeTruthy()
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

describe('已保存条件下拉 + 编辑', () => {
  it('N7 一个条件都没有时，下拉与编辑都不能操作', () => {
    render(<ScreenPresetMenu presets={[]} value={null} onChange={vi.fn()} onEdit={vi.fn()} />)

    const trigger = document.querySelector('[data-fork-preset-select]') as HTMLButtonElement
    const edit = screen.getByRole('button', { name: /编辑/ }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(edit.disabled).toBe(true)
    expect(screen.getByText(SCREEN_PRESET_TEXTS_ZH.menuEmpty)).toBeTruthy()
  })

  it('N8 有已保存条件时能选、只有选中后才点得动编辑', async () => {
    const onChange = vi.fn()
    const onEdit = vi.fn()
    const presets = [preset('四连阳'), preset('低市值')]
    render(<ScreenPresetMenu presets={presets} value={null} onChange={onChange} onEdit={onEdit} />)

    const edit = screen.getByRole('button', { name: /编辑/ }) as HTMLButtonElement
    expect(edit.disabled).toBe(true) // 还没选

    await userEvent.click(document.querySelector('[data-fork-preset-select]') as HTMLElement)
    await userEvent.click(await screen.findByRole('option', { name: '四连阳' }))
    expect(onChange).toHaveBeenCalledWith('四连阳')

    cleanup()
    render(<ScreenPresetMenu presets={presets} value="四连阳" onChange={onChange} onEdit={onEdit} />)
    await userEvent.click(screen.getByRole('button', { name: /编辑/ }))
    expect(onEdit).toHaveBeenCalledWith('四连阳')
  })
})

describe('条件弹窗：已保存条件模式', () => {
  const renderDialog = (over: Partial<React.ComponentProps<typeof ScreenStocksDialog>> = {}) => {
    const onResult = vi.fn()
    render(
      <ToastProvider>
        <ScreenStocksDialog open onOpenChange={vi.fn()} onResult={onResult} asof="2026-10-20" {...over} />
      </ToastProvider>,
    )
    return { onResult }
  }

  it('N9 删除按钮一直在：没保存过时禁用；从已保存条件打开时可用，且排在「保存」前面', () => {
    renderDialog()
    // 第 5 条：删除按钮不再是「只有编辑模式才出现」，而是常在 + 禁用
    const disabled = document.querySelector('[data-fork-screen-delete-preset]') as HTMLButtonElement
    expect(disabled).toBeTruthy()
    expect(disabled.disabled).toBe(true)
    // 「取消」文字按钮已去掉（右上角有 X）
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    cleanup()

    const onDeletePreset = vi.fn()
    renderDialog({
      initialRequest: baseRequest(),
      presetName: '四连阳',
      onDeletePreset,
    })

    const remove = document.querySelector('[data-fork-screen-delete-preset]') as HTMLButtonElement
    const save = document.querySelector('[data-fork-screen-save-preset]') as HTMLButtonElement
    expect(remove).toBeTruthy()
    expect(remove.textContent).toContain('删除')
    expect(remove.disabled).toBe(false)
    // 已保存 → 保存按钮变成「覆盖保存」
    expect(save.textContent).toContain('覆盖保存')
    // 文档顺序：删除 → 保存
    expect(remove.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 顶部说明点名正在编辑哪个条件
    expect(screen.getByText(SCREEN_PRESET_TEXTS_ZH.editingPreset('四连阳'))).toBeTruthy()
  })

  it('N9b 弹窗「保存」交出去的是当前草稿：没名字 → name=null；已保存 → 覆盖原名', async () => {
    const onSavePreset = vi.fn()
    renderDialog({ onSavePreset })

    await userEvent.click(document.querySelector('[data-fork-screen-save-preset]') as HTMLElement)
    expect(onSavePreset).toHaveBeenCalledTimes(1)
    const [request, name] = onSavePreset.mock.calls[0]
    expect(name).toBeNull()
    // 整份请求都交出去了（窗口 / 市值 / 条件树），落到文件里才能原样回填
    expect(request).toMatchObject({
      trading_days: 30,
      markets: ['sh', 'sz', 'cyb', 'kcb'],
      market_cap: { min_yi: 1, max_yi: 100000 },
    })
    cleanup()

    const overlay = vi.fn()
    renderDialog({ initialRequest: baseRequest(), presetName: '四连阳', onSavePreset: overlay })
    await userEvent.click(document.querySelector('[data-fork-screen-save-preset]') as HTMLElement)
    expect(overlay.mock.calls[0][1]).toBe('四连阳')
    expect(overlay.mock.calls[0][0]).toMatchObject({ trading_days: 30, market_cap: { min_yi: 100 } })
  })

  it('N10 已保存条件的完整请求被回填（窗口 / 市值 / 条件树）', () => {
    renderDialog({ initialRequest: baseRequest(), presetName: '四连阳' })

    const days = document.querySelector<HTMLInputElement>('[data-screen-field="trading_days"]')!
    const capMin = document.querySelector<HTMLInputElement>('[data-screen-field="market_cap.min_yi"]')!
    expect(days.value).toBe('30')
    expect(capMin.value).toBe('100')
    expect(document.querySelector('[data-fork-screen-preview]')!.textContent).toContain('连续')
  })
})
