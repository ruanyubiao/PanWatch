import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { marketSignTextClass } from '@/lib/market-colors'
import { STOCK_PAGE_SIZE } from '@/components/fork/stock-grid'
import { StockListToolbar } from '@/components/fork/StockListToolbar'
import type { BoardKey } from '@/lib/board-classify'
import type { MarketRow, MarketTableResponse } from '@/lib/fork-kline-summary'

/**
 * fork 专用：A 股全市场行情**表格**（分析页的主列表）。
 *
 * 数据来自 fork 新增的后端接口 ``GET /api/stocks/market-table`` —— 行情、市值、
 * 技术面全部读本机 MySQL（``stock`` 库，日终已算好），**一个外网请求都不发**。
 * 这正是「查外网次数太多被屏蔽」的解法：上游那两条批量请求
 * （``/quotes/batch``、``/klines/summary/batch``）在这张表上完全不存在。
 *
 * 本组件只管「取数 / 分页 / 表格骨架 / 列的格式」——四个富列（状态、Agent 状态、
 * 来源、操作）由页面通过 render prop 注入：它们要弹上游的弹窗、要读建议池与
 * 自选状态，属于页面的事。列的顺序与表头只在这里出现一次（**单一真相**），
 * 单测直接钉住它。
 *
 * 现价 = 库里最新一个交易日的收盘价（``asof``），盘中不是实时价。
 */

/** 表头与固定文案。变量名以 _ZH 结尾 —— 仓库的 check:i18n 放行这种声明。 */
const MARKET_TABLE_TEXTS_ZH = {
  searchPlaceholder: '搜索代码或名称',
  colMarket: '市场',
  colCode: '代码',
  colName: '名称',
  colPreClose: '昨收价',
  colPrice: '现价',
  colChange: '涨跌',
  colHigh: '最高价',
  colLow: '最低价',
  colMarketCap: '总市值',
  colStatus: '状态',
  colAgent: 'Agent 状态',
  colSource: '来源',
  colActions: '操作',
  prevPage: '上一页',
  nextPage: '下一页',
  loading: '加载中…',
  empty: '暂无数据',
  noMatch: '没有匹配的股票',
  failed: '加载失败，请稍后重试',
  total: (n: number) => `共 ${n} 只`,
}

const EXCHANGE_LABEL_ZH: Record<string, string> = {
  SH: '沪',
  SZ: '深',
  BJ: '北',
}

const EXCHANGE_CLASS: Record<string, string> = {
  SH: 'bg-blue-500/10 text-blue-600',
  SZ: 'bg-violet-500/10 text-violet-600',
  BJ: 'bg-amber-500/10 text-amber-600',
}

/** 市场列：沪 / 深 / 北（库里 exchange 只有这三个值）。 */
export function exchangeLabel(exchange: string | null | undefined): string {
  return EXCHANGE_LABEL_ZH[String(exchange || '').toUpperCase()] || '—'
}

export function formatPrice(value: number | null | undefined): string {
  return value == null ? '--' : value.toFixed(2)
}

