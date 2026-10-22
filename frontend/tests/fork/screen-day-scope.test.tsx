import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenParamForm } from '@/components/fork/ScreenParamEditor'
import {
  CONDITION_DEFS_ZH,
  dayEnd,
  daySlot,
  type ConditionName,
  type ConditionParamsMap,
} from '@/lib/screen-rule'

/**
 * 按日定位（2026-10-23 第 3–6 条）：
 *
 * - 均线多头 / 空头排列、股价站上均线：倒数第 N 日 / 范围内每日 / 范围内任意一天；
 * - 金叉 / 死叉：倒数第 N 日 / 范围内任意一天；
 * - 阴阳线计数：D[n..m]，M 留空 = 整个统计窗口；
 * - 「所有条件都能指定倒数第 N 日，没指定 = 倒数第 1 日」（所以 n=1 时摘要不写）。
 */

afterEach(cleanup)

const def = <K extends ConditionName>(name: K) => CONDITION_DEFS_ZH[name]
const params = <K extends ConditionName>(name: K, patch: Record<string, unknown> = {}) =>
  ({ ...(def(name).defaults as object), ...patch }) as ConditionParamsMap[K]

describe('按日定位：摘要', () => {
  it('单日形态：n=1 不写、n>1 写出来', () => {
    expect(def('ma_bullish').summary(params('ma_bullish'))).toBe('均线多头排列(5/10/20/60)')
    expect(def('ma_bullish').summary(params('ma_bullish', { n: 3 }))).toBe('均线多头排列(5/10/20/60) · 倒数第3日')
    expect(def('ma_bearish').summary(params('ma_bearish', { n: 2 }))).toBe('均线空头排列(5/10/20/60) · 倒数第2日')
    expect(def('close_above_ma').summary(params('close_above_ma', { n: 5 }))).toBe('收盘价站上 MA5 · 倒数第5日')
    expect(def('market_cap').summary(params('market_cap', { n: 4 }))).toBe('总市值 ≥ 100 亿元 · 倒数第4日')
  })

  it('区间形态：写成「倒数第 M～N 日」（M 更早）', () => {
    expect(def('ma_bullish_all').summary(params('ma_bullish_all', { n: 1, m: 5 }))).toBe(
      '倒数第5～1日 每天均线多头排列(5/10/20/60)',
    )
    expect(def('ma_bullish_any').summary(params('ma_bullish_any', { n: 2, m: 6 }))).toBe(
      '倒数第6～2日 任意一天均线多头排列(5/10/20/60)',
    )
    expect(def('close_above_ma_all').summary(params('close_above_ma_all', { n: 1, m: 3 }))).toBe(
      '倒数第3～1日 每天收盘价站上 MA5',
    )
    expect(def('ma_golden_cross_any').summary(params('ma_golden_cross_any', { n: 1, m: 5 }))).toBe(
      '倒数第5～1日 任意一天均线金叉：MA5 / MA10',
    )
  })

  it('阴阳线计数：M=0 写「统计窗口内」，给了 M 就写区间', () => {
    expect(def('more_bullish_candles').summary(params('more_bullish_candles'))).toBe('阳线多于阴线（统计窗口内）')
    expect(def('more_bullish_candles').summary(params('more_bullish_candles', { n: 1, m: 3 }))).toBe(
      '倒数第3～1日 阳线多于阴线',
    )
    expect(def('more_bearish_candles').summary(params('more_bearish_candles', { n: 4, m: 6 }))).toBe(
      '倒数第6～4日 阴线多于阳线',
    )
  })
})

describe('按日定位：默认值与根数', () => {
  it('默认 n=1、m=1（区间变体 m=5），阴阳线 m=0', () => {
    expect(def('ma_bullish').defaults).toEqual({ periods: [5, 10, 20, 60], n: 1, m: 1 })
    expect(def('ma_bullish_all').defaults).toEqual({ periods: [5, 10, 20, 60], n: 1, m: 5 })
    expect(def('more_bullish_candles').defaults).toEqual({ n: 1, m: 0 })
    expect(def('market_cap').defaults).toEqual({ op: 'gte', value: 100, n: 1 })
  })

  it('预取根数随 N / M 增长（否则「倒数第 60 日」会算不出来）', () => {
    expect(def('ma_bullish').requiredBars(params('ma_bullish'))).toBe(60)
    expect(def('ma_bullish').requiredBars(params('ma_bullish', { n: 4 }))).toBe(3 + 60)
    expect(def('ma_bullish_all').requiredBars(params('ma_bullish_all', { n: 1, m: 5 }))).toBe(4 + 60)
    expect(def('close_above_ma').requiredBars(params('close_above_ma', { period: 20, n: 3 }))).toBe(2 + 20)
    expect(def('new_high').requiredBars(params('new_high', { m: 20, n: 2 }))).toBe(1 + 20 + 1)
    expect(def('ma_golden_cross_any').requiredBars(params('ma_golden_cross_any', { n: 1, m: 7 }))).toBe(6 + 10 + 1)
    expect(def('market_cap').requiredBars(params('market_cap', { n: 4 }))).toBe(4)
    // 阴阳线：M=0 时用不到额外根数（整个窗口本来就在取数范围内）
    expect(def('more_bullish_candles').requiredBars(params('more_bullish_candles'))).toBe(0)
    expect(def('more_bullish_candles').requiredBars(params('more_bullish_candles', { m: 12 }))).toBe(12)
  })

  it('daySlot / dayEnd 兜住老预设里缺失的 n / m', () => {
    expect(daySlot({})).toBe(1)
    expect(daySlot({ n: 7 })).toBe(7)
    expect(dayEnd({}, 30)).toBe(30)
    expect(dayEnd({ m: 0 }, 30)).toBe(30)
    expect(dayEnd({ m: 12 }, 30)).toBe(12)
  })
})

