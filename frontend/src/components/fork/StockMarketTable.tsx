import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { marketSignTextClass } from '@/lib/market-colors'
import { STOCK_PAGE_SIZE } from '@/components/fork/stock-grid'
import { TablePagination } from '@/components/fork/TablePagination'
import { filterMarketRows, EMPTY_MARKET_FILTERS, type MarketTableFilters } from '@/lib/market-filters'
import { originalStockName } from '@/lib/stock-name'
import type { BoardKey } from '@/lib/board-classify'
import {
  parseMarketTablePayload,
  type MarketBoardCounts,
  type MarketRow,
  type MarketTablePayload,
} from '@/lib/fork-kline-summary'

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
 * 板块 / 指标 / 涨跌 / 市值 / 状态筛选、搜索、排序、分页**全部在前端做**：
 *   - 翻页不再打接口（上游那套「每翻一页 100 只」的请求彻底消失）
 *   - 每页条数可以给到 10000（只是浏览器里切一刀）
 *   - 排序作用于**全量**（5000 余行）之后再切片，不是只排当前页
 *
 * 表头排序：三态循环（用户指定的交互）
 * --------------------------------
 *   未排序（灰 ↕，提示「点击降序」）→ 降序（蓝 ↓，提示「点击升序」）
 *   → 升序（蓝 ↑，提示「取消排序」）→ 未排序
 * 「市场」列不给排序（用户明确说不需要）。「指标」列按库里的 ``tech_score`` 排，
 * 无分的新股恒排最后；「状态」列是交易日状态，固定列宽、不给排序。
 *
 * 列宽（用户逐列指定）：市场 60 / 代码 80 / 名称 140 / 成交量 96 / 成交额 104 /
 * 换手率 84（这三列排在**总市值前面**）/ 总市值之后紧跟**状态 68**
 * （停牌 / 正常 / ST 这类 2–3 字标签）/ 指标 160 → 120（本页最新要求再减 40）/
 * 来源 200 / 操作 180 → 220（Agent 配置图标搬进操作列，多一个按钮的宽度＋间隔）；
 * 其余数值列只给最小列宽，宽屏时摊开剩余空间。
 *
 * 本组件只管「取数 / 筛选 / 排序 / 分页 / 表格骨架 / 列的格式」——三个富列
 * （状态、指标、来源）与操作列由页面通过 render prop 注入：它们要弹上游的
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
  colVolume: '成交量',
  colAmount: '成交额',
  colTurnover: '换手率',
  colMarketCap: '总市值',
  /** 交易日状态（停牌 / 正常 / ST …）。第 4 条把原来的「状态」标题让给了这一列。 */
  colTradeStatus: '状态',
  /** 技术面结论（买入 / 回避 / 观望 + 技术面徽章）。原名「状态」，第 4 条改名。 */
  colIndicator: '指标',
  colSource: '来源',
  colActions: '操作',
  sortBy: (label: string) => `按${label}排序`,
  /** 状态列的兜底文案：库里没有状态行 = 正常交易 */
  statusNormal: '正常',
  /** 成交量/成交额的悬停说明（单位与被换算法，表格里显示的是「手」「亿」） */
  volumeHint: (shares: number) => `${shares.toLocaleString('zh-CN')} 股（1 手 = 100 股）`,
  amountHint: (yuan: number) => `${yuan.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 元`,
  // 表头排序提示：说的是「下一次点击会发生什么」（与截图一致）
  sortToDesc: '点击降序',
  sortToAsc: '点击升序',
  sortCancel: '取消排序',
  copyHint: '点击复制代码与名称',
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

/**
 * 市场列徽章的配色。
 *
 * 用户第四轮反馈：「深/沪 这几个字太暗了，看不清」。原因是这套色是按浅色底写的
 * （``text-blue-600`` 在白底上够，落到 dark 主题近黑的 ``--card`` 上就糊了），
 * 而 fork 页默认跑在 dark 主题下。所以每个交易所都补一组 dark 变体
 * （``dark:text-*-300`` + 把底色透明度抬到 /15），并把字号从 9px 提到 10px、
 * 加 font-medium —— 单字徽章太小会看不出是「沪」还是「深」。
 */
