import { describe, expect, it } from 'vitest'
import { buildKlineSuggestion, type KlineTranslate } from '@/lib/kline-scorer'
import {
  buildSummaryFromMarketRow,
  marketRowScore,
  parseMacdStatus,
  type MarketRow,
} from '@/lib/fork-kline-summary'
import {
  exchangeLabel,
  formatAmount,
  formatChangePct,
  formatMarketCap,
  formatPrice,
  formatTurnoverRate,
  formatVolume,
} from '@/components/fork/StockMarketTable'
import { BOARD_OPTIONS } from '@/lib/board-classify'

/** 与上游徽章同源的 translator：key → 大白话，只为让断言可读。 */
const TR: KlineTranslate = key => {
  const map: Record<string, string> = {
    'items.trendBull': '多头',
    'items.trendBear': '空头',
    'items.trendMixed': '交织',
    'items.macdGolden': '金叉',
    'items.macdDeath': '死叉',
    'items.macdPositive': '柱正',
    'items.macdNegative': '柱负',
    'items.rsiOversold': '超卖',
    'items.rsiStrong': '偏强',
    'items.rsiOverbought': '超买',
    'items.rsiWeak': '偏弱',
    'items.rsiNeutral': '中性',
    'items.kdjGolden': 'KDJ金叉',
    'items.kdjDeath': 'KDJ死叉',
    'items.bollUpper': '突破上轨',
    'items.bollLower': '跌破下轨',
    'items.volumeUp': '放量',
    'items.volumeDown': '缩量',
    'items.nearSupport': '近支撑',
    'items.nearResistance': '近压力',
    'tags.bullish': '看多',
    'actions.buy': '买入',
    'actions.avoid': '回避',
    'actions.watch': '观望',
    'neutralSignal': '中性',
  }
  return map[key] ?? key
}

function row(over: Partial<MarketRow> = {}): MarketRow {
  return {
    code: '000001',
    symbol: 'sz000001',
    exchange: 'SZ',
    name: '平安银行',
    board: 'sz',
    trade_date: '2026-10-14',
    pre_close: 11.78,
    close: 11.59,
    high: 11.89,
    low: 11.58,
    change_pct: -1.61,
    volume: 58855939,
    amount: 15252457670,
    turnover_rate: 1.3814,
    total_market_cap: 224914591914.82,
    source: 'sina',
    ma: { ma5: 11.518, ma10: 11.4623, ma20: 11.4864, ma60: 11.1768 },
    tech: {
      score: 4,
      trend: '均线交织',
      macd: '金叉(1日)',
      rsi: '中性',
      kdj: '金叉',
      boll: '收口窄幅',
      volume: '平量',
      support: 11.27,
      resistance: 11.89,
    },
    ...over,
  }
}

describe('parseMacdStatus', () => {
  it('拆出金叉/死叉与交叉天数', () => {
    expect(parseMacdStatus('金叉(5日)')).toEqual({ status: '金叉(5日)', cross: '金叉', crossDays: 5 })
    expect(parseMacdStatus('死叉')).toEqual({ status: '死叉', cross: '死叉', crossDays: null })
    expect(parseMacdStatus(null)).toEqual({ status: null, cross: null, crossDays: null })
  })
})

describe('列格式化', () => {
  it('市场列只出 沪/深/北', () => {
    expect(exchangeLabel('SH')).toBe('沪')
    expect(exchangeLabel('SZ')).toBe('深')
    expect(exchangeLabel('BJ')).toBe('北')
    expect(exchangeLabel(null)).toBe('—')
  })

  it('价格/涨跌/市值', () => {
    expect(formatPrice(11.586)).toBe('11.59')
    expect(formatPrice(null)).toBe('--')
    expect(formatChangePct(1.239)).toBe('+1.24%')
    expect(formatChangePct(-1.239)).toBe('-1.24%')
    expect(formatMarketCap(224914591914.82)).toBe('2249.15亿')
    expect(formatMarketCap(3122668557542)).toBe('3.12万亿')
    expect(formatMarketCap(null)).toBe('--')
  })

  it('成交量 / 成交额 / 换手率（单位与库里一致：股 / 元 / 百分数）', () => {
    // 58,855,939 股 = 588,559.39 手 = 58.86 万手
    expect(formatVolume(58855939)).toBe('58.86万手')
    expect(formatVolume(356785575)).toBe('356.79万手')
    expect(formatVolume(12000)).toBe('120手')
    expect(formatVolume(0)).toBe('--')
    expect(formatVolume(null)).toBe('--')

    expect(formatAmount(15252457670)).toBe('152.52亿')
    expect(formatAmount(3560000)).toBe('356.00万')
    expect(formatAmount(8800)).toBe('8800')
    expect(formatAmount(0)).toBe('--')

    expect(formatTurnoverRate(1.3814)).toBe('1.38%')
    expect(formatTurnoverRate(0)).toBe('0.00%')
    expect(formatTurnoverRate(null)).toBe('--')
  })
})