describe('按日定位：校验', () => {
  it('n 超窗口 / f < n 都报错', () => {
    expect(def('ma_bullish').validate(params('ma_bullish', { n: 0 }), 30)).toEqual(['倒数第几个交易日需为 1 至 30 的整数'])
    expect(def('ma_bullish_all').validate(params('ma_bullish_all', { n: 5, m: 3 }), 30)).toEqual([
      '终点 f 需为 5 至 30 的整数（f ≥ n）',
    ])
  })

  it('跨度上限 = 统计窗口；阴阳线的「整个窗口」也合法', () => {
    // 窗口 250：跨度 31 / 250 都合法（旧规则会报「跨度不能超过 30」）
    expect(def('ma_bullish_any').validate(params('ma_bullish_any', { n: 1, m: 31 }), 250)).toEqual([])
    expect(def('more_bullish_candles').validate(params('more_bullish_candles', { n: 1, m: 250 }), 250)).toEqual([])
    // 窗口 30：31 越界
    expect(def('ma_bullish_any').validate(params('ma_bullish_any', { n: 1, m: 31 }), 30)).toEqual([
      '终点 f 需为 1 至 30 的整数（f ≥ n）',
    ])
  })

  it('新增的按日变体都带 daySelector（表单据此渲染 N / M 输入框）', () => {
    const variants: ConditionName[] = [
      'ma_bullish',
      'ma_bullish_all',
      'ma_bullish_any',
      'ma_bearish',
      'ma_bearish_all',
      'ma_bearish_any',
      'close_above_ma',
      'close_above_ma_all',
      'close_above_ma_any',
      'ma_golden_cross',
      'ma_golden_cross_any',
      'ma_dead_cross',
      'ma_dead_cross_any',
      'more_bullish_candles',
      'more_bearish_candles',
      'new_high',
      'new_low',
      'market_cap',
    ]
    for (const name of variants) expect(def(name).daySelector).toBeTruthy()
    expect(def('ma_bullish').daySelector).toBe('single')
    expect(def('ma_bullish_all').daySelector).toBe('range')
    expect(def('more_bullish_candles').daySelector).toBe('range-window')
  })
})

describe('按日定位：参数表单', () => {
  function renderForm(name: ConditionName, onConfirm = vi.fn()) {
    render(
      <ScreenParamForm
        name={name}
        value={def(name).defaults as ConditionParamsMap[ConditionName]}
        tradingDays={30}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    )
    return onConfirm
  }

  const field = (key: string) =>
    document.querySelector<HTMLInputElement>(`[data-screen-param-field="${key}"]`)!

  it('均线多头排列：周期 + 倒数第 N 日，确定后 n 一起交出去', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('ma_bullish')

    expect(field('n').value).toBe('1')
    await user.clear(field('n'))
    await user.type(field('n'), '3')
    await user.click(screen.getByRole('button', { name: '确定' }))

    const sent = onConfirm.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ periods: [5, 10, 20, 60], n: 3, m: 1 })
  })

  it('范围内每日：N + M 两个框，M 的下限跟着 N 走', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('close_above_ma_all')

    expect(field('n').value).toBe('1')
    expect(field('m').value).toBe('5')
    await user.clear(field('n'))
    await user.type(field('n'), '2')
    await user.clear(field('m'))
    await user.type(field('m'), '7')
    await user.click(screen.getByRole('button', { name: '确定' }))

    const sent = onConfirm.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ period: 5, n: 2, m: 7 })
  })

  it('阴阳线计数：M 留空 = 整个统计窗口（m 提交 0）', async () => {
    const user = userEvent.setup()
    const onConfirm = renderForm('more_bullish_candles')

    // 默认留空
    expect(field('m').value).toBe('')
    expect(field('m').placeholder).toBe('30')
    await user.type(field('m'), '10')
    expect(field('m').value).toBe('10')
    await user.clear(field('m'))
    await user.click(screen.getByRole('button', { name: '确定' }))

    const sent = onConfirm.mock.calls[0][0] as Record<string, unknown>
    expect(sent).toEqual({ n: 1, m: 0 })
  })
})
