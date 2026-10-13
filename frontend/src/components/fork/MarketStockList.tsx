import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Loader2, Plus, Search, X } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { marketSignTextClass } from '@/lib/market-colors'
import type { BoardKey } from '@/lib/board-classify'

/**
 * fork 专用：A 股全市场浏览列表
 *
 * 数据来自 fork 新增的后端接口 GET /api/stocks/catalog（A 股非 ETF，分页）。
 * 上游没有这个能力——「关注」以外的股票在上游根本不会进前端，所以这一块
 * 必须是独立组件：不动上游 Stocks.tsx/Dashboard.tsx，merge 时才不会有冲突。
 *
 * 每页 100 只（用户要求的默认上限），页面内搜索，只给当前页拉行情。
 * 卡片形态刻意与「关注」列表一致（方块卡片 + 底部操作行）：已关注的在底部
 * 右端是 X（取消关注），未关注的是 +（关注）。
 */

const PAGE_SIZE = 100

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

interface QuoteRow {
  symbol: string
  current_price?: number | null
  change_pct?: number | null
}

export function MarketStockList({
  board,
  existingSymbols,
  onCounts,
  onAdd,
  onRemove,
}: {
  board: BoardKey
  existingSymbols: Set<string>
  onCounts?: (counts: CatalogCounts) => void
  onAdd: (item: CatalogItem) => Promise<void> | void
  onRemove: (item: CatalogItem) => void
}) {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const countsRef = useRef(onCounts)
  countsRef.current = onCounts

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
      `/stocks/catalog?board=${encodeURIComponent(board)}&q=${encodeURIComponent(debounced)}&offset=${offset}&limit=${PAGE_SIZE}`,
      { signal: controller.signal },
    )
      .then(value => {
        if (controller.signal.aborted) return
        setData(value)
        countsRef.current?.(value.counts)
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
  const to = Math.min(offset + PAGE_SIZE, total)

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索代码或名称"
            className="h-8 pl-9 text-[12px]"
          />
        </div>
        <span className="text-[11px] text-muted-foreground">
          {loading && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
          共 {total} 只{total > 0 ? `，当前 ${from}-${to}` : ''}
        </span>
      </div>

      {error ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">
          加载失败，请稍后重试
        </div>
      ) : total === 0 ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">
          {loading ? '加载中…' : debounced ? '没有匹配的股票' : '暂无数据'}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data?.items.map(item => {
            const quote = quotes[item.symbol]
            const changeClass = marketSignTextClass(quote?.change_pct)
            const added = existingSymbols.has(item.symbol)
            return (
              <div
                key={item.symbol}
                className="group rounded-xl border border-border/40 bg-background/30 hover:bg-accent/20 transition-colors p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/10 text-blue-600">A</span>
                      <span className="font-mono text-[12px] font-semibold text-foreground">{item.symbol}</span>
                      <span className="text-[12px] text-muted-foreground truncate">{item.name}</span>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono text-[14px] font-bold leading-tight ${changeClass}`}>
                      {quote?.current_price != null ? quote.current_price.toFixed(2) : '--'}
                    </div>
                    <div className={`font-mono text-[11px] leading-tight ${changeClass}`}>
                      {quote?.change_pct != null
                        ? `${quote.change_pct >= 0 ? '+' : ''}${quote.change_pct.toFixed(2)}%`
                        : '--'}
                    </div>
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-border/30 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1 min-w-0">
                    {added && <span className="text-[10px] text-muted-foreground/60">已关注</span>}
                  </div>
                  <div className="flex items-center gap-1">
                    {added ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 hover:text-destructive"
                        title="取消关注"
                        aria-label="取消关注"
                        onClick={() => onRemove(item)}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 hover:text-primary"
                        title="关注"
                        aria-label="关注"
                        disabled={adding === item.symbol}
                        onClick={() => void handleAdd(item)}
                      >
                        {adding === item.symbol
                          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Plus className="w-3.5 h-3.5" />}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-[11px]"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            上一页
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-[11px]"
            disabled={to >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}