describe('用库里的 tech_* 复原徽章分数', () => {
  /**
   * 库里没有 macd_hist 这一列，复原办法是令 macd_hist = tech_score − S0。
   * 这里拿两只真实样本钉住「复原后分数必须等于库里的 tech_score」。
   */
  it('复原后的分数与库里 tech_score 逐行相等（真实样本）', () => {
    // 000001 平安银行：交织/金叉/中性/KDJ金叉/收口窄幅/平量，S0=3，库里 4
    expect(marketRowScore(row(), TR)).toBe(4)
    // 000002 万科Ａ：多头/金叉(10日)/中性/KDJ金叉/开口放大/平量，S0=5，库里 6
    const wan = row({
      code: '000002',
      name: '万 科Ａ',
      close: 4.06,
      pre_close: 4.06,
      tech: {
        score: 6,
        trend: '多头排列',
        macd: '金叉(10日)',
        rsi: '中性',
        kdj: '金叉',
        boll: '开口放大',
        volume: '平量',
        support: 2.98,
        resistance: 4.4,
      },
    })
    expect(marketRowScore(wan, TR)).toBe(6)
  })

  it('macd_hist 的差值只可能是 −1/0/+1，且喂回去能复现库里的分数', () => {
    const base = row()
    // 先按「没有 macd_hist」算一次基线 S0
    const baseline = buildKlineSuggestion(
      buildSummaryFromMarketRow({ ...base, tech: { ...base.tech!, score: 0 } }, TR) as never,
      false,
      TR,
    )
    for (const delta of [-1, 0, 1]) {
      const item = row({ tech: { ...base.tech!, score: 0 } })
      // 用基线反推一个「与状态字符串同源」的库里分数
      const target = baseline.score + delta
      const summary = buildSummaryFromMarketRow(
        { ...item, tech: { ...item.tech!, score: target } },
        TR,
      )!
      expect((summary as { macd_hist?: number }).macd_hist).toBe(delta)
      expect(buildKlineSuggestion(summary as never, false, TR).score).toBe(target)
    }
  })

  it('tech 整组为空（新股/历史不足）→ 返回 null，不喂 0', () => {
    const fresh = row({ tech: null })
    expect(buildSummaryFromMarketRow(fresh, TR)).toBeNull()
    expect(marketRowScore(fresh, TR)).toBeNull()
  })

  it('未持仓口径：分数只按「未持仓」动作表映射（buy/avoid/watch）', () => {
    const summary = buildSummaryFromMarketRow(row(), TR)!
    const suggestion = buildKlineSuggestion(summary as never, false, TR)
    expect(suggestion.score).toBe(4)
    expect(suggestion.action).toBe('buy') // 未持仓 ≥3 → buy（不是持仓口径的 add）
  })

  it('库里分数与状态字符串差 2 时只告警、不硬塞（口径不同源）', () => {
    const broken = row({ tech: { ...row().tech!, score: 9 } })
    const summary = buildSummaryFromMarketRow(broken, TR)!
    expect((summary as { macd_hist?: number }).macd_hist).toBeUndefined()
  })
})

describe('板块 pill 的定义（去掉「关注」后仍是 4 个）', () => {
  it('顺序与 key：上证 / 深证 / 创业 / 科创（第 8 条去掉了 ST 这一项）', () => {
    const keys: string[] = BOARD_OPTIONS.map(option => String(option.key))
    expect(keys).toEqual(['sh', 'sz', 'cyb', 'kcb'])
    expect(BOARD_OPTIONS.map(option => option.label)).toEqual(['上证', '深证', '创业', '科创'])
  })
})
