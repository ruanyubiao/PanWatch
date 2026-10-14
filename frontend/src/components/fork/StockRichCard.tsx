import type { HTMLAttributes, ReactNode } from 'react'
import { BarChart3, Brain, ExternalLink, Loader2, Newspaper, Plus, X } from 'lucide-react'
import { Badge } from '@panwatch/base-ui/components/ui/badge'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { SuggestionBadge, type KlineSummary, type SuggestionInfo } from '@panwatch/biz-ui/components/suggestion-badge'
import { marketSignTextClass } from '@/lib/market-colors'

/**
 * fork：股票方块卡片（「关注」列表与「全部」列表共用同一份实现）
 *
 * 为什么要有这个文件：用户两次指出「关注」和「全部」的卡片长得不一样。
 * 根因是两边各写了一套 JSX（关注那套在 ForkAnalysis.tsx 里是内联的，
 * 全部那套在 MarketStockList.tsx 里自己写了一份简化版）。修法不是把内联那段
 * 再抄一遍，而是抽成这一个组件，两边都渲染它 —— 从此不可能不一致。
 *
 * 本文件属于 fork 自有文件（A 类），不修改上游任何文件。
 *
 * 两个列表的差异只有一处：卡片右下角的操作按钮 ——
 *   已关注 → X（取消关注）；未关注 → +（关注）。
 * 其余（AI 建议徽章行、Agent 行、指标/预警/资讯/深度分析/详情图标行）完全相同。
 *
 * 深度分析（TradingAgents）对未关注的股票同样可用：后端支持「无绑定」触发
 * （stock_id<=0 + symbol/market + allow_unbound=true，不落库、不写自选），
 * 所以这里不做任何「先关注才能分析」的限制。两者的唯一区别是未关注时前端传
 * stockId=0，让后端走无绑定通道。
 */

/** 卡片右上角价格区所需的行情字段（关注列表与全市场列表的行情结构略有差异，这里取交集） */
export interface StockRichCardQuote {
  current_price?: number | null
  change_pct?: number | null
  daily_move_status?: string
  quote_date?: string | null
}

/** 文案由调用方从 i18n 取好传进来，组件本身不依赖 i18n（便于单测） */
export interface StockRichCardTexts {
  etf: string
  notConfigured: string
  noAnalysis: string
  klineIndicator: string
  relatedNews: string
  deepAnalysis: string
  detail: string
  follow: string
  unfollow: string
  agentCount: (count: number) => string
}

export interface StockRichCardProps {
  symbol: string
  name: string
  market: string
  assetType?: 'stock' | 'etf'
  /** 市场角标（A / 港 / 美），由调用方按 market 计算 */
  badge: { label: string; style: string }
  /** 是否已关注：决定右下角是 X 还是 + */
  followed: boolean
  quote?: StockRichCardQuote | null
  /** 价格上悬停时的提示（行情状态/日期） */
  quoteTitle?: string
  /** 价格文本，由调用方格式化（股票 2 位、ETF 3 位） */
  priceText: string
  suggestion?: SuggestionInfo | null
  kline?: KlineSummary | null
  agentCount?: number
  runningAgentName?: string | null
  texts: StockRichCardTexts
  /** 整卡点击（打开 Agent 配置弹窗等）。传了才会出现 pointer 光标 */
  onCardClick?: () => void
  /** 点代码 / 名称 */
  onOpenSymbol?: () => void
  onOpenDetail: () => void
  onOpenKline: () => void
  onOpenNews: () => void
  /** 省略表示没有股票记录，按钮置灰 */
  onDeepAnalysis?: () => void
  /** 价格预警图标（上游组件，需要 stockId/缓存摘要），省略则不渲染该图标 */
  alertPanel?: ReactNode
  /** 未关注时的 + */
  onFollow?: () => void
  /** 已关注时的 X */
  onUnfollow?: () => void
  /** + 号请求中 */
  followBusy?: boolean
  /** 拖动中变淡等状态类 */
  className?: string
  /** 拖动 / 引导（tour）等透传到最外层 div 的属性；不要放 onClick / className */
  cardProps?: Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'className'>
  /** 引导流程用（GuidedTour 按 [data-tour-stock] 定位卡片） */
  dataTourStock?: number
}