export function formatChangePct(value: number | null | undefined): string {
  if (value == null) return '--'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** 总市值：≥1 万亿显示「N.NN万亿」，否则「N.NN亿」。 */
export function formatMarketCap(value: number | null | undefined): string {
  if (value == null || value <= 0) return '--'
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}万亿`
  return `${(value / 1e8).toFixed(2)}亿`
}

export interface MarketRowState {
  followed: boolean
  busy: boolean
  onFollow: () => void
  onUnfollow: () => void
}

interface StockMarketTableProps {
  board: BoardKey
  /** 受控搜索词（页面持有，便于与其它区块共享） */
  query: string
  onQueryChange: (value: string) => void
  /** 已在自选里的代码集合（决定操作列是 + 还是 X） */
  existingSymbols: Set<string>
  onCounts?: (counts: MarketTableResponse['counts']) => void
  onAdd: (row: MarketRow) => Promise<void> | void
  onRemove: (row: MarketRow) => void
  renderStatus: (row: MarketRow) => ReactNode
  renderAgentStatus: (row: MarketRow) => ReactNode
  renderSource: (row: MarketRow) => ReactNode
  renderActions: (row: MarketRow, state: MarketRowState) => ReactNode
  /** 当前页数据（页面据此把 AI 建议套到行上） */
  onPageItems?: (rows: MarketRow[]) => void
}

export function StockMarketTable({
  board,
  query,
  onQueryChange,
  existingSymbols,
  onCounts,
  onAdd,
  onRemove,
  renderStatus,
  renderAgentStatus,
  renderSource,
  renderActions,
  onPageItems,
}: StockMarketTableProps) {
  const [debounced, setDebounced] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<MarketTableResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
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
    fetchAPI<MarketTableResponse>(
      `/stocks/market-table?board=${encodeURIComponent(board)}&q=${encodeURIComponent(debounced)}&offset=${offset}&limit=${STOCK_PAGE_SIZE}`,
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

  const handleFollow = useCallback(
    async (row: MarketRow) => {
      setBusy(row.code)
      try {
        await onAdd(row)
      } finally {
        setBusy(null)
      }
    },
    [onAdd],
  )

  const total = data?.total ?? 0
  const from = total === 0 ? 0 : offset + 1
  const to = Math.min(offset + STOCK_PAGE_SIZE, total)
  const statusText = total > 0 ? `${MARKET_TABLE_TEXTS_ZH.total(total)}，当前 ${from}-${to}` : ''
  const headers = [
    MARKET_TABLE_TEXTS_ZH.colMarket,
    MARKET_TABLE_TEXTS_ZH.colCode,
    MARKET_TABLE_TEXTS_ZH.colName,
    MARKET_TABLE_TEXTS_ZH.colPreClose,
    MARKET_TABLE_TEXTS_ZH.colPrice,
    MARKET_TABLE_TEXTS_ZH.colChange,
    MARKET_TABLE_TEXTS_ZH.colHigh,
    MARKET_TABLE_TEXTS_ZH.colLow,
    MARKET_TABLE_TEXTS_ZH.colMarketCap,
    MARKET_TABLE_TEXTS_ZH.colStatus,
    MARKET_TABLE_TEXTS_ZH.colAgent,
    MARKET_TABLE_TEXTS_ZH.colSource,
    MARKET_TABLE_TEXTS_ZH.colActions,
  ]

  return (
    <div>
      <StockListToolbar
        value={query}
        onChange={onQueryChange}
        placeholder={MARKET_TABLE_TEXTS_ZH.searchPlaceholder}
        loading={loading}
        status={statusText}
      />

      {error ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">
          {MARKET_TABLE_TEXTS_ZH.failed}
        </div>
      ) : total === 0 ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">
          {loading
            ? MARKET_TABLE_TEXTS_ZH.loading
            : debounced
              ? MARKET_TABLE_TEXTS_ZH.noMatch
              : MARKET_TABLE_TEXTS_ZH.empty}
        </div>
      ) : (
        <div className="overflow-x-auto scrollbar">
          <table className="w-full min-w-[1180px] text-[12px]">
            <thead>
              <tr className="border-b border-border/50 text-left text-[11px] text-muted-foreground">
                {headers.map((label, index) => (
                  <th
                    key={label}
                    className={`whitespace-nowrap px-2 py-2 font-normal ${[3, 4, 5, 6, 7, 8].includes(index) ? 'text-right' : ''}`}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.items.map(row => {
                const followed = existingSymbols.has(row.code) || existingSymbols.has(row.symbol)
                const state: MarketRowState = {
                  followed,
                  busy: busy === row.code,
                  onFollow: () => void handleFollow(row),
                  onUnfollow: () => onRemove(row),
                }
                const changeClass = marketSignTextClass(row.change_pct)
                return (
                  <Fragment key={row.code}>
                    <tr className="border-b border-border/25 hover:bg-accent/20 align-middle">
                      <td className="px-2 py-2">
                        <span
                          className={`text-[9px] px-1 py-0.5 rounded ${EXCHANGE_CLASS[String(row.exchange || '').toUpperCase()] || 'bg-accent text-muted-foreground'}`}
                        >
                          {exchangeLabel(row.exchange)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 font-mono font-semibold">{row.code}</td>
                      <td className="max-w-[180px] truncate px-2 py-2 text-muted-foreground" title={row.name}>
                        {row.name}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-mono">
                        {formatPrice(row.pre_close)}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 text-right font-mono font-bold ${changeClass}`}>
                        {formatPrice(row.close)}
                      </td>
                      <td className={`whitespace-nowrap px-2 py-2 text-right font-mono ${changeClass}`}>
                        {formatChangePct(row.change_pct)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-mono">
                        {formatPrice(row.high)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-mono">
                        {formatPrice(row.low)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-right font-mono">
                        {formatMarketCap(row.total_market_cap)}
                      </td>
                      <td className="px-2 py-2">{renderStatus(row)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-[11px] text-muted-foreground">
                        {renderAgentStatus(row)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 text-[11px] text-muted-foreground">
                        {renderSource(row)}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2">
                        <div className="flex items-center gap-0.5">{renderActions(row, state)}</div>
                      </td>
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
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
            {MARKET_TABLE_TEXTS_ZH.prevPage}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-[11px]"
            disabled={to >= total || loading}
            onClick={() => setOffset(offset + STOCK_PAGE_SIZE)}
          >
            {MARKET_TABLE_TEXTS_ZH.nextPage}
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

export default StockMarketTable
