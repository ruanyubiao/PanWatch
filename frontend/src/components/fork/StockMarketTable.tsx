import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { marketSignTextClass } from '@/lib/market-colors'
import { STOCK_PAGE_SIZE } from '@/components/fork/stock-grid'
import { TablePagination } from '@/components/fork/TablePagination'
import { stockMatchesSearch } from '@/lib/stock-search'
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
 * 取数策略：**一次取全量**，之后全在浏览器里
 * ------------------------------------------
 * 用户要求「一下子获取全部的数据，剩下的就是前端缓存，然后自己处理数据」。
 * 所以这里只发**一次**请求（``limit=20000``，覆盖全市场 5600 余只），
 * 板块筛选、搜索、排序、分页**全部在前端做**：
 *   - 翻页不再打接口（上游那套「每翻一页 100 只」的请求彻底消失）
 *   - 每页条数可以给到 10000（只是浏览器里切一刀）
 *   - 搜索语法用 Everything 风格那个库（见 lib/stock-search.ts）
 *
 * 列宽与排序（用户逐条指定）
 * -------------------------
 *   固定列宽：市场 / 代码 / 名称 / 状态 / Agent 状态 / 来源 / 操作
 *   其余列给最小列宽，宽屏时摊开剩余空间
 *   可排序：表头点击；「状态」按库里的 tech_score 排（新股无分 → 恒排最后）
 *
 * 本组件只管「取数 / 筛选 / 排序 / 分页 / 表格骨架 / 列的格式」——四个富列
 * （状态、Agent 状态、来源、操作）由页面通过 render prop 注入：它们要弹上游的
 * 弹窗、要读建议池与自选状态，属于页面的事。列的顺序与表头只在这里出现一次
 * （**单一真相**），单测直接钉住它。
 *
 * 现价 = 库里最新一个交易日的收盘价（``asof``），盘中不是实时价。
 */

/** 表头与固定文案。变量名以 _ZH 结尾 —— 仓库的 check:i18n 放行这种声明。 */
const MARKET_TABLE_TEXTS_ZH = {
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
  sortBy: (label: string) => `按${label}排序`,
  loading: '加载中…',
  empty: '暂无数据',
  noMatch: '没有匹配的股票',
  failed: '加载失败，请稍后重试',
}

/**
 * 一次取回全市场。后端 ``MAX_LIMIT`` 也是 20000（两处必须配套）。
 * A 股现存约 5600 只，留足余量。
 */
export const MARKET_FETCH_LIMIT = 20000

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

/** 市场列的排序权重：沪 → 深 → 北（库里 exchange 只有这三个值）。 */
const EXCHANGE_RANK: Record<string, number> = { SH: 0, SZ: 1, BJ: 2 }

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

// ------------------------------------------------------------------ 排序

export type SortKey =
  | 'market'
  | 'code'
  | 'name'
  | 'pre_close'
  | 'close'
  | 'change_pct'
  | 'high'
  | 'low'
  | 'total_market_cap'
  | 'score'

export interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

export const DEFAULT_SORT: SortState = { key: 'code', dir: 'asc' }

/** 取排序用的值；「状态」取库里的 tech_score（无分返回 null）。 */
function sortValue(row: MarketRow, key: SortKey): number | string | null {
  switch (key) {
    case 'market':
      return EXCHANGE_RANK[String(row.exchange || '').toUpperCase()] ?? 9
    case 'code':
      return row.code
    case 'name':
      return row.name ?? ''
    case 'score':
      return row.tech ? row.tech.score : null
    case 'pre_close':
      return row.pre_close
    case 'close':
      return row.close
    case 'change_pct':
      return row.change_pct
    case 'high':
      return row.high
    case 'low':
      return row.low
    case 'total_market_cap':
      return row.total_market_cap
    default:
      return null
  }
}

/**
 * 行比较。空值（新股无 tech_*、缺行情）**恒排最后**，与升降序无关 ——
 * 否则倒序时「数据不足」的票会集体跑到第一屏，看着像有结论。
 */
