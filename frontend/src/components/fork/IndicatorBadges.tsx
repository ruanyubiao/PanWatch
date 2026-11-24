/**
 * 分析页「指标」列里的两颗徽章：**技术面结论在前，AI 建议在后**。
 *
 * 为什么要换顺序（用户口径，带截图）：
 *   技术面徽章的文案只有三种（买入 / 回避 / 观望），**永远两个字**，宽度固定；
 *   AI 建议的文案长短不一（持有 / 减仓 / 待复核 …）。原来 AI 在前，第一颗宽度
 *   一变，右边那颗的起始位置就跟着跳，一列行与行之间参差不齐；把固定宽度的那颗
 *   放到前面，左边对齐、右边自然错落，整列才整齐。
 *
 * 为什么不直接改 ``SuggestionBadge``：那是上游 ``@panwatch/biz-ui`` 的组件，
 * 自选页 / 持仓页 / 弹窗都在用。fork 的规矩是**不动上游内部逻辑**，所以这里用
 * 组合的方式重排：技术面徽章由本文件自己画，AI 徽章让 ``SuggestionBadge``
 * 只画自己那颗（``showTechnicalCompanion={false}``），顺序就由外层决定。
 *
 * 技术面徽章的点击行为保持不变：打开 K 线摘要弹窗（由调用方传入 ``onOpenKline``，
 * 分析页用的是自己那份 ``openMarketKline``，与本页 K 线图标同一个弹窗）。
 */
import { useTranslation } from 'react-i18next'
import {
  SuggestionBadge,
  type KlineSummary,
  type SuggestionInfo,
} from '@panwatch/biz-ui/components/suggestion-badge'
import {
  TechnicalBadge,
  technicalToneFromSuggestionAction,
} from '@panwatch/biz-ui/components/technical-badge'
import { buildKlineSuggestion } from '@/lib/kline-scorer'

export interface IndicatorBadgesProps {
  suggestion: SuggestionInfo | null
  kline: KlineSummary | null
  stockName?: string
  stockSymbol?: string
  market?: string
  hasPosition?: boolean
  /** ``bizUi`` 命名空间下的 ``kline.*`` 取词函数（与表格筛选用的是同一个）。 */
  klineTr: (key: string, options?: Record<string, unknown>) => string
  /** 点技术面徽章：打开 K 线摘要弹窗。不传则不可点（与上游一致）。 */
  onOpenKline?: () => void
}

export function IndicatorBadges({
  suggestion,
  kline,
  stockName,
  stockSymbol,
  market = 'CN',
  hasPosition = false,
  klineTr,
  onOpenKline,
}: IndicatorBadgesProps) {
  const { t } = useTranslation('bizUi')
  const tr = (key: string) =>
    (t as unknown as (key: string) => string)(`suggestionBadge.${key}`)

  // 上游的判定：技术面兜底建议本身就是「技术面徽章」，不会再配一颗技术面徽章。
  // 那种情况（以及完全没有 AI 建议、只有技术面数据）只需要一颗，不存在排序问题。
  const isTechnical =
    suggestion?.agent_name === 'technical_fallback' || suggestion?.agent_label === '技术指标'
  if (!suggestion || isTechnical) {
    return (
      <SuggestionBadge
        suggestion={suggestion}
        stockName={stockName}
        stockSymbol={stockSymbol}
        kline={kline}
        market={market}
        hasPosition={hasPosition}
        hideSourceLine
        hideTechnicalPrefix
      />
    )
  }

  const tech = kline ? buildKlineSuggestion(kline as never, hasPosition, klineTr) : null
  const technicalLabel = tech ? klineTr(`actions.${tech.action}`) : tr('technicalPending')

  return (
    <div className="inline-flex flex-col items-start gap-0.5" data-fork-indicator-order="technical-first">
      <div className="inline-flex items-center gap-1">
        <TechnicalBadge
          label={technicalLabel}
          tone={tech ? technicalToneFromSuggestionAction(tech.action, tech.action_label) : 'neutral'}
          size="md"
          title={tr('technicalTitle')}
          onClick={
            onOpenKline
              ? event => {
                  event.stopPropagation()
                  onOpenKline()
                }
              : undefined
          }
        />
        <SuggestionBadge
          suggestion={suggestion}
          stockName={stockName}
          stockSymbol={stockSymbol}
          kline={kline}
          market={market}
          hasPosition={hasPosition}
          showTechnicalCompanion={false}
          hideSourceLine
          hideTechnicalPrefix
        />
      </div>
    </div>
  )
}
