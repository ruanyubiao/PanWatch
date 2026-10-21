/**
 * fork 专用：分析页表格的**筛选**（除板块以外的五组，加上市场共六组）。
 *
 * 用户第二轮要求把筛选做成「机会页」那种形式（下拉 + 清空筛选）：
 *   组1 市场   全部 | 上证 | 深证 | 创业 | 科创 | ST  （单选**下拉**，选项带计数，见 board-classify.ts）
 *   组2 指标   全部 | 买入 | 回避 | 观望               （**多选**下拉，技术面结论）
 *   组3 涨跌   全部 | 上涨 | 下跌                       （单选下拉）
 *   组4 市值   全部 | 50亿 | 100亿 | 300亿 | 500亿 | 1000亿 | 其他
 *                                                     （**多选**下拉）
 *              其中「50亿」表示**小于 50 亿**，往上每档是「上一档 ~ 本档」，
 *              「其他」表示 1000 亿以上 —— 与用户给的写法一致。
 *   组5 换手率 全部 | 2% | 5% | 10% | 20% | 其他              （**多选**下拉）
 *              同样是「标签 = 本档上界」：「2%」= 小于 2%，「其他」= 20% 以上。
 *   组6 状态   全部 | 正常 | 停牌 | ST | …                    （**多选**下拉）
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
/**
 * 换手率档位（2026-10 新增）。分档取自云端 2026-10-20 全市场 5577 只的实际分布：
 * <2% 3264 / 2–5% 1610 / 5–10% 478 / 10–20% 180 / ≥20% 45 —— 每档都有一批票，
 * 不像「<1% / ≥30%」那种极端切法会把九成股票挤在一档里。
 */
export type TurnoverFilter = 'lt2' | 'lt5' | 'lt10' | 'lt20' | 'gt20'
/** 交易日状态（停牌 / 正常 / ST …）的筛选键。 */
export type TradeStatusFilter =
  | 'normal'
  | 'suspended'
  | 'st'
  | 'star_st'
  | 'delisting'
  | 'new_listing'
  | 'other'

export interface MarketTableFilters {
  /**
   * 技术面**指标** key（kline-scorer 的 Action）：空数组 = 不限；多选 = 命中其一即可。
   *
   * 2026-10-20 第 4 条把这一组从「状态」改名为「指标」—— 它给出的是买入/回避/观望
   * 这种**技术面结论**，而新增的「状态」列说的是停牌/正常这种**交易日状态**，
   * 两个都叫「状态」会分不清哪个是哪个。
   */
  indicator: string[]
  change: ChangeFilter
  /** 市值档位：空数组 = 不限；多选 = 命中任一档即可 */
  cap: CapFilter[]
  /** 交易日状态：空数组 = 不限；多选 = 命中其一即可 */
  tradeStatus: TradeStatusFilter[]
  /** 换手率档位：空数组 = 不限；多选 = 命中任一档即可 */
  turnover: TurnoverFilter[]
}

export const EMPTY_MARKET_FILTERS: MarketTableFilters = {
  indicator: [],
  change: 'all',
  cap: [],
  tradeStatus: [],
  turnover: [],
}

/**
 * 「指标」组的候选动作 —— 就是指标列里技术面那颗徽章能给出的动作全集
 * （未持仓口径：score≥3 买入 / score≤−2 回避 / 其余观望，见 lib/kline-scorer.ts）。
 * 文案由页面从 bizUi 的 kline.actions.* 取，避免同一个动作两套叫法。
 */
export const INDICATOR_FILTER_KEYS = ['buy', 'avoid', 'watch'] as const

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

/**
 * 换手率档位（**不含「全部」**——多选下拉里「不限」= 一档都不选，与市值组同一套语义）。
 *
 * 写法沿用市值组：标签是**本档的上界**（「5%」= 2% ~ 5%），最后一档叫「其他」。
 * 上限只在悬停提示里写全，否则 104px 的下拉装不下「2% ~ 5%」这类区间文案。
 */
export const TURNOVER_FILTER_OPTIONS_ZH: FilterOption<TurnoverFilter>[] = [
  { key: 'lt2', label: '2%', hint: '换手率小于 2%（含停牌 0%）' },
  { key: 'lt5', label: '5%', hint: '换手率 2% ~ 5%' },
  { key: 'lt10', label: '10%', hint: '换手率 5% ~ 10%' },
  { key: 'lt20', label: '20%', hint: '换手率 10% ~ 20%' },
  { key: 'gt20', label: '其他', hint: '换手率 20% 以上' },
]

