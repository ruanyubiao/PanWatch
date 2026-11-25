/**
 * fork 私有副本：``@panwatch/biz-ui/components/suggestion-badge``（上游）的冻结拷贝。
 *
 * 为什么要复制一份（用户 2026-11-25 的明确要求）
 * --------------------------------------------
 * 分析页要在同一颗徽章上挂「来源那行」的悬停提示、并且要藏掉徽章自带的那行来源，
 * 这两件事都只能改组件内部（``title`` 与来源行的渲染）。早先的做法是直接在上游文件
 * 里加三个可选 prop —— 虽然默认值保证上游行为不变，但那毕竟是**原作者的文件**，
 * fork 的规矩是「A 类只新增文件」，所以现在把那份改动整体搬到本副本里，
 * 上游 ``suggestion-badge.tsx`` 已还原成 ``upstream/main`` 的原样（零改动）。
 *
 * 与上游的差异**只有三处**，都是新增的可选 prop（不传 = 行为与上游逐字节相同）：
 *   - ``hideSourceLine``      藏掉 AI 徽章下方那行「来源：xxx · 时间」；
 *   - ``hideTechnicalPrefix`` 技术面徽章去掉「指标 · 」前缀（列标题已写「指标」）；
 *   - ``titleHint``           接在悬停提示**最前面**的一段文字，原提示接在后面。
 *
 * 不传这三个 prop 时，本组件与上游组件的渲染结果必须完全一致 ——
 * ``tests/fork/fork-suggestion-badge-sync.test.tsx`` 拿同一组 props 分别渲染两者、
 * 逐字比较 innerHTML 来钉住这一点（上游一改、本副本没跟上，那条测试会红）。
 *
 * 其余部分（弹窗、技术面弹窗、i18n 取词、过期判断）与上游**逐行相同**，
 * 只在下面两处不得不改：组件名 + ``./suggestion-action`` 的相对路径
 * （本文件不在 ``packages/biz-ui`` 里，得走包名导入）。
 */
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { KlineSummaryDialog } from '@panwatch/biz-ui/components/kline-summary-dialog'
import { KlineIndicators } from '@panwatch/biz-ui/components/kline-indicators'
import { buildKlineSuggestion } from '@/lib/kline-scorer'
import { AiSuggestionBadge } from '@panwatch/biz-ui/components/ai-suggestion-badge'
import { TechnicalBadge, technicalToneFromSuggestionAction } from '@panwatch/biz-ui/components/technical-badge'
import { useTranslation } from 'react-i18next'
import { suggestionPresentation, type SuggestionStateInput } from '@panwatch/biz-ui/components/suggestion-action'

export interface SuggestionInfo extends SuggestionStateInput {
  id?: number
  action: string  // buy/add/reduce/sell/hold/watch
  action_label: string
  signal: string
  reason: string
  should_alert: boolean
  raw?: string
  // 建议池新增字段
  agent_name?: string     // intraday_monitor/daily_report/premarket_outlook
  agent_label?: string    // 盘中监测/盘后日报/盘前分析
  created_at?: string     // ISO 时间戳
  is_expired?: boolean    // 是否已过期
  prompt_context?: string // Prompt 上下文
  ai_response?: string    // AI 原始响应
  meta?: Record<string, any>
}

export interface KlineSummary {
  // meta (from backend)
  timeframe?: string
  computed_at?: string
  asof?: string
  params?: Record<string, any>

  trend: string
  macd_status: string
  macd_cross?: string
  macd_cross_days?: number
  recent_5_up: number
  change_5d: number | null
  change_20d: number | null
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma60?: number | null
  // RSI
  rsi6?: number | null
  rsi_status?: string
  // KDJ
  kdj_k?: number | null
  kdj_d?: number | null
  kdj_j?: number | null
  kdj_status?: string
  // 布林带
  boll_upper?: number | null
  boll_mid?: number | null
  boll_lower?: number | null
  boll_status?: string
  // 量能
  volume_ratio?: number | null
  volume_trend?: string
  // 振幅
  amplitude?: number | null
  // 多级支撑压力
  support: number | null
  resistance: number | null
  support_s?: number | null
  support_m?: number | null
  resistance_s?: number | null
  resistance_m?: number | null
  // K线形态
  kline_pattern?: string
}