export function StockRichCard({
  symbol,
  name,
  market,
  assetType,
  badge,
  followed,
  quote,
  quoteTitle,
  priceText,
  suggestion,
  kline,
  agentCount = 0,
  runningAgentName,
  texts,
  onCardClick,
  onOpenSymbol,
  onOpenDetail,
  onOpenKline,
  onOpenNews,
  onDeepAnalysis,
  alertPanel,
  onFollow,
  onUnfollow,
  followBusy,
  className,
  cardProps,
  dataTourStock,
}: StockRichCardProps) {
  const changeColor = marketSignTextClass(quote?.change_pct)
  const hasAnalysis = Boolean(suggestion || kline)

  return (
    <div
      data-fork-stock-card={symbol}
      data-tour-stock={dataTourStock}
      {...cardProps}
      onClick={onCardClick}
      className={`group rounded-xl border border-border/40 bg-background/30 hover:bg-accent/20 transition-colors p-3 ${
        onCardClick ? 'cursor-pointer' : ''
      } ${className || ''}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-[9px] px-1 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
            <button
              className="font-mono text-[12px] font-semibold text-foreground hover:text-primary"
              onClick={e => {
                e.stopPropagation()
                ;(onOpenSymbol || onOpenDetail)()
              }}
            >
              {symbol}
            </button>
            <button
              className="text-[12px] text-muted-foreground truncate hover:text-primary"
              onClick={e => {
                e.stopPropagation()
                ;(onOpenSymbol || onOpenDetail)()
              }}
            >
              {name}
              {assetType === 'etf' && <Badge variant="secondary" className="ml-1">{texts.etf}</Badge>}
            </button>
          </div>
        </div>
        <div className="text-right">
          <div title={quoteTitle} className={`font-mono text-[14px] font-bold leading-tight ${changeColor}`}>
            {priceText}
          </div>
          <div className={`font-mono text-[11px] leading-tight ${changeColor}`}>
            {quote?.change_pct != null ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%` : '--'}
          </div>
        </div>
      </div>

      <div className="mt-2">
        {hasAnalysis ? (
          <SuggestionBadge
            suggestion={suggestion ?? null}
            stockName={name}
            stockSymbol={symbol}
            kline={kline}
            market={market}
            hasPosition={false}
          />
        ) : (
          <div className="text-[11px] text-muted-foreground/70 py-2">{texts.noAnalysis}</div>
        )}
      </div>

      <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1 flex-wrap">
          {agentCount > 0 ? (
            <Badge variant="secondary" className="text-[10px]">{texts.agentCount(agentCount)}</Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground/60">{texts.notConfigured}</span>
          )}
          {runningAgentName && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
              {runningAgentName}
            </span>
          )}
        </div>
        <div
          className="flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100"
          onClick={e => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onOpenKline}
            title={texts.klineIndicator}
          >
            <BarChart3 className="w-3.5 h-3.5" />
          </Button>
          {alertPanel}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onOpenNews}
            title={texts.relatedNews}
          >
            <Newspaper className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hover:text-primary"
            title={texts.deepAnalysis}
            aria-label={texts.deepAnalysis}
            disabled={!onDeepAnalysis}
            onClick={() => onDeepAnalysis?.()}
          >
            <Brain className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onOpenDetail}
            title={texts.detail}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
          {followed ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:text-destructive"
              onClick={() => onUnfollow?.()}
              title={texts.unfollow}
              aria-label={texts.unfollow}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:text-primary"
              onClick={() => onFollow?.()}
              title={texts.follow}
              aria-label={texts.follow}
              disabled={followBusy}
            >
              {followBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

export default StockRichCard
