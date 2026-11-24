/**
 * 分析页「指标」列的两颗徽章：**技术面在前、AI 建议在后**（用户截图口径）。
 *
 * 为什么要钉顺序：技术面徽章只有买入 / 回避 / 观望三种**两字**文案，宽度固定；
 * AI 建议文案长短不一（持有 / 减仓 / 待复核）。固定宽度那颗放前面，行与行才对得齐。
 * 这条换序是在 fork 自己的组件里做的（组合），上游 ``SuggestionBadge`` 一行没改 ——
 * 所以这里同时钉住「上游那颗 AI 徽章确实被关掉了自带的伴生徽章」。
 */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { IndicatorBadges } from '@/components/fork/IndicatorBadges'
import type { KlineSummary, SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'

/** buildKlineSuggestion 只用到 ``actions.*``，其余键原样回显即可。 */
const klineTr = (key: string) =>
  ({
    'actions.buy': '买入',
    'actions.avoid': '回避',
    'actions.watch': '观望',
    'actions.reduce': '减仓',
  })[key] ?? key

const bearishKline = {
  trend: '空头排列',
  macd_status: '死叉',
  recent_5_up: 0,
  change_5d: -3.2,
  change_20d: -5.1,
  ma5: 10.2,
  ma10: 10.8,
  ma20: 11.4,
  support: 9.8,
  resistance: 11.9,
} as unknown as KlineSummary

const suggestion = {
  action: 'reduce',
  action_label: '减仓',
  signal: '放量下跌',
  reason: '跌破 MA20',
  should_alert: true,
  agent_name: 'intraday_monitor',
  agent_label: '盘中监测',
} as unknown as SuggestionInfo

describe('指标列徽章顺序', () => {
  it('技术面（固定两字）在前，AI 建议在后', () => {
    const { container } = render(
      <IndicatorBadges suggestion={suggestion} kline={bearishKline} klineTr={klineTr} />,
    )
    const row = container.querySelector('[data-fork-indicator-order="technical-first"] > div')
    expect(row).toBeTruthy()
    const text = row!.textContent || ''
    // 回避 = 技术面结论（空头 + 死叉 → score ≤ -2），必须排在「减仓」前面
    expect(text).toContain('回避')
    expect(text).toContain('减仓')
    expect(text.indexOf('回避')).toBeLessThan(text.indexOf('减仓'))
  })

  it('技术面徽章的文案永远两个字（买入 / 回避 / 观望），宽度固定', () => {
    const cases: Array<[KlineSummary, string]> = [
      [
        {
          ...bearishKline,
          trend: '多头排列',
          macd_status: '金叉',
          macd_hist: 0.5,
          rsi_status: '偏强',
          kdj_status: '金叉',
          volume_trend: '放量',
          recent_5_up: 5,
        } as unknown as KlineSummary,
        '买入',
      ],
      [bearishKline, '回避'],
      [{ ...bearishKline, trend: '均线交织', macd_status: '无', recent_5_up: 2 } as unknown as KlineSummary, '观望'],
    ]
    for (const [kline, expected] of cases) {
      const { container, unmount } = render(
        <IndicatorBadges suggestion={suggestion} kline={kline} klineTr={klineTr} />,
      )
      const row = container.querySelector('[data-fork-indicator-order="technical-first"] > div')!
      expect(row.textContent!.startsWith(expected), row.textContent || '').toBe(true)
      expect(expected.length).toBe(2)
      unmount()
    }
  })

  it('只有技术面数据（没有 AI 建议）时只画一颗，不进排序容器', () => {
    const { container } = render(<IndicatorBadges suggestion={null} kline={bearishKline} klineTr={klineTr} />)
    expect(container.textContent).toContain('回避')
    expect(container.querySelector('[data-fork-indicator-order]')).toBeNull()
  })

  it('技术面兜底建议本身不再额外配一颗技术面徽章（避免同一结论出现两次）', () => {
    const technical = {
      ...suggestion,
      agent_name: 'technical_fallback',
      agent_label: '技术指标',
      action: 'avoid',
      action_label: '回避',
    } as unknown as SuggestionInfo
    const { container } = render(
      <IndicatorBadges suggestion={technical} kline={bearishKline} klineTr={klineTr} />,
    )
    const matches = (container.textContent || '').match(/回避/g) || []
    expect(matches).toHaveLength(1)
  })
})