interface ForkSuggestionBadgeProps {
  suggestion: SuggestionInfo | null
  stockName?: string
  stockSymbol?: string
  kline?: KlineSummary | null
  showFullInline?: boolean  // 是否在行内显示完整信息（Dashboard 模式）
  market?: string           // 市场（用于技术指标弹窗）
  hasPosition?: boolean     // 是否持仓（用于技术指标弹窗）
  showTechnicalCompanion?: boolean // 是否展示技术指标对照徽章
  /**
   * 是否隐藏徽章下方的「来源：xxx · 时间（已过期）」那一行。
   *
   * 默认 false = 与上游完全一致。fork 的分析页表格里，那行来源文字**挂在悬停提示**
   * 上（见 ``titleHint``），徽章再自带一行就是同一份信息出现两次，那里传 true。
   * 弹窗里的来源信息不受影响。
   */
  hideSourceLine?: boolean
  /**
   * 是否隐藏技术面徽章前面的「指标 · 」前缀。
   *
   * 默认 false = 保持上游行为不变（持仓 / 自选页仍然是「指标 · 买入」，
   * 那里没有列标题说明这颗徽章是什么）。fork 分析页的「指标」列里，
   * 列标题已经写了「指标」，前缀会让徽章读成「指标 · 买入」——
   * 用户反馈只要「买入」，那一处传 true。
   */
  hideTechnicalPrefix?: boolean
  /**
   * fork：接在徽章悬停提示**前面**的一段文字（默认 undefined = 与上游完全一致）。
   *
   * 分析页把原来的「来源」列改成「模型预测」之后，那行来源文字（例：
   * 「AI深度 · 16:39（已过期）」/「技术指标 · 11-23」）不再单独占一列，而是挂到
   * 对应徽章的 title 上，**原提示接在它后面**（用户口径）。
   */
  titleHint?: string
}

// 格式化建议时间（自动转换为本地时区，只显示时:分）
function formatSuggestionTime(isoTime?: string, locale = 'zh-CN'): string {
  if (!isoTime) return ''
  try {
    const date = new Date(isoTime)
    // 检查日期是否有效
    if (isNaN(date.getTime())) return ''
    // 使用本地时区显示
    return date.toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return ''
  }
}

