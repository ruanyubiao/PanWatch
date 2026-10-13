import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { STOCK_CARD_GRID_CLASS, STOCK_PAGE_SIZE } from '@/components/fork/stock-grid'
import { StockListToolbar } from '@/components/fork/StockListToolbar'
import type { BoardKey } from '@/lib/board-classify'

/**
 * fork 专用：A 股全市场浏览列表
 *
 * 数据来自 fork 新增的后端接口 GET /api/stocks/catalog（A 股非 ETF，分页）。
 * 上游没有这个能力——「关注」以外的股票在上游根本不会进前端，所以这一块
 * 必须是独立组件：不动上游 Stocks.tsx/Dashboard.tsx，merge 时才不会有冲突。
 *
 * 每页 100 只（用户要求的默认上限），页面内搜索，只给当前页拉行情。
 *
 * 卡片**不在这里渲染**：本组件只管取数/分页，具体卡片由 renderCard 交给
 * ForkAnalysis 用同一个 StockRichCard 渲染 —— 「关注」和「全部」的卡片
 * 因此长得一模一样（用户抱怨过两次，根因就是这里曾自己写了一套简化卡片）。
 *
 * 工具栏也是共用的（StockListToolbar）：搜索框在「关注」范围下同样存在，
 * 切换范围时 UI 不抖动。搜索词受控，由 ForkAnalysis 持有 —— 两个范围共享
 * 同一个搜索词，切换范围就是「换数据」，不是「换界面」。
 */

export interface CatalogItem {
  symbol: string
  name: string
  board: string
}

export interface CatalogCounts {
  all: number
  sh: number
  sz: number
  kcb: number
  cyb: number
  st: number
}

interface CatalogResponse {
  total: number
  offset: number
  limit: number
  counts: CatalogCounts
  items: CatalogItem[]
}

export interface QuoteRow {
  symbol: string
  current_price?: number | null
  change_pct?: number | null
  /** 后端 `_quote_to_response` 会带上 daily_quote_fields，用于价格悬停提示 */
  daily_move_status?: string
  quote_date?: string | null
}

/** 每行的状态与回调，交给 renderCard */
export interface CatalogRowState {
  quote?: QuoteRow
  /** 已在自选里 */
  followed: boolean
  /** 关注请求进行中 */
  busy: boolean
  onFollow: () => void
  onUnfollow: () => void
}

export type CatalogCardRenderer = (item: CatalogItem, state: CatalogRowState) => ReactNode

export function MarketStockList({
  board,
  query,
  onQueryChange,
  existingSymbols,
  onCounts,
  onAdd,
  onRemove,
  onPageItems,
  renderCard,
}: {
  board: BoardKey
  /** 受控搜索词（与「关注」范围共用） */
  query: string
  onQueryChange: (value: string) => void
  existingSymbols: Set<string>
  onCounts?: (counts: CatalogCounts) => void
  onAdd: (item: CatalogItem) => Promise<void> | void
  onRemove: (item: CatalogItem) => void
  /**
   * 当前页的股票列表。调用方据此批量预取 K 线摘要 —— 「全部」里的
   * 未关注股票也能显示技术面徽章（回避/买入等），因为技术面是按代码
   * 现算的，不需要自选记录。
   */
  onPageItems?: (items: CatalogItem[]) => void
  renderCard: CatalogCardRenderer
}) {
  const [debounced, setDebounced] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const countsRef = useRef(onCounts)
  countsRef.current = onCounts
  const pageItemsRef = useRef(onPageItems)
  pageItemsRef.current = onPageItems

  // 输入防抖，避免每敲一个字就打一次接口
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  // 换板块 / 换关键词时回到第一页
  useEffect(() => {
    setOffset(0)
  }, [board, debounced])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    fetchAPI<CatalogResponse>(
      `/stocks/catalog?board=${encodeURIComponent(board)}&q=${encodeURIComponent(debounced)}&offset=${offset}&limit=${STOCK_PAGE_SIZE}`,
      { signal: controller.signal },
    )
      .then(value => {
        if (controller.signal.aborted) return
        setData(value)
        countsRef.current?.(value.counts)
        pageItemsRef.current?.(value.items || [])
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [board, debounced, offset])

  // 只给当前页拉行情
  const pageSymbols = useMemo(() => (data?.items || []).map(item => item.symbol), [data])

  useEffect(() => {
    if (pageSymbols.length === 0) {
      setQuotes({})
      return
    }
    const controller = new AbortController()
    fetchAPI<QuoteRow[]>('/quotes/batch', {
      method: 'POST',
      body: JSON.stringify({ items: pageSymbols.map(symbol => ({ symbol, market: 'CN' })) }),
      signal: controller.signal,
    })
      .then(rows => {
        if (controller.signal.aborted) return
        const next: Record<string, QuoteRow> = {}
        for (const row of rows || []) next[row.symbol] = row
        setQuotes(next)
      })
      .catch(() => {
        if (!controller.signal.aborted) setQuotes({})
      })
    return () => controller.abort()
  }, [pageSymbols])

  const handleAdd = useCallback(
    async (item: CatalogItem) => {
      setAdding(item.symbol)
      try {
        await onAdd(item)
      } finally {
        setAdding(null)
      }
    },
    [onAdd],
  )

  const total = data?.total ?? 0
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + STOCK_PAGE_SIZE, total)
  const statusText = `共 ${total} 只${total > 0 ? `，当前 ${from}-${to}` : ''}`

  return (
    <div>
      <StockListToolbar
        value={query}
        onChange={onQueryChange}
        placeholder="搜索代码或名称"
        loading={loading}
        status={statusText}
      />

      {error ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">
          加载失败，请稍后重试
        </div>
      ) : total === 0 ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">
          {loading ? '加载中…' : debounced ? '没有匹配的股票' : '暂无数据'}
        </div>
      ) : (
        <div className={STOCK_CARD_GRID_CLASS}>
          {data?.items.map(item => (
            <Fragment key={item.symbol}>
              {renderCard(item, {
                quote: quotes[item.symbol],
                followed: existingSymbols.has(item.symbol),
                busy: adding === item.symbol,
                onFollow: () => void handleAdd(item),
                onUnfollow: () => onRemove(item),
              })}
            </Fragment>
          ))}
        </div>
      )}

      {total > STOCK_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-[11px]"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - STOCK_PAGE_SIZE))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-[11px]"
            disabled={to >= total || loading}
            onClick={() => setOffset(offset + STOCK_PAGE_SIZE)}
          >
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

export default MarketStockList