/** 换手率落在哪一档。库里缺值（新股当日无成交记录）→ 只在「不限」里出现。 */
export function turnoverBucketOf(rate: number | null | undefined): TurnoverFilter | null {
  if (rate == null) return null
  if (rate < 2) return 'lt2'
  if (rate < 5) return 'lt5'
  if (rate < 10) return 'lt10'
  if (rate < 20) return 'lt20'
  return 'gt20'
}

/** 换手率（多选）：空数组 = 不限；否则命中任一档即可。 */
export function matchTurnover(rate: number | null | undefined, filters: TurnoverFilter[]): boolean {
  if (filters.length === 0) return true
  const bucket = turnoverBucketOf(rate)
  return bucket != null && filters.includes(bucket)
}

/** 涨跌：平盘（0.00%）既不算上涨也不算下跌，所以「上涨/下跌」两档都选不中它。 */
export function matchChange(pct: number | null | undefined, filter: ChangeFilter): boolean {
  if (filter === 'all') return true
  if (pct == null) return false
  return filter === 'up' ? pct > 0 : pct < 0
}

/**
 * 「指标」组：未选任何动作 = 不限；选了则命中其一即可。
 */
export function matchIndicator(action: string | null | undefined, selected: string[]): boolean {
  if (selected.length === 0) return true
  if (!action) return false
  return selected.includes(action)
}

/**
 * 交易日状态的筛选项（用户反馈 2026-10-20 第 6 条：放在「全部市值」后面）。
 *
 * 「正常」是缺省值 —— 库里没有状态行的股票就是正常交易；停牌、ST 这几档来自
 * 行情库的 ``stock_status_daily``（由管道的状态作业写入），前端只做展示与筛选。
 */
export const TRADE_STATUS_FILTER_OPTIONS_ZH: FilterOption<TradeStatusFilter>[] = [
  { key: 'normal', label: '正常', hint: '当日正常交易' },
  { key: 'suspended', label: '停牌', hint: '全天停牌（当日无成交）' },
  { key: 'st', label: 'ST', hint: '其他风险警示（简称含 ST）' },
  { key: 'star_st', label: '*ST', hint: '退市风险警示（简称含 *ST）' },
  { key: 'delisting', label: '退市', hint: '退市整理期 / 摘牌待定' },
  { key: 'new_listing', label: '新股', hint: '上市首日' },
  { key: 'other', label: '其他', hint: '暂无状态记录的其它情形' },
]

/** 库里的状态码 → 筛选键。缺省（没有状态行）按正常交易。 */
const TRADE_STATUS_KEY_BY_CODE: Record<string, TradeStatusFilter> = {
  NORMAL: 'normal',
  SUSPENDED: 'suspended',
  ST: 'st',
  STAR_ST: 'star_st',
  DELISTING: 'delisting',
  DELIST_PENDING: 'delisting',
  DELISTED: 'delisting',
  NEW_LISTING: 'new_listing',
}

/** 一行属于哪一档状态（筛选用；与「状态」列显示的那个标签同源）。 */
export function tradeStatusKeyOf(row: MarketRow): TradeStatusFilter {
  const code = String(row.status_code || 'NORMAL').trim().toUpperCase()
  return TRADE_STATUS_KEY_BY_CODE[code] ?? 'other'
}

/** 交易日状态（多选）：空数组 = 不限；否则命中任一档即可。 */
export function matchTradeStatus(row: MarketRow, selected: TradeStatusFilter[]): boolean {
  if (selected.length === 0) return true
  return selected.includes(tradeStatusKeyOf(row))
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
  if (!matchTurnover(row.turnover_rate, filters.turnover)) return false
  if (!matchTradeStatus(row, filters.tradeStatus)) return false
  // 指标未选 = 不限。先判断再调用 actionOf，否则每次搜索都会对全市场逐行重算技术面。
  if (filters.indicator.length === 0) return true
  return matchIndicator(actionOf ? actionOf(row) : null, filters.indicator)
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
  return (
    filters.indicator.length > 0 ||
    filters.change !== 'all' ||
    filters.cap.length > 0 ||
    filters.turnover.length > 0 ||
    filters.tradeStatus.length > 0
  )
}

/**
 * 「清空筛选」要连**市场**（板块下拉）一起复位 —— 用户明确要求
 * （「清空筛选 把市场也加进去」），所以只要有任意一组生效就显示这个入口。
 */
export function hasAnyFilterActive(board: BoardKey, filters: MarketTableFilters): boolean {
  return board !== 'all' || hasActiveFilters(filters)
}