const EXCHANGE_CLASS: Record<string, string> = {
  SH: 'bg-blue-500/10 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300',
  SZ: 'bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300',
  BJ: 'bg-amber-500/10 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300',
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

/**
 * 成交量：库里是**股**，表格按 A 股习惯折成**手**（1 手 = 100 股）显示，
 * 万手以上折成「N.NN万手」（全市场最大约 357 万手，见云端实测）。
 * 原始股数在单元格 `title` 里给（`volumeHint`）。
 */
export function formatVolume(shares: number | null | undefined): string {
  if (shares == null || shares <= 0) return '--'
  const lots = shares / 100
  if (lots >= 1e4) return `${(lots / 1e4).toFixed(2)}万手`
  return `${Math.round(lots)}手`
}

/** 成交额：库里是**元**，按「亿 / 万」折算（与总市值同一套写法）。 */
export function formatAmount(yuan: number | null | undefined): string {
  if (yuan == null || yuan <= 0) return '--'
  if (yuan >= 1e8) return `${(yuan / 1e8).toFixed(2)}亿`
  if (yuan >= 1e4) return `${(yuan / 1e4).toFixed(2)}万`
  return `${Math.round(yuan)}`
}

/**
 * 换手率：库里**已经是百分数**（1.3814 = 1.38%），直接补 `%`，不要再乘 100。
 * 停牌日库里是 0 → 显示 0.00%（不是「--」：它有确定的含义）。
 */
export function formatTurnoverRate(rate: number | null | undefined): string {
  if (rate == null) return '--'
  return `${rate.toFixed(2)}%`
}

// ------------------------------------------------------------------ 排序

export type SortKey =
  | 'code'
  | 'name'
  | 'pre_close'
  | 'close'
  | 'change_pct'
  | 'high'
  | 'low'
  | 'volume'
  | 'amount'
  | 'turnover_rate'
  | 'total_market_cap'
  | 'score'

export interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

/** 取排序用的值；「状态」取库里的 tech_score（无分返回 null）。 */
function sortValue(row: MarketRow, key: SortKey): number | string | null {
  switch (key) {
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
    case 'volume':
      return row.volume
    case 'amount':
      return row.amount
    case 'turnover_rate':
      return row.turnover_rate
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

/**
 * 表头三态循环：未排序 → 降序 → 升序 → 未排序（``null`` = 回到接口给的原始顺序，
 * 也就是按代码升序）。提示语与图标状态都跟这三态走。
 */
export function nextSortState(current: SortState | null, key: SortKey): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'desc' }
  if (current.dir === 'desc') return { key, dir: 'asc' }
  return null
}

// ------------------------------------------------------------------ 列定义

interface ColumnDef {
  key: string
  label: string
  sortKey?: SortKey
  align?: 'right'
  /** 固定列宽（用户指定：市场/代码/名称/状态/指标/来源/操作） */
  width?: number
  /** 其余列只给最小列宽，宽屏摊开 */
  minWidth?: number
  /** 左内边距（px）——表头与单元格共用，否则表头与内容对不齐 */
  padLeft?: number
  /** 左右内边距同时覆盖（px）——名称列收窄后靠它把 px-2 的 8px 改成 4px，四字名才装得下 */
  padX?: number
}

const COLUMNS: ColumnDef[] = [
  // 市场列不参与排序（用户明确说不需要）
  // 市场 → 总市值 这 12 列一律改成**固定宽度**（用户：固定宽度的各减 10px；原来只给
  // 最小宽度的也设成固定值 = 原最小宽 − 10），这样整表列宽由本表说了算，不再随视口摊开。
  { key: 'market', label: MARKET_TABLE_TEXTS_ZH.colMarket, width: 50 },
  { key: 'code', label: MARKET_TABLE_TEXTS_ZH.colCode, sortKey: 'code', width: 70 },
  // 名称列 80 → 60（市场～总市值 −10，再按用户第 2 条再 −20）。
  // 60px 里再留 8px×2 的 px-2 只剩 44px，装不下 4 个汉字（48px）—— 名称列单独把左右内边距
  // 收到 4px（padX: 4），内容区回到 52px，四字名（平安银行/贵州茅台）不省略号，
  // 只有 *ST 开头的长名才 truncate（悬停有 title 显示原名）。
  { key: 'name', label: MARKET_TABLE_TEXTS_ZH.colName, sortKey: 'name', width: 60, padX: 4 },
  { key: 'pre_close', label: MARKET_TABLE_TEXTS_ZH.colPreClose, sortKey: 'pre_close', align: 'right', width: 74 },
  { key: 'close', label: MARKET_TABLE_TEXTS_ZH.colPrice, sortKey: 'close', align: 'right', width: 74 },
  { key: 'change_pct', label: MARKET_TABLE_TEXTS_ZH.colChange, sortKey: 'change_pct', align: 'right', width: 74 },
  { key: 'high', label: MARKET_TABLE_TEXTS_ZH.colHigh, sortKey: 'high', align: 'right', width: 74 },
  { key: 'low', label: MARKET_TABLE_TEXTS_ZH.colLow, sortKey: 'low', align: 'right', width: 74 },
  // 成交量 / 成交额 / 换手率：三列都紧跟「最低价」、**排在总市值前面**（用户指定）。
  // 换手率靠成交额最右侧，与右对齐的总市值之间由状态列的 40px 左内边距隔开（原有约定不变）。
  { key: 'volume', label: MARKET_TABLE_TEXTS_ZH.colVolume, sortKey: 'volume', align: 'right', width: 86 },
  { key: 'amount', label: MARKET_TABLE_TEXTS_ZH.colAmount, sortKey: 'amount', align: 'right', width: 94 },
  { key: 'turnover_rate', label: MARKET_TABLE_TEXTS_ZH.colTurnover, sortKey: 'turnover_rate', align: 'right', width: 74 },
  { key: 'total_market_cap', label: MARKET_TABLE_TEXTS_ZH.colMarketCap, sortKey: 'total_market_cap', align: 'right', width: 94 },
  // 状态列（交易日状态）：固定 68px —— 「停牌」「正常」「*ST」「待摘牌」都在 3 个字以内，
  // 68 = 3 个字（约 36px）+ 左右内边距，再宽就是白占地方。紧跟在总市值后面（用户指定）。
  // 左内边距 40px 在**这一列**（用户第 9 条：原来加在「指标」列前面的间距挪到状态列，
  // 指标列不再留白）—— 总市值是右对齐的，紧贴一个状态标签会糊成一片。
  { key: 'trade_status', label: MARKET_TABLE_TEXTS_ZH.colTradeStatus, width: 68, padLeft: 40 },
  // 指标列：左内边距 20px（用户最新第 1 条：指标列前面加 20px 间距），列宽 200 → 180 → 160 → 120
  // （第 4 条 −20；本轮再 −20；最新一轮「减少 40px」，同时把空态文案从
  // 「暂无技术面/AI 分析」缩成「暂无」——字数少了，列宽才敢压到 120）
  { key: 'indicator', label: MARKET_TABLE_TEXTS_ZH.colIndicator, sortKey: 'score', width: 120, padLeft: 20 },
  { key: 'source', label: MARKET_TABLE_TEXTS_ZH.colSource, width: 200 },
  // 操作列 220 → 180 → 220：Agent 状态列整列删掉，改成操作列里一颗「A」图标
  // （点击弹「配置监控 Agent」），所以把原来那一个按钮的宽度＋间隔（40px）加回来
  { key: 'actions', label: MARKET_TABLE_TEXTS_ZH.colActions, width: 220 },
]

/** 每个可排序列三种状态的图标（未排序灰 ↕ / 降序蓝 ↓ / 升序蓝 ↑）。 */
export function sortIconState(sort: SortState | null, key: SortKey): 'none' | 'asc' | 'desc' {
  if (!sort || sort.key !== key) return 'none'
  return sort.dir
}

/** 表头悬停提示：说的是「下一次点击会发生什么」（与用户给的截图一致）。 */
export function sortHintOf(sort: SortState | null, key: SortKey): string {
  const state = sortIconState(sort, key)
  if (state === 'none') return MARKET_TABLE_TEXTS_ZH.sortToDesc
  if (state === 'desc') return MARKET_TABLE_TEXTS_ZH.sortToAsc
  return MARKET_TABLE_TEXTS_ZH.sortCancel
}

/** 各板块计数（从全量数据里数，保证与列表口径必然一致）。 */
export function boardCountsOf(rows: MarketRow[]): MarketBoardCounts {
  const counts: MarketBoardCounts = { all: rows.length, sh: 0, sz: 0, kcb: 0, cyb: 0, st: 0 }
  for (const row of rows) {
    if (row.board === 'sh') counts.sh += 1
    else if (row.board === 'sz') counts.sz += 1
    else if (row.board === 'kcb') counts.kcb += 1
    else if (row.board === 'cyb') counts.cyb += 1
    else if (row.board === 'st') counts.st += 1
  }
  return counts
}

export interface MarketRowState {
  followed: boolean
  busy: boolean
  onFollow: () => void
  onUnfollow: () => void
}

interface StockMarketTableProps {
  board: BoardKey
  /** 搜索词（页面持有：与筛选行分开，跟着分页条走） */
  query: string
  /** 状态/涨跌/市值三组筛选（板块由 board 传，见 lib/market-filters.ts） */
  filters?: MarketTableFilters
  /** 已在自选里的代码集合（决定操作列是 + 还是 X） */
  existingSymbols: Set<string>
  onCounts?: (counts: MarketBoardCounts) => void
  onAdd: (row: MarketRow) => Promise<void> | void
  onRemove: (row: MarketRow) => void
  /** 点代码（文字按钮）→ 复制「代码 + 名称」 */
  onCopyCode?: (row: MarketRow) => void
  /** 点名称（文字按钮）→ 页面弹详情 */
  onOpenDetail: (row: MarketRow) => void
  /**
   * 「状态」筛选用的技术面动作（buy/avoid/watch）。由页面注入：它才知道怎么把
   * 库里的 tech_* 还原成动作（lib/fork-kline-summary.ts 的 marketRowAction），
   * 组件这边不重算口径 —— 否则筛出来的集合与状态列的徽章可能不是同一批。
   */
  getRowAction?: (row: MarketRow) => string | null
  /** 递增后重新向行情库取全量。筛选/翻页不改它，所以不会因此打接口。 */
  reloadToken?: number
  onLoadingChange?: (loading: boolean) => void
  /**
   * 条件选股的结果（fork）。非 null 时**替代**内部全量数据参与筛选、排序、分页；
   * 传回 null 就恢复全市场（内部全量一直留着，所以「退出选股」不重新请求）。
   */
  sourceRows?: MarketRow[] | null
  /** 选股结果为空时的空态文案（「没有股票满足当前条件」） */
  emptyTextOverride?: string
  /** 把接口返回的 asof 回传给页面（弹窗 footer 要显示「数据截至」） */
  onAsof?: (asof: string | null) => void
  /**
   * 表格**上方**那条工具条里、搜索框左边的按钮（页面把「刷新」「添加股票」放进来）。
   * 只有上一条分页条渲染它；下一条只保留「共 N 条 / 页码 / 每页条数」。
   */
  toolbarActions?: ReactNode
  /**
   * 工具条**第一行右侧**的元信息（数据时间 / 代码版本 / 提交时间）。
   * 第 1 条要求把它和「条件选股 / 已保存 / 编辑」放在同一行、一左一右。
   */
  toolbarMeta?: ReactNode
  /** 搜索框 + 「刷新 / 添加股票」按钮组（第二行；只有**上**一条分页条里出现） */
  searchSlot?: ReactNode
  /**
   * 第二行搜索框**后面**的筛选控件（市场 / 指标 / 涨跌 / 市值 / 状态 / 清空筛选）。
   * 用户要求把它们从「表格上方独立一行」挪到搜索框后面（2026-10-20 第 2 条）。
   */
  filtersSlot?: ReactNode
  /**
   * 工具条（刷新 / 添加股票 / 条件选股 + 搜索框）那一行的**下一行**内容。
   * 页面把「条件选股结果」横幅放进来 —— 用户要求横幅在按钮那一行的下面，
   * 而不是表格上方（那是按钮行的上面）。
   */
  belowToolbar?: ReactNode
  /** 「指标」列：AI 建议徽章 + 技术面徽章（原 renderStatus；第 4 条改名） */
  renderIndicator: (row: MarketRow) => ReactNode
  /** 「状态」列：交易日状态（停牌 / 正常 / ST …），由页面给标签与配色；不给就用纯文本 */
  renderTradeStatus?: (row: MarketRow) => ReactNode
  renderSource: (row: MarketRow) => ReactNode
  renderActions: (row: MarketRow, state: MarketRowState) => ReactNode
}

export function StockMarketTable({
  board,
  query,
  filters,
  existingSymbols,
  onCounts,
  onAdd,
  onRemove,
  onCopyCode,
  onOpenDetail,
  getRowAction,
  reloadToken = 0,
  onLoadingChange,
  sourceRows = null,
  emptyTextOverride,
  onAsof,
  toolbarActions,
  toolbarMeta,
  searchSlot,
  filtersSlot,
  belowToolbar,
  renderIndicator,
  renderTradeStatus,
  renderSource,
  renderActions,
}: StockMarketTableProps) {
  const [rows, setRows] = useState<MarketRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [busyCodes, setBusyCodes] = useState<Set<string>>(new Set())
  const [sort, setSort] = useState<SortState | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(STOCK_PAGE_SIZE)
  const countsRef = useRef(onCounts)
  countsRef.current = onCounts
  const onLoadingChangeRef = useRef(onLoadingChange)
  onLoadingChangeRef.current = onLoadingChange
  const onAsofRef = useRef(onAsof)
  onAsofRef.current = onAsof

  // 全量只在进入页面和点「刷新」时取：换板块 / 筛选 / 搜索 / 排序 / 翻页都不再打接口
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    onLoadingChangeRef.current?.(true)
    fetchAPI<MarketTablePayload>(
      `/stocks/market-table?board=all&limit=${MARKET_FETCH_LIMIT}`,
      { signal: controller.signal },
    )
      .then(payload => {
        if (controller.signal.aborted) return
        // 接口字段是 1–2 个字母的短名（瘦身），在这里一次性翻译回可读的 MarketRow
        const value = parseMarketTablePayload(payload)
        const items = value.items || []
        setRows(items)
        countsRef.current?.(boardCountsOf(items))
        onAsofRef.current?.(value.asof ?? null)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false)
          onLoadingChangeRef.current?.(false)
        }
      })
    return () => controller.abort()
  }, [reloadToken])

  const activeFilters = filters ?? EMPTY_MARKET_FILTERS
  // 选股结果（fork）：非 null 时替代内部全量参与后续所有计算
  const displayRows = sourceRows ?? rows
  // 全量（5000 余行）过滤 → 排序 → 再切片：排序是「对所有数据」的排序，不是只排当前页
  const filtered = useMemo(
    () => filterMarketRows(displayRows, board, query, activeFilters, getRowAction),
    [displayRows, board, query, activeFilters, getRowAction],
  )
  const sorted = useMemo(
    () => (sort ? [...filtered].sort((a, b) => compareRows(a, b, sort)) : filtered),
    [filtered, sort],
  )
  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize],
  )

  // 换板块 / 改筛选 / 改搜索 / 换每页条数 → 回第一页（否则会停在一个不存在的页码上）
  useEffect(() => {
    setPage(1)
  }, [board, query, pageSize, activeFilters, sourceRows])

  // 板块计数跟着「当前数据源」走：选股结果生效时数的是结果集，
  // 退出选股（sourceRows 变回 null）再数回全量 —— 界面上的计数与列表口径因此一致。
  useEffect(() => {
    if (sourceRows) countsRef.current?.(boardCountsOf(sourceRows))
  }, [sourceRows])

  useEffect(() => {
    if (sourceRows === null && rows.length > 0) countsRef.current?.(boardCountsOf(rows))
  }, [rows, sourceRows])

  const handleFollow = useCallback(
    async (row: MarketRow) => {
      setBusyCodes(prev => {
        const next = new Set(prev)
        next.add(row.code)
        return next
      })
      try {
        await onAdd(row)
      } finally {
        setBusyCodes(prev => {
          if (!prev.has(row.code)) return prev
          const next = new Set(prev)
          next.delete(row.code)
          return next
        })
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
            className={`rounded px-1 py-0.5 text-[10px] font-medium ${EXCHANGE_CLASS[String(row.exchange || '').toUpperCase()] || 'bg-accent text-muted-foreground'}`}
          >
            {exchangeLabel(row.exchange)}
          </span>
        )
      case 'code':
        // 用户要求：点代码 = 复制「代码 + 名称」（空格隔开），不再是打开详情。
        // 悬停样式与股票卡片里的文字按钮一致（hover:text-primary，不带下划线）。
        return (
          <button
            type="button"
            onClick={() => (onCopyCode ? onCopyCode(row) : undefined)}
            title={`${MARKET_TABLE_TEXTS_ZH.copyHint} ${row.code} ${originalStockName(row.name)}`}
            className="font-mono font-semibold text-foreground transition-colors hover:text-primary"
          >
            {row.code}
          </button>
        )
      case 'name':
        // 悬停显示**原始名字**（剥掉 *ST/ST 前缀），单元格里仍是库里那个带标记的名字
        return (
          <button
            type="button"
            onClick={() => onOpenDetail(row)}
            title={originalStockName(row.name)}
            className="block max-w-full truncate text-left text-muted-foreground transition-colors hover:text-primary"
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
      case 'volume':
        return (
          <span className="font-mono" title={row.volume != null ? MARKET_TABLE_TEXTS_ZH.volumeHint(row.volume) : undefined}>
            {formatVolume(row.volume)}
          </span>
        )
      case 'amount':
        return (
          <span className="font-mono" title={row.amount != null ? MARKET_TABLE_TEXTS_ZH.amountHint(row.amount) : undefined}>
            {formatAmount(row.amount)}
          </span>
        )
      case 'turnover_rate':
        return <span className="font-mono">{formatTurnoverRate(row.turnover_rate)}</span>
      case 'total_market_cap':
        return <span className="font-mono">{formatMarketCap(row.total_market_cap)}</span>
      case 'trade_status':
        // 页面没注入渲染器时的兜底：纯文本标签（正常 / 停牌 / ST …）
        return renderTradeStatus ? (
          renderTradeStatus(row)
        ) : (
          <span className="whitespace-nowrap text-[11px] text-muted-foreground">
            {row.status_label || MARKET_TABLE_TEXTS_ZH.statusNormal}
          </span>
        )
      case 'indicator':
        return renderIndicator(row)
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
    : displayRows.length === 0
      ? sourceRows != null
        ? (emptyTextOverride ?? MARKET_TABLE_TEXTS_ZH.empty)
        : MARKET_TABLE_TEXTS_ZH.empty
      : sourceRows != null
        ? (emptyTextOverride ?? MARKET_TABLE_TEXTS_ZH.noMatch)
        : MARKET_TABLE_TEXTS_ZH.noMatch

  /**
   * 分页条：上、下各一条。
   *   上：工具条（刷新 / 添加股票 + 50px + 搜索框）+ 右侧「共 N 条 / 页码 / 每页条数」
   *   下：只有右侧那一块（用户要求底部不要搜索框）
   */
  const pagination = (position: 'top' | 'bottom') => (
    <TablePagination
      total={sorted.length}
      page={safePage}
      pageSize={pageSize}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
      disabled={loading}
      actions={position === 'top' ? toolbarActions : undefined}
      meta={position === 'top' ? toolbarMeta : undefined}
      leading={position === 'top' ? searchSlot : undefined}
      filters={position === 'top' ? filtersSlot : undefined}
    />
  )

  return (
    <div>
      {/* 上方分页条：左边是工具条（刷新 / 添加股票 + 50px + 搜索框），右边是页码区 */}
      {pagination('top')}

      {/* 工具条下一行（条件选股结果横幅） */}
      {belowToolbar}

      {sorted.length === 0 ? (
        <div className="py-10 text-center text-[12px] text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="overflow-x-auto scrollbar">
          {/* 表格最小宽 = 各列固定宽之和 1506px（1596 − 指标 40 − 删掉的 Agent 状态 90 + 操作列 40）。
              保留 w-full：容器比 1506 窄时表格正好按 colgroup 的 px 排（列宽=设定值），
              窄到不够就横向滚动；只有容器比 1506 还宽时 table-fixed 才会把余量按比例摊给各列——
              这是原来就有的行为（宽屏铺满），本次不动 */}
          <table className="w-full min-w-[1506px] table-fixed text-[12px]">
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
                  const iconState = column.sortKey ? sortIconState(sort, column.sortKey) : 'none'
                  return (
                    <th
                      key={column.key}
                      style={{
                        ...(column.minWidth ? { minWidth: column.minWidth } : {}),
                        ...(column.padLeft ? { paddingLeft: column.padLeft } : {}),
                        ...(column.padX
                          ? { paddingLeft: column.padX, paddingRight: column.padX }
                          : {}),
                      }}
                      className={`whitespace-nowrap px-2 py-2 font-normal ${
                        column.align === 'right' ? 'text-right' : 'text-left'
                      }`}
                    >
                      {column.sortKey ? (
                        <button
                          type="button"
                          aria-label={MARKET_TABLE_TEXTS_ZH.sortBy(column.label)}
                          title={sortHintOf(sort, column.sortKey)}
                          onClick={() => setSort(current => nextSortState(current, column.sortKey as SortKey))}
                          className={`inline-flex items-center gap-1 transition-colors hover:text-primary ${
                            iconState === 'none' ? '' : 'text-primary'
                          }`}
                        >
                          {column.label}
                          {iconState === 'none' && (
                            <ArrowUpDown className="h-3 w-3 text-muted-foreground/40" />
                          )}
                          {iconState === 'desc' && <ArrowDown className="h-3 w-3" />}
                          {iconState === 'asc' && <ArrowUp className="h-3 w-3" />}
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
                  busy: busyCodes.has(row.code),
                  onFollow: () => void handleFollow(row),
                  onUnfollow: () => onRemove(row),
                }
                return (
                  <Fragment key={row.code}>
                    <tr className="border-b border-border/25 hover:bg-accent/20 align-middle">
                      {COLUMNS.map(column => (
                        <td
                          key={column.key}
                          style={{
                            ...(column.minWidth ? { minWidth: column.minWidth } : {}),
                            ...(column.padLeft ? { paddingLeft: column.padLeft } : {}),
                            ...(column.padX
                              ? { paddingLeft: column.padX, paddingRight: column.padX }
                              : {}),
                          }}
                          className={`py-2 px-2 ${column.align === 'right' ? 'text-right' : 'text-left'} ${
                            column.key === 'source'
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

      {/* 下方分页条：只有页码区（用户要求底部不要搜索框） */}
      {pagination('bottom')}
    </div>
  )
}

export default StockMarketTable
