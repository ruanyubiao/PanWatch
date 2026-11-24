/**
 * 分析页「指标」列徽章的悬停提示 —— 原「来源」列那行文字挂在哪颗徽章上。
 *
 * 用户口径（2026-11-24）：「来源」列改成「模型预测」之后，那行来源文字不并排显示，
 * 而是放进悬停提示：技术面那行（「技术指标 · 11-23」）挂技术面徽章，
 * AI 那行（「AI深度 · 16:39（已过期）」）挂 AI 徽章，**原提示接在这段文字后面**。
 *
 * tooltip 的内容在截图里看不出来，所以这里直接断言 title 属性。
 * 技术面徽章只在传了 onOpenKline 时才是 <button>，所以按 title 取，不按 role 取。
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { KlineSummary, SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'
import { IndicatorBadges } from '@/components/fork/IndicatorBadges'

afterEach(cleanup)

/** buildKlineSuggestion 只用到 ``actions.*``，其余键原样回显。 */
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

function allTitles(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[title]')).map(n => n.getAttribute('title') || '')
}

describe('fork: 指标列徽章的悬停提示带着原「来源」那行文字', () => {
  it('有 AI 建议：来源那行挂在 AI 徽章上，原提示接在后面', () => {
    const { container } = render(
      <IndicatorBadges
        suggestion={suggestion}
        kline={bearishKline}
        klineTr={klineTr}
        aiHint="AI深度 · 16:39（已过期）"
        onOpenKline={() => {}}
      />,
    )
    const hinted = allTitles(container).filter(t => t.includes('AI深度 · 16:39（已过期）'))
    expect(hinted).toHaveLength(1)
    const lines = hinted[0].split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1].length).toBeGreaterThan(0)
  })

  it('没有 AI 建议：来源那行挂在技术面徽章上', () => {
    const { container } = render(
      <IndicatorBadges
        suggestion={null}
        kline={bearishKline}
        klineTr={klineTr}
        technicalHint="技术指标 · 11-23"
        onOpenKline={() => {}}
      />,
    )
    const hinted = allTitles(container).filter(t => t.startsWith('技术指标 · 11-23'))
    expect(hinted).toHaveLength(1)
    expect(hinted[0].split('\n')).toHaveLength(2)
  })

  it('两颗同时在：来源那行只在 AI 那颗上，技术面那颗保持原提示', () => {
    const { container } = render(
      <IndicatorBadges
        suggestion={suggestion}
        kline={bearishKline}
        klineTr={klineTr}
        aiHint="AI深度 · 16:39（已过期）"
        technicalHint={null}
        onOpenKline={() => {}}
      />,
    )
    const titles = allTitles(container)
    expect(titles.filter(t => t.includes('AI深度'))).toHaveLength(1)
    const techTitles = titles.filter(t => !t.includes('AI深度') && !t.includes('减仓'))
    for (const title of techTitles) {
      expect(title).not.toContain('\n')
    }
  })

  it('不传提示时 title 与上游一致（其他页面不受影响）', () => {
    const { container } = render(
      <IndicatorBadges suggestion={suggestion} kline={bearishKline} klineTr={klineTr} />,
    )
    for (const title of allTitles(container)) {
      expect(title).not.toContain('\n')
    }
  })

  it('技术面兜底建议（只有技术面、没有 AI）也把来源那行挂上', () => {
    const { container } = render(
      <IndicatorBadges
        suggestion={
          {
            ...suggestion,
            agent_name: 'technical_fallback',
            agent_label: '技术指标',
            action: 'avoid',
            action_label: '回避',
          } as unknown as SuggestionInfo
        }
        kline={bearishKline}
        klineTr={klineTr}
        technicalHint="技术指标 · 11-23"
        onOpenKline={() => {}}
      />,
    )
    const hinted = allTitles(container).filter(t => t.startsWith('技术指标 · 11-23'))
    expect(hinted).toHaveLength(1)
  })
})