export function compareRows(a: MarketRow, b: MarketRow, sort: SortState): number {
  const av = sortValue(a, sort.key)
  const bv = sortValue(b, sort.key)
  if (av == null && bv == null) return a.code.localeCompare(b.code)
  if (av == null) return 1
  if (bv == null) return -1

  const diff =
    typeof av === 'string' || typeof bv === 'string'
      ? String(av).localeCompare(String(bv), 'zh-Hans-CN')
      : av - bv
  if (diff === 0) return a.code.localeCompare(b.code)
  return sort.dir === 'asc' ? diff : -diff
}

/** 点表头：换列按默认方向（文字/代码/市场升序，数值与分数降序），同列则翻转。 */
export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
  const textLike = key === 'market' || key === 'code' || key === 'name'
  return { key, dir: textLike ? 'asc' : 'desc' }
}

// ------------------------------------------------------------------ 列定义

interface ColumnDef {
  key: string
  label: string
  sortKey?: SortKey
  align?: 'right'
  /** 固定列宽（用户指定：市场/代码/名称/状态/Agent 状态/来源/操作） */
  width?: number
  /** 其余列只给最小列宽，宽屏摊开 */
  minWidth?: number
  cellClassName?: string
}

const COLUMNS: ColumnDef[] = [
  { key: 'market', label: MARKET_TABLE_TEXTS_ZH.colMarket, sortKey: 'market', width: 56 },
  { key: 'code', label: MARKET_TABLE_TEXTS_ZH.colCode, sortKey: 'code', width: 80 },
  { key: 'name', label: MARKET_TABLE_TEXTS_ZH.colName, sortKey: 'name', width: 140 },
  { key: 'pre_close', label: MARKET_TABLE_TEXTS_ZH.colPreClose, sortKey: 'pre_close', align: 'right', minWidth: 84 },
  { key: 'close', label: MARKET_TABLE_TEXTS_ZH.colPrice, sortKey: 'close', align: 'right', minWidth: 84 },
  { key: 'change_pct', label: MARKET_TABLE_TEXTS_ZH.colChange, sortKey: 'change_pct', align: 'right', minWidth: 84 },
  { key: 'high', label: MARKET_TABLE_TEXTS_ZH.colHigh, sortKey: 'high', align: 'right', minWidth: 84 },
  { key: 'low', label: MARKET_TABLE_TEXTS_ZH.colLow, sortKey: 'low', align: 'right', minWidth: 84 },
  { key: 'total_market_cap', label: MARKET_TABLE_TEXTS_ZH.colMarketCap, sortKey: 'total_market_cap', align: 'right', minWidth: 104 },
  // 状态列固定 200px，且左内边距 20px —— 总市值是右对齐的，两块贴一起会糊成一片
  { key: 'status', label: MARKET_TABLE_TEXTS_ZH.colStatus, sortKey: 'score', width: 200, cellClassName: 'px-5' },
  { key: 'agent', label: MARKET_TABLE_TEXTS_ZH.colAgent, width: 116 },
  { key: 'source', label: MARKET_TABLE_TEXTS_ZH.colSource, width: 200 },
  { key: 'actions', label: MARKET_TABLE_TEXTS_ZH.colActions, width: 212 },
]

/** 各板块计数（从全量数据里数，保证与列表口径必然一致）。 */
export function boardCountsOf(rows: MarketRow[]): MarketTableResponse['counts'] {
  const counts: MarketTableResponse['counts'] = { all: rows.length, sh: 0, sz: 0, kcb: 0, cyb: 0, st: 0 }
  for (const row of rows) {
    if (row.board === 'sh') counts.sh += 1
    else if (row.board === 'sz') counts.sz += 1
    else if (row.board === 'kcb') counts.kcb += 1
    else if (row.board === 'cyb') counts.cyb += 1
    else if (row.board === 'st') counts.st += 1
  }
  return counts
}

