/**
 * fork 徽章副本与上游徽章的**行为一致性**（2026-11-25 用户要求：不许改原作者的文件）。
 *
 * 背景：分析页要在同一颗徽章上挂「来源那行」的悬停提示、并藏掉徽章自带的来源行。
 * 早先的做法是直接在上游 ``suggestion-badge.tsx`` 里加可选 prop，用户明确要求
 * 「复制一份、改副本、原作者的文件不要动」，于是那份改动搬到了
 * ``src/components/fork/ForkSuggestionBadge.tsx``。
 *
 * 复制带来的风险是**漂移**：上游修了 bug / 改了文案，副本没跟上，两个页面就会
 * 长得不一样。这个文件就是为了让这件事在 CI 里立刻暴露：
 *
 *   1. 同一组 props 分别渲染上游组件和副本，``innerHTML`` 必须逐字相同；
 *      上游一改、副本没跟，这里就红。（三个代表性场景：AI + 技术面、只有技术面、
 *      技术面兜底建议、完全没数据。）
 *   2. 副本独有的三个 prop（``hideSourceLine`` / ``hideTechnicalPrefix`` /
 *      ``titleHint``）各自的效果单独钉住 —— 不传时绝不改变任何输出。
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SuggestionBadge,
  type KlineSummary,
  type SuggestionInfo,
} from '@panwatch/biz-ui/components/suggestion-badge'
import { ForkSuggestionBadge } from '@/components/fork/ForkSuggestionBadge'

afterEach(cleanup)

const kline = { trend: '多头排列', rsi_status: '超买' } as KlineSummary

const aiSuggestion = {
  action: 'watch',
  action_label: '观望',
  attention_required: true,
  signal: '风险上升',
  reason: '波动加大',
  should_alert: true,
  agent_name: 'premarket_outlook',
  agent_label: '盘前分析',
  created_at: '2026-11-24T08:39:00.000Z',
} as SuggestionInfo

const technicalSuggestion = {
  ...aiSuggestion,
  agent_name: 'technical_fallback',
  agent_label: '技术指标',
  action: 'avoid',
  action_label: '回避',
} as SuggestionInfo

/** 两组组件的公共 props（副本与上游同名同义）。 */
interface SharedProps {
  suggestion: SuggestionInfo | null
  kline: KlineSummary | null
}

const SCENARIOS: Array<[string, SharedProps]> = [
  ['AI 建议 + 技术面（两颗徽章）', { suggestion: aiSuggestion, kline }],
  ['只有技术面（无 AI 建议）', { suggestion: null, kline }],
  ['技术面兜底建议', { suggestion: technicalSuggestion, kline }],
  ['完全没有数据', { suggestion: null, kline: null }],
  ['AI 建议 + 无技术面', { suggestion: aiSuggestion, kline: null }],
]

describe('fork 徽章副本：不传 fork 专属 prop 时，输出与上游逐字相同', () => {
  for (const [name, props] of SCENARIOS) {
    it(name, () => {
      const upstream = render(
        <SuggestionBadge
          suggestion={props.suggestion}
          kline={props.kline}
          stockName="测试股"
          stockSymbol="600519"
          hasPosition
        />,
      )
      const upstreamHtml = upstream.container.innerHTML
      cleanup()

      const fork = render(
        <ForkSuggestionBadge
          suggestion={props.suggestion}
          kline={props.kline}
          stockName="测试股"
          stockSymbol="600519"
          hasPosition
        />,
      )
      expect(fork.container.innerHTML).toBe(upstreamHtml)
    })
  }
})

describe('fork 徽章副本：三个专属 prop 的效果', () => {
  const titlesOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[title]')).map(n => n.getAttribute('title') || '')

  it('hideTechnicalPrefix：技术面徽章只剩结论，去掉「指标 · 」前缀', () => {
    const { container } = render(
      <ForkSuggestionBadge
        suggestion={aiSuggestion}
        kline={kline}
        hasPosition
        hideTechnicalPrefix
      />,
    )
    const labels = Array.from(container.querySelectorAll('button')).map(n => n.textContent || '')
    expect(labels.some(text => text.includes('指标 ·'))).toBe(false)
    expect(labels.some(text => text === '持有')).toBe(true)
  })

  it('hideSourceLine：徽章下方那行「来源：…」不再渲染', () => {
    const withLine = render(
      <ForkSuggestionBadge suggestion={aiSuggestion} kline={kline} hasPosition />,
    )
    expect(withLine.container.textContent).toContain('来源')
    cleanup()

    const withoutLine = render(
      <ForkSuggestionBadge suggestion={aiSuggestion} kline={kline} hasPosition hideSourceLine />,
    )
    expect(withoutLine.container.textContent).not.toContain('来源')
  })

  it('titleHint：接在原提示**前面**，原提示跟在后面', () => {
    const plain = render(<ForkSuggestionBadge suggestion={aiSuggestion} kline={kline} hasPosition />)
    const plainTitles = titlesOf(plain.container).filter(Boolean)
    cleanup()

    const hinted = render(
      <ForkSuggestionBadge
        suggestion={aiSuggestion}
        kline={kline}
        hasPosition
        titleHint="AI深度 · 16:39（已过期）"
      />,
    )
    const hintedTitles = titlesOf(hinted.container).filter(t => t.startsWith('AI深度'))
    // 上游把 title 挂在「AI 徽章」和「技术面徽章」两处（同一个 hint），这里逐个校验
    expect(hintedTitles.length).toBeGreaterThan(0)
    for (const title of hintedTitles) {
      const lines = title.split('\n')
      expect(lines).toHaveLength(2)
      // 第二行就是上游原本的那条提示
      expect(plainTitles.some(base => base === lines[1])).toBe(true)
    }
  })
})
