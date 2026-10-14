/**
 * fork 专用：分析页表格的**筛选**（除板块以外的三组）。
 *
 * 用户第二轮要求把筛选做成「机会页」那种形式（下拉 + 清空筛选），四组：
 *   组1 市场   全部 | 上证 | 深证 | 创业 | 科创 | ST  （单选，pill 行，见 board-classify.ts）
 *   组2 状态   全部 | 买入 | 回避 | 观望               （**多选**下拉）
 *   组3 涨跌   全部 | 上涨 | 下跌                       （单选下拉）
 *   组4 市值   全部 | 50亿 | 100亿 | 300亿 | 500亿 | 1000亿 | 其他
 *                                                     （**多选**下拉）
 *              其中「50亿」表示**小于 50 亿**，往上每档是「上一档 ~ 本档」，
 *              「其他」表示 1000 亿以上 —— 与用户给的写法一致。
 *
 * 多选组的语义：一档都不选 = 不限；选了若干档 = **并集**（命中任一档即通过）。
 *
 * 本文件是纯函数 + 常量，界面在 components/fork/StockFilterBar.tsx 与
 * components/fork/MultiSelectFilter.tsx，数据量级是「全市场一次取回后在前端过滤」
 * （5000 余行），所以匹配函数要便宜。
 */
import { stockMatchesSearch } from '@/lib/stock-search'
import type { BoardKey } from '@/lib/board-classify'
import type { MarketRow } from '@/lib/fork-kline-summary'

export type ChangeFilter = 'all' | 'up' | 'down'
export type CapFilter = 'lt50' | 'lt100' | 'lt300' | 'lt500' | 'lt1000' | 'gt1000'

export interface MarketTableFilters {
  /** 技术面动作 key（kline-scorer 的 Action）：空数组 = 不限；多选 = 命中其一即可 */
  status: string[]
  change: ChangeFilter
  /** 市值档位：空数组 = 不限；多选 = 命中任一档即可 */
  cap: CapFilter[]
}

export const EMPTY_MARKET_FILTERS: MarketTableFilters = { status: [], change: 'all', cap: [] }

/**
 * 组2 的候选动作 —— 就是状态列里「技术面」那颗徽章能给出的动作全集
 * （未持仓口径：score≥3 买入 / score≤−2 回避 / 其余观望，见 lib/kline-scorer.ts）。
 * 文案由页面从 bizUi 的 kline.actions.* 取，避免同一个动作两套叫法。
 */
export const STATUS_FILTER_KEYS = ['buy', 'avoid', 'watch'] as const

export interface FilterOption<T extends string> {
  key: T
  label: string
  /** 悬停说明（市值档位的区间只有这里能看明白） */
  hint: string
}

export const CHANGE_FILTER_OPTIONS_ZH: FilterOption<ChangeFilter>[] = [
  { key: 'all', label: '全部', hint: '不限涨跌' },
  { key: 'up', label: '上涨', hint: '当日涨跌幅大于 0' },
  { key: 'down', label: '下跌', hint: '当日涨跌幅小于 0' },
]

/**
 * 市值档位（**不含「全部」**——多选下拉里「全部」是「一档都不选」，
 * 不是一个可勾的档位，见 MultiSelectFilter 的 allLabel）。
 */
export const CAP_FILTER_OPTIONS_ZH: FilterOption<CapFilter>[] = [
  { key: 'lt50', label: '50亿', hint: '总市值小于 50 亿' },
  { key: 'lt100', label: '100亿', hint: '总市值 50 亿 ~ 100 亿' },
  { key: 'lt300', label: '300亿', hint: '总市值 100 亿 ~ 300 亿' },
  { key: 'lt500', label: '500亿', hint: '总市值 300 亿 ~ 500 亿' },
  { key: 'lt1000', label: '1000亿', hint: '总市值 500 亿 ~ 1000 亿' },
  { key: 'gt1000', label: '其他', hint: '总市值 1000 亿以上' },
]

const YI = 1e8

/** 总市值落在哪一档。库里有市值缺失（新股）→ 只在「不限」里出现。 */
export function capBucketOf(cap: number | null | undefined): CapFilter | null {
  if (cap == null || cap <= 0) return null
  const value = cap / YI
  if (value < 50) return 'lt50'
  if (value < 100) return 'lt100'
  if (value < 300) return 'lt300'
  if (value < 500) return 'lt500'
  if (value < 1000) return 'lt1000'
  return 'gt1000'
}

/** 市值（多选）：空数组 = 不限；否则命中任一档即可。 */
export function matchCap(cap: number | null | undefined, filters: CapFilter[]): boolean {
  if (filters.length === 0) return true
  const bucket = capBucketOf(cap)
  return bucket != null && filters.includes(bucket)
}

/** 涨跌：平盘（0.00%）既不算上涨也不算下跌，所以「上涨/下跌」两档都选不中它。 */
export function matchChange(pct: number | null | undefined, filter: ChangeFilter): boolean {
  if (filter === 'all') return true
  if (pct == null) return false
  return filter === 'up' ? pct > 0 : pct < 0
}

/** 状态：未选任何动作 = 不限；选了则命中其一即可。 */
export function matchStatus(action: string | null | undefined, selected: string[]): boolean {
  if (selected.length === 0) return true
  if (!action) return false
  return selected.includes(action)
}

/**
 * 一行是否通过全部筛选。
 *
 * ``actionOf`` 由页面注入（它才知道怎么把库里的 tech_* 还原成动作），
 * 组件这边不重算口径 —— 否则筛出来的集合与状态列显示的徽章可能不是同一批。
 */
export function passesMarketFilters(
  row: MarketRow,
  board: BoardKey,
  query: string,
  filters: MarketTableFilters,
  actionOf?: (row: MarketRow) => string | null,
): boolean {
  if (board !== 'all' && row.board !== board) return false
  if (!stockMatchesSearch(row, query)) return false
  if (!matchChange(row.change_pct, filters.change)) return false
  if (!matchCap(row.total_market_cap, filters.cap)) return false
  return matchStatus(actionOf ? actionOf(row) : null, filters.status)
}

/** 全量过滤（板块 + 搜索 + 三组筛选）。 */
export function filterMarketRows(
  rows: MarketRow[],
  board: BoardKey,
  query: string,
  filters: MarketTableFilters,
  actionOf?: (row: MarketRow) => string | null,
): MarketRow[] {
  return rows.filter(row => passesMarketFilters(row, board, query, filters, actionOf))
}

/** 除板块外的筛选是否处于「不限」状态。 */
export function hasActiveFilters(filters: MarketTableFilters): boolean {
  return filters.status.length > 0 || filters.change !== 'all' || filters.cap.length > 0
}

/**
 * 「清空筛选」要连**市场**（板块 pill）一起复位 —— 用户明确要求
 * （「清空筛选 把市场也加进去」），所以只要有任意一组生效就显示这个入口。
 */
export function hasAnyFilterActive(board: BoardKey, filters: MarketTableFilters): boolean {
  return board !== 'all' || hasActiveFilters(filters)
}