/** 按板块 + 搜索串过滤（搜索走 Everything 语法，匹配「代码 + 名称」）。 */
export function filterRows(rows: MarketRow[], board: BoardKey, query: string): MarketRow[] {
  return rows.filter(
    row => (board === 'all' || row.board === board) && stockMatchesSearch(row, query),
  )
}

export interface MarketRowState {
  followed: boolean
  busy: boolean
  onFollow: () => void
  onUnfollow: () => void
}

interface StockMarketTableProps {
  board: BoardKey
  /** 搜索词（页面持有：与板块 pill 同一行，见 ForkAnalysis） */
  query: string
  /** 已在自选里的代码集合（决定操作列是 + 还是 X） */
  existingSymbols: Set<string>
  onCounts?: (counts: MarketTableResponse['counts']) => void
  onAdd: (row: MarketRow) => Promise<void> | void
  onRemove: (row: MarketRow) => void
  /** 点代码 / 名称（文字按钮）→ 页面弹详情 */
  onOpenDetail: (row: MarketRow) => void
  renderStatus: (row: MarketRow) => ReactNode
  renderAgentStatus: (row: MarketRow) => ReactNode
  renderSource: (row: MarketRow) => ReactNode
  renderActions: (row: MarketRow, state: MarketRowState) => ReactNode
}

