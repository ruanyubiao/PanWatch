import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenParamForm } from '@/components/fork/ScreenParamEditor'
import { CONDITION_DEFS_ZH, type ConditionName, type ConditionParamsMap } from '@/lib/screen-rule'

/**
 * 量价条件的参数表单（用户 2026-10-21 那批条件）。
 *
 * 这一层最容易出的问题是**提交的键和条件对不上**：后端 `extra="forbid"`，
 * 少一个 `window` 就是 400，多一个 `m` 也是 400。所以每个形状都断言
 * 「确定后交出的参数键集合」。
 */

afterEach(cleanup)

function renderForm(name: ConditionName, onConfirm = vi.fn()) {
  const def = CONDITION_DEFS_ZH[name]
  render(
    <ScreenParamForm
      name={name}
      value={def.defaults as ConditionParamsMap[ConditionName]}
      tradingDays={30}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  )
  return onConfirm
}

const field = (key: string) =>
  document.querySelector<HTMLInputElement>(`[data-screen-param-field="${key}"]`)!

const confirmButton = () => screen.getByRole('button', { name: '确定' })

describe('量价条件的参数表单', () => {
  it('单日 + 量比：N / 下限 / 上限 / 回看天数，确定后四个键齐全', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('vol_ratio_single')

    expect(field('n')).toBeTruthy()
    expect(field('min')).toBeTruthy()
    expect(field('max')).toBeTruthy()
    expect(field('window')).toBeTruthy()
    expect(field('window').value).toBe('5')

    await user.clear(field('min'))
    await user.type(field('min'), '1.5')
    await user.click(confirmButton())

    expect(onConfirm).toHaveBeenCalledTimes(1)
    const params = onConfirm.mock.calls[0][0] as Record<string, number>
    expect(Object.keys(params).sort()).toEqual(['max', 'min', 'n', 'window'])
    expect(params.min).toBe(1.5)
    expect(params.window).toBe(5)
  })

  it('区间形状：N / M / 下限 / 上限；非量比条件不带 window', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('turnover_all')

    expect(field('n').value).toBe('1')
    expect(field('m').value).toBe('5')
    expect(field('window')).toBeNull()

    await user.clear(field('m'))
    await user.type(field('m'), '10')
    await user.click(confirmButton())

    const params = onConfirm.mock.calls[0][0] as Record<string, number>
    expect(Object.keys(params).sort()).toEqual(['m', 'max', 'min', 'n'])
    expect(params.m).toBe(10)
  })

  it('连续形状：起点 / 连续天数 / 区间 / 回看天数', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('consecutive_shrinking')

    expect(field('start').value).toBe('1')
    expect(field('days').value).toBe('4')
    expect(field('max').value).toBe('1')
    expect(field('window')).toBeTruthy()

    await user.clear(field('days'))
    await user.type(field('days'), '6')
    await user.click(confirmButton())

    const params = onConfirm.mock.calls[0][0] as Record<string, number>
    expect(Object.keys(params).sort()).toEqual(['days', 'max', 'min', 'start', 'window'])
    expect(params.days).toBe(6)
  })

  it('创 M 日新高只有一个回看天数', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('new_high')

    expect(field('m').value).toBe('20')
    await user.clear(field('m'))
    await user.type(field('m'), '25')
    await user.click(confirmButton())

    expect(onConfirm.mock.calls[0][0]).toEqual({ m: 25, n: 1 })
  })

  it('均线金叉：两排周期按钮，默认 MA5 / MA10', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('ma_golden_cross')

    const fast5 = document.querySelector<HTMLButtonElement>('[data-fork-screen-cross-period="fast-5"]')!
    const slow10 = document.querySelector<HTMLButtonElement>('[data-fork-screen-cross-period="slow-10"]')!
    expect(fast5.getAttribute('aria-pressed')).toBe('true')
    expect(slow10.getAttribute('aria-pressed')).toBe('true')

    const fast10 = document.querySelector<HTMLButtonElement>('[data-fork-screen-cross-period="fast-10"]')!
    await user.click(fast10)
    // 快线 ≥ 慢线是明确错误，点确定不应提交
    await user.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.querySelector('[data-fork-screen-param-issue]')?.textContent).toContain(
      '快线周期必须小于慢线周期',
    )
  })

  it('股票代码或名称：文本框，空值拦住不给提交', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('stock_match')

    const input = document.querySelector<HTMLInputElement>('[data-fork-screen-param-field="text"]')!
    await user.type(input, '600519, 贵州茅台')
    await user.clear(input)
    await user.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()

    await user.type(input, '600519 贵州茅台')
    await user.click(confirmButton())
    expect(onConfirm.mock.calls[0][0]).toEqual({ text: '600519 贵州茅台' })
  })
})
