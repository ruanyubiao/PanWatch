/**
 * 「深度分析2」技术面卡片：把**已落库的**技术面快照翻译成徽章 / 弹窗认识的结构。
 *
 * 为什么要这一层
 * ------------
 * 上游的 K 线弹窗（``KlineSummaryDialog``）吃的是 ``POST /api/klines/{symbol}/summary``
 * 的返回值，那条路要打外网、而且给的是**今天**的技术指标。深度分析2 的口径相反：
 * 技术面必须与报告一起保存，报告是 3 天前的就显示 3 天前那份。
 *
 * 所以这里不复用那条网络路径，只复用**算法**：
 *   - 打分：``buildKlineSuggestion``（fork 自己的 lib/kline-scorer，与徽章同源）
 *   - 库里的技术字符串 → 分数：``buildSummaryFromMarketRow`` 里那套
 *     「用 tech_score 反推 macd_hist」的做法（库里有 score 但没有 macd 柱体）
 *
 * 各项明细（+2 / -2 / -1 …）为什么在前端算
 * ---------------------------------------
 * 库里只落了 ``tech_score`` 与六条状态字符串，没有逐项分数。逐项分数的规则是固定
 * 的、可见的（i18n 的 ``kline.rules`` 就是这套规则），所以按同一套规律现算，
 * 算出来的总和必须等于库里的 ``tech_score`` —— 差值超出 ±1 就说明这一行不同源，
 * 此时**不硬凑**：只把能算出来的项列出来，并在注释里告警（与 market-row 一致）。
 */
import { buildKlineSuggestion, type KlineEvidenceItem, type KlineTranslate } from '@/lib/kline-scorer'
import { buildSummaryFromMarketRow, type MarketRow } from '@/lib/fork-kline-summary'
import type { KlineSummaryData } from '@panwatch/biz-ui/components/kline-summary-dialog'
import type { DsaTechnical } from '@/lib/dsa-api'

/** 未持仓口径：本页没有持仓上下文，动作按「未持有」那张表算（与徽章默认一致）。 */
export const TECHNICAL_HOLDING = false

/**
 * 存储块 → KlineSummaryData。
 *
 * 评分基准用 ``bar_close``（已收盘日线），不是现价：库里的 ``tech_score`` 就是用那根
 * 收盘算出来的，拿盘中现价重算会与库里的分数不一致。
 */
export function summaryFromTechnical(
  block: DsaTechnical | null | undefined,
  tr: KlineTranslate,
): KlineSummaryData | null {
  if (!block || !block.available) return null
  if (block.score == null && !block.trend) return null

  // 借道 market-row 的复原逻辑：它处理「库里没有 macd_hist」这一条，
  // 用 tech_score 与状态字符串算出的分数之差反推柱体正负（±1）。
  const pseudoRow = {
    code: block.code ?? '',
    trade_date: block.asof ?? null,
    close: block.bar_close ?? null,
    tech: {
      score: block.score ?? 0,
      trend: block.trend ?? null,
      macd: block.macd ?? null,
      rsi: block.rsi ?? null,
      kdj: block.kdj ?? null,
      boll: block.boll ?? null,
      volume: block.volume ?? null,
      support: block.support ?? null,
      resistance: block.resistance ?? null,
    },
    ma: {
      ma5: block.ma?.ma5 ?? null,
      ma10: block.ma?.ma10 ?? null,
      ma20: block.ma?.ma20 ?? null,
      ma60: block.ma?.ma60 ?? null,
    },
  } as unknown as MarketRow

  const base = buildSummaryFromMarketRow(pseudoRow, tr)
  if (!base) return null
  // 库里没有的 N 日涨跌幅用行情快照里算好的值补上（弹窗会渲染这两个 chip）
  return {
    ...(base as KlineSummaryData),
    change_5d: block.ret_5d ?? null,
    change_20d: block.ret_20d ?? null,
  }
}

export interface TechnicalSuggestion {
  action: string
  action_label: string
  score: number
  signal: string
  items: Array<{ text: string; delta: number; key: string }>
}

/**
 * 逐项明细（与 K 线弹窗同一套规则与文案）。
 *
 * 顺序即展示顺序：趋势 → MACD 金叉/死叉 → MACD 柱体 → RSI → KDJ → 布林 → 量能 →
 * 支撑压力。``delta === 0`` 的项保留在 ``items`` 里（弹窗也是全列），只是不进
 * ``signal`` 那一行摘要。
 */
export function buildTechnicalSuggestion(
  s: KlineSummaryData,
  tr: KlineTranslate,
  holding: boolean = TECHNICAL_HOLDING,
): TechnicalSuggestion {
  const scored = buildKlineSuggestion(s, holding, tr)
  const items: Array<{ text: string; delta: number; key: string }> = []
  const add = (key: string, delta: number, options?: Record<string, unknown>) =>
    items.push({ key, delta, text: tr(`items.${key}`, options) })

  if (s.trend?.includes('多头')) add('trendBull', 2)
  else if (s.trend?.includes('空头')) add('trendBear', -2)
  if (s.macd_status?.includes('金叉')) add('macdGolden', 2)
  if (s.macd_status?.includes('死叉')) add('macdDeath', -2)
  if (typeof s.macd_hist === 'number') {
    const statusKey = s.macd_hist > 0 ? 'positive' : s.macd_hist < 0 ? 'negative' : 'neutral'
    add('macdHist', s.macd_hist > 0 ? 1 : s.macd_hist < 0 ? -1 : 0, { status: tr(`statuses.${statusKey}`) })
  }
  if (s.rsi_status?.includes('超卖')) add('rsiOversold', 1)
  else if (s.rsi_status?.includes('偏强')) add('rsiStrong', 1)
  else if (s.rsi_status?.includes('超买')) add('rsiOverbought', -1)
  else if (s.rsi_status?.includes('偏弱')) add('rsiWeak', -1)
  if (s.kdj_status?.includes('金叉')) add('kdjGolden', 1)
  if (s.kdj_status?.includes('死叉')) add('kdjDeath', -1)
  if (s.boll_status?.includes('突破上轨')) add('bollUpper', 1)
  else if (s.boll_status?.includes('跌破下轨')) add('bollLower', -1)
  if (s.volume_trend?.includes('放量')) add('volumeUp', 1)
  else if (s.volume_trend?.includes('缩量')) add('volumeDown', -1)
  if (s.last_close != null && s.support != null && s.support > 0 && s.last_close <= s.support * 1.02) {
    add('nearSupport', 1)
  }
  if (s.last_close != null && s.resistance != null && s.resistance > 0 && s.last_close >= s.resistance * 0.98) {
    add('nearResistance', -1)
  }

  return {
    action: scored.action,
    action_label: tr(`actions.${scored.action}`),
    score: scored.score,
    signal: items
      .filter(item => item.delta !== 0)
      .slice(0, 4)
      .map(item => item.text)
      .join(' / '),
    items,
  }
}

/** 上游 ``KlineEvidenceItem`` 的透传（页面要显示「支撑 / 压力」两个 pill 时用）。 */
export type { KlineEvidenceItem }