export function StockMarketTable({
  board,
  query,
  existingSymbols,
  onCounts,
  onAdd,
  onRemove,
  onOpenDetail,
  renderStatus,
  renderAgentStatus,
  renderSource,
  renderActions,
}: StockMarketTableProps) {
  const [rows, setRows] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(STOCK_PAGE_SIZE)
  const countsRef = useRef(onCounts)
  countsRef.current = onCounts

  // 全量只取一次：换板块 / 搜索 / 翻页都不再打接口（用户要求的前端缓存）
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    fetchAPI<MarketTableResponse>(
      `/stocks/market-table?board=all&limit=${MARKET_FETCH_LIMIT}`,
      { signal: controller.signal },
    )
      .then(value => {
        if (controller.signal.aborted) return
        const items = value.items || []
        setRows(items)
        countsRef.current?.(boardCountsOf(items))
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [])

  const filtered = useMemo(() => filterRows(rows, board, query), [rows, board, query])
  const sorted = useMemo(() => [...filtered].sort((a, b) => compareRows(a, b, sort)), [filtered, sort])
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize],
  )

  // 换板块 / 改搜索 / 换每页条数 → 回第一页（否则会停在一个不存在的页码上）
  useEffect(() => {
    setPage(1)
  }, [board, query, pageSize])

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

  const renderCell = (row: MarketRow, key: string, state: MarketRowState): ReactNode => {
    const changeClass = marketSignTextClass(row.change_pct)
    switch (key) {
      case 'market':
        return (
          <span
            className={`text-[9px] px-1 py-0.5 rounded ${EXCHANGE_CLASS[String(row.exchange || '').toUpperCase()] || 'bg-accent text-muted-foreground'}`}
          >
            {exchangeLabel(row.exchange)}
          </span>
        )
      case 'code':
        return (
          <button
            type="button"
            onClick={() => onOpenDetail(row)}
            title={row.code}
            className="font-mono font-semibold text-foreground transition-colors hover:text-primary hover:underline"
          >
            {row.code}
          </button>
        )
      case 'name':
        return (
          <button
            type="button"
            onClick={() => onOpenDetail(row)}
            title={row.name}
            className="block max-w-full truncate text-left text-muted-foreground transition-colors hover:text-primary hover:underline"
          >
            {row.name}
          </button>
        )
      case 'pre_close':
        return <span className="font-mono">{formatPrice(row.pre_close)}</span>
      case 'close':
        return <span className={`font-mono font-bold ${changeClass}`}>{formatPrice(row.close)}</span>
      case 'change_pct':
        return <span className={`font-mono ${changeClass}`}>{formatChangePct(row.change_pct)}</span>
      case 'high':
        return <span className="font-mono">{formatPrice(row.high)}</span>
      case 'low':
        return <span className="font-mono">{formatPrice(row.low)}</span>
      case 'total_market_cap':
        return <span className="font-mono">{formatMarketCap(row.total_market_cap)}</span>
      case 'status':
        return renderStatus(row)
      case 'agent':
        return renderAgentStatus(row)
      case 'source':
        return renderSource(row)
      case 'actions':
        return <div className="flex items-center gap-0.5">{renderActions(row, state)}</div>
      default:
        return null
    }
  }

  if (error) {
    return (
      <div className="py-10 text-center text-[12px] text-muted-foreground">
        {MARKET_TABLE_TEXTS_ZH.failed}
      </div>
    )
  }

  const emptyText = loading
    ? MARKET_TABLE_TEXTS_ZH.loading
    : rows.length === 0
      ? MARKET_TABLE_TEXTS_ZH.empty
      : MARKET_TABLE_TEXTS_ZH.noMatch

  return (
    <div>
      {/* 分页条：上下各一条，形式完全一致（用户要求「上下都一样」） */}
      <TablePagination
        total={sorted.length}
        page={safePage}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={loading}
      />

      {sorted.length === 0 ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto scrollbar">
          {/* 表格最小宽度 = 固定列之和 + 各列最小宽，窄屏横向滚动而不是把列挤烂 */}
          <table className="w-full min-w-[1530px] table-fixed text-[12px]">
            <colgroup>
              {COLUMNS.map(column => (
                <col
                  key={column.key}
                  style={column.width ? { width: column.width } : { minWidth: column.minWidth }}
                />
              ))}
            </colgroup>
            <thead>
              <tr className="border-b border-border/50 text-[11px] text-muted-foreground">
                {COLUMNS.map(column => {
                  const active = column.sortKey != null && sort.key === column.sortKey
                  return (
                    <th
                      key={column.key}
                      style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                      className={`whitespace-nowrap px-2 py-2 font-normal ${
                        column.align === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {column.sortKey ? (
                        <button
                          type="button"
                          aria-label={MARKET_TABLE_TEXTS_ZH.sortBy(column.label)}
                          onClick={() => setSort(current => nextSortState(current, column.sortKey as SortKey))}
                          className={`inline-flex items-center gap-1 transition-colors hover:text-foreground ${
                            active ? 'text-foreground' : ''
                          }`}
                        >
                          {column.label}
                          {active ? (
                            sort.dir === 'asc' ? (
                              <ArrowUp className="h-3 w-3" />
                            ) : (
                              <ArrowDown className="h-3 w-3" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3 w-3 text-muted-foreground/40" />
                          )}
                        </button>
                      ) : (
                        column.label
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(row => {
                const followed = existingSymbols.has(row.code) || existingSymbols.has(row.symbol)
                const state: MarketRowState = {
                  followed,
                  busy: busy === row.code,
                  onFollow: () => void handleFollow(row),
                  onUnfollow: () => onRemove(row),
                }
                return (
                  <Fragment key={row.code}>
                    <tr className="border-b border-border/25 hover:bg-accent/20 align-middle">
                      {COLUMNS.map(column => (
                        <td
                          key={column.key}
                          style={column.minWidth ? { minWidth: column.minWidth } : undefined}
                          className={`py-2 ${column.cellClassName || 'px-2'} ${
                            column.align === 'right' ? 'text-right' : 'text-left'
                          } ${
                            column.key === 'source' || column.key === 'agent'
                              ? 'whitespace-nowrap text-[11px] text-muted-foreground'
                              : ''
                          } ${column.key === 'actions' ? 'whitespace-nowrap' : ''}`}
                        >
                          {renderCell(row, column.key, state)}
                        </td>
                      ))}
                    </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <TablePagination
        total={sorted.length}
        page={safePage}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={loading}
      />
    </div>
  )
}

export default StockMarketTable