// 格式化完整日期时间（本地时区）
function formatSuggestionDateTime(isoTime?: string, locale = 'zh-CN'): string {
  if (!isoTime) return ''
  try {
    const date = new Date(isoTime)
    if (isNaN(date.getTime())) return ''
    return date.toLocaleString(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
  } catch {
    return ''
  }
}

function formatKlineMeta(meta: Record<string, any> | undefined, locale: string, tr: (key: string, options?: Record<string, unknown>) => string): string {
  if (!meta) return ''
  const computedAt = meta?.kline_meta?.computed_at
  const asof = meta?.kline_meta?.asof
  const parts: string[] = []
  if (asof) parts.push(tr('klineAsOf', { value: asof }))
  if (computedAt) parts.push(tr('calculated', { value: formatSuggestionTime(computedAt, locale) }))
  return parts.join(' · ')
}

export function ForkSuggestionBadge({
  suggestion,
  stockName,
  stockSymbol,
  kline,
  showFullInline = false,
  market = 'CN',
  hasPosition = false,
  showTechnicalCompanion = true,
  hideSourceLine = false,
  hideTechnicalPrefix = false,
  titleHint,
}: ForkSuggestionBadgeProps) {
  const { t, i18n } = useTranslation('bizUi')
  const tr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(`suggestionBadge.${key}`, options)
  const klineTr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (key: string, options?: Record<string, unknown>) => string)(`kline.${key}`, options)
  const locale = (i18n.resolvedLanguage || i18n.language).toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN'
  const english = locale === 'en-US'
  const isTechnical = suggestion?.agent_name === 'technical_fallback' || suggestion?.agent_label === '技术指标'
  /** fork：``titleHint`` 在前、原提示在后（换行分隔）；不传时与上游完全一致。 */
  const titleWithHint = (base: string) => (titleHint ? `${titleHint}\n${base}` : base)
  const knownAgents = new Set(['intraday_monitor', 'daily_report', 'premarket_outlook', 'technical_fallback'])
  const localizedAgent = suggestion?.agent_name && knownAgents.has(suggestion.agent_name)
    ? tr(`agents.${suggestion.agent_name}`)
    : english
      ? suggestion?.agent_name || tr('unknown')
      : suggestion?.agent_label || suggestion?.agent_name || tr('unknown')
  const localizedAction = (action?: string, label?: string) => (t as unknown as (key: string) => string)(suggestionPresentation({ action, action_label: label }).labelKey)
  const technicalLabel = (tech: ReturnType<typeof buildKlineSuggestion> | null) => tech
    ? localizedAction(tech.action, tech.action_label)
    : tr('technicalPending')
  /** 技术面徽章文案：「指标 · 买入」或（hideTechnicalPrefix）只留「买入」。 */
  const technicalCompanionLabel = (tech: ReturnType<typeof buildKlineSuggestion> | null) =>
    hideTechnicalPrefix ? technicalLabel(tech) : `${tr('technicalShort')} · ${technicalLabel(tech)}`
  const [dialogOpen, setDialogOpen] = useState(false)
  const [klineDialogOpen, setKlineDialogOpen] = useState(false)
  const onDialogOpenChange = (open: boolean) => {
    setDialogOpen(open)
    if (!open) {
      try {
        ;(window as any).__panwatch_suppress_card_click_until = Date.now() + 600
      } catch {
        // ignore
      }
    }
  }

  if (!suggestion && !kline) return null

  // Dashboard 模式：行内显示完整信息（仅建议 badge）
  if (showFullInline) {
    if (!suggestion) return null
    const isAI = !!suggestion.agent_name && !isTechnical
    const tech = kline ? buildKlineSuggestion(kline as any, hasPosition, klineTr) : null
    const timeStr = formatSuggestionTime(suggestion.created_at, locale)
    const klineMetaStr = formatKlineMeta(suggestion.meta, locale, tr)
    return (
      <>
        <div className="pt-3 border-t border-border/30">
          <div className="flex items-start gap-3">
            <div className="shrink-0 flex items-center gap-2">
              <AiSuggestionBadge
                {...suggestion}
                action={suggestion.action}
                actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
                isAI={isAI}
                isExpired={!!suggestion.is_expired}
                size="lg"
                onClick={(e) => {
                  e.stopPropagation()
                  if (isTechnical) setKlineDialogOpen(true)
                  else setDialogOpen(true)
                }}
                title={tr('detailTitle')}
              />
              {isAI && showTechnicalCompanion && (
                <TechnicalBadge
                  label={technicalCompanionLabel(tech)}
                  tone={tech ? technicalToneFromSuggestionAction(tech.action, tech.action_label) : 'neutral'}
                  size="lg"
                  onClick={(e) => { e.stopPropagation(); setKlineDialogOpen(true) }}
                  title={titleWithHint(tr('technicalTitle'))}
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              {suggestion.signal && (
                <p className="text-[12px] font-medium text-foreground mb-0.5">{suggestion.signal}</p>
              )}
              {suggestion.reason ? (
                <p className="text-[11px] text-muted-foreground">{suggestion.reason}</p>
              ) : suggestion.raw && !suggestion.signal ? (
                <p className="text-[11px] text-muted-foreground">{suggestion.raw}</p>
              ) : null}

              {(suggestion.agent_label || timeStr) && (
                <div className="mt-1 text-[10px] text-muted-foreground/70">
                  {tr('source')}{localizedAgent || (isAI ? 'AI' : tr('unknown'))}
                  {timeStr && ` · ${timeStr}`}
                  {suggestion.is_expired && <span className="ml-1 text-amber-600">{tr('expired')}</span>}
                </div>
              )}

              {klineMetaStr && (
                <div className="mt-1 text-[10px] text-muted-foreground/70">
                  {klineMetaStr}
                </div>
              )}
            </div>
          </div>
        </div>

        <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
          <DialogContent
            className="max-w-md"
            onPointerDownOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
            onInteractOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
            onClick={(e) => e.stopPropagation()}
          >
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AiSuggestionBadge
                  {...suggestion}
                  action={suggestion.action}
                  actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
                  isAI={isAI}
                  isExpired={!!suggestion.is_expired}
                  size="lg"
                />
                {stockName && (
                  <span className="text-[14px] font-normal text-muted-foreground">
                    {stockName} {stockSymbol && `(${stockSymbol})`}
                  </span>
                )}
              </DialogTitle>
              {/* 来源信息 */}
              {(suggestion.agent_label || suggestion.created_at) && (
                <div className="text-[11px] text-muted-foreground/70 mt-1">
                  {tr('source')}{localizedAgent}
                  {suggestion.created_at && ` · ${formatSuggestionDateTime(suggestion.created_at, locale)}`}
                  {suggestion.is_expired && <span className="ml-2 text-amber-500">{tr('expired')}</span>}
                </div>
              )}
            </DialogHeader>

            <div className="space-y-4">

              {/* 信号 */}
              {suggestion.signal && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">{tr('signal')}</div>
                  <p className="text-[13px] font-medium text-foreground">{suggestion.signal}</p>
                </div>
              )}

              {/* 理由 */}
              {(suggestion.reason || suggestion.raw) && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">{tr('reason')}</div>
                  <p className="text-[13px] text-foreground">
                    {suggestion.reason || suggestion.raw}
                  </p>
                </div>
              )}

              {/* 技术指标 */}
              {kline && (
                <div className="space-y-3">
                  <div className="text-[11px] text-muted-foreground">{tr('technical')}</div>
                  <KlineIndicators summary={kline as any} />
                </div>
              )}

              {/* AI 原始响应 */}
              {suggestion.ai_response && (
                <div>
                  <div className="text-[11px] text-muted-foreground mb-1">{tr('aiResponse')}</div>
                  <div className="text-[12px] text-foreground whitespace-pre-wrap bg-accent/30 rounded p-2 max-h-32 overflow-y-auto scrollbar">
                    {suggestion.ai_response}
                  </div>
                </div>
              )}

              {/* Prompt 上下文 */}
              {suggestion.prompt_context && (
                <details className="group">
                  <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                    {tr('promptContext')} <span className="text-[10px]">{tr('expand')}</span>
                  </summary>
                  <div className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap bg-accent/20 rounded p-2 max-h-48 overflow-y-auto scrollbar">
                    {suggestion.prompt_context}
                  </div>
                </details>
              )}
            </div>
          </DialogContent>
        </Dialog>
        <KlineSummaryDialog
          open={klineDialogOpen}
          onOpenChange={setKlineDialogOpen}
          symbol={stockSymbol || ''}
          market={market}
          stockName={stockName}
          hasPosition={hasPosition}
          initialSummary={kline as any}
        />
      </>
    )
  }

  // 仅展示技术指标（无建议）
  if (!suggestion && kline) {
    const tech = buildKlineSuggestion(kline as any, hasPosition, klineTr)
    return (
      <>
        <div className="inline-flex flex-col items-start gap-0.5">
          <TechnicalBadge
            label={technicalLabel(tech)}
            tone={technicalToneFromSuggestionAction(tech.action, tech.action_label)}
            size="md"
            onClick={(e) => {
              e.stopPropagation()
              setKlineDialogOpen(true)
            }}
            title={titleWithHint(tr('technicalTitle'))}
          />
        </div>

        <KlineSummaryDialog
          open={klineDialogOpen}
          onOpenChange={setKlineDialogOpen}
          symbol={stockSymbol || ''}
          market={market || 'CN'}
          stockName={stockName}
          hasPosition={hasPosition}
          initialSummary={kline as any}
        />
      </>
    )
  }

  if (!suggestion) return null
  const isAI = !!suggestion.agent_name && !isTechnical

  // 持仓页模式：小徽章 + 点击弹窗
  const timeStr = formatSuggestionTime(suggestion.created_at, locale)
  const sourceInfo = ''

  return (
    <>
      <div className="inline-flex flex-col items-start gap-0.5">
        <div className="inline-flex items-center gap-1">
          <AiSuggestionBadge
            {...suggestion}
            action={suggestion.action}
            actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
            isAI={isAI}
            isExpired={!!suggestion.is_expired}
            size="md"
            onClick={(e) => {
              e.stopPropagation()
              if (isTechnical) setKlineDialogOpen(true)
              else setDialogOpen(true)
            }}
            title={titleWithHint(sourceInfo ? `${sourceInfo} - ${tr('detailTitle')}` : tr('detailTitle'))}
          />
          {showTechnicalCompanion && !isTechnical && (
            (() => {
              const tech = kline ? buildKlineSuggestion(kline as any, hasPosition, klineTr) : null
              return (
                <TechnicalBadge
                  label={technicalCompanionLabel(tech)}
                  tone={tech ? technicalToneFromSuggestionAction(tech.action, tech.action_label) : 'neutral'}
                  size="md"
                  onClick={(e) => { e.stopPropagation(); setKlineDialogOpen(true) }}
                  title={titleWithHint(tr('technicalTitle'))}
                />
              )
            })()
          )}
        </div>
        {/* 来源和时间（显示在徽章下方，仅 AI 建议以增强区分；开关见 hideSourceLine）*/}
        {isAI && !hideSourceLine && (
          <div className="mt-1 text-[10px] text-muted-foreground/70">
            {tr('source')}{localizedAgent || 'AI'}{timeStr && ` · ${timeStr}`}
            {suggestion.is_expired && <span className="ml-1 text-amber-600">{tr('expired')}</span>}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <DialogContent
          className="max-w-md"
          onPointerDownOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
          onInteractOutside={(e) => { e.preventDefault(); setDialogOpen(false) }}
          onClick={(e) => e.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AiSuggestionBadge
                {...suggestion}
                action={suggestion.action}
                actionLabel={localizedAction(suggestion.action, suggestion.action_label)}
                isAI={isAI}
                isExpired={!!suggestion.is_expired}
                size="md"
              />
              {stockName && (
                <span className="text-[14px] font-normal text-muted-foreground">
                  {stockName} {stockSymbol && `(${stockSymbol})`}
                </span>
              )}
            </DialogTitle>
            {/* 来源信息 */}
            {(suggestion.agent_label || suggestion.created_at) && (
              <div className="text-[11px] text-muted-foreground/70 mt-1">
                {tr('source')}{localizedAgent}
                {suggestion.created_at && ` · ${formatSuggestionDateTime(suggestion.created_at, locale)}`}
                {suggestion.is_expired && <span className="ml-2 text-amber-500">{tr('expired')}</span>}
              </div>
            )}
          </DialogHeader>

          <div className="space-y-4">

            {/* 信号 */}
            {suggestion.signal && (
              <div>
                <div className="text-[11px] text-muted-foreground mb-1">{tr('signal')}</div>
                <p className="text-[13px] font-medium text-foreground">{suggestion.signal}</p>
              </div>
            )}

            {/* 理由 */}
            {(suggestion.reason || suggestion.raw) && (
              <div>
                <div className="text-[11px] text-muted-foreground mb-1">{tr('reason')}</div>
                <p className="text-[13px] text-foreground">
                  {suggestion.reason || suggestion.raw}
                </p>
              </div>
            )}

            {/* 技术指标 */}
            {kline && (
              <div className="space-y-3">
                <div className="text-[11px] text-muted-foreground">{tr('technical')}</div>
                <KlineIndicators summary={kline as any} />
              </div>
            )}

            {/* AI 原始响应 */}
            {suggestion.ai_response && (
              <div>
                <div className="text-[11px] text-muted-foreground mb-1">{tr('aiResponse')}</div>
                <div className="text-[12px] text-foreground whitespace-pre-wrap bg-accent/30 rounded p-2 max-h-32 overflow-y-auto scrollbar">
                  {suggestion.ai_response}
                </div>
              </div>
            )}

            {/* Prompt 上下文 */}
            {suggestion.prompt_context && (
              <details className="group">
                <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">
                  {tr('promptContext')} <span className="text-[10px]">{tr('expand')}</span>
                </summary>
                <div className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap bg-accent/20 rounded p-2 max-h-48 overflow-y-auto scrollbar">
                  {suggestion.prompt_context}
                </div>
              </details>
            )}
          </div>
        </DialogContent>
      </Dialog>
      {/* Always mount K-line dialog for technical details */}
      <KlineSummaryDialog
        open={klineDialogOpen}
        onOpenChange={setKlineDialogOpen}
        symbol={stockSymbol || ''}
        market={market}
        stockName={stockName}
        hasPosition={hasPosition}
        initialSummary={kline as any}
      />
    </>
  )
}
