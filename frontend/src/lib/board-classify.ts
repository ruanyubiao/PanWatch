/**
 * A 股板块归类（fork 专用）
 *
 * 上游「持仓/关注」页的筛选只有 全部 / A股 / 港股 / 美股（按 market 字段）。
 * fork 的分析页把它拆成两组：
 *   - 数据范围：关注（我的自选，仅股票）/ 全部（A 股全市场，仅股票）
 *   - 板块：上证 / 深证 / 科创 / 创业 / ST
 * 本文件只负责「板块」这一组；ETF 不参与 fork 页（只服务股票）。
 *
 * 判定完全基于代码前缀与名称，不依赖后端新增字段。后端
 * ``src/modules/market/api/fork_market.py`` 的 ``_BOARD_CASE`` 是同一套规则
 * （认 6 位数字代码，不认 sh/sz/bj 前缀）。改这里必须同步改那边。
 *
 * 归类是互斥的，优先级：ST > 科创 > 创业 > 上证 > 深证。
 * （ST 优先是刻意的：ST 是风险标记，用户点「ST」是想单独把这批票挑出来看。）
 */

export type BoardKey = 'all' | 'sh' | 'sz' | 'kcb' | 'cyb' | 'st'

export interface BoardOption {
  key: BoardKey
  label: string
}

/**
 * 顺序即界面上市场下拉的选项顺序（不含 'all'——「全部」是下拉的第一项）。
 *
 * 用户第二轮指定：全部 / 上证 / 深证 / **创业** / **科创** / ST
 * （创业在科创前面，与常见的「沪、深、创、科」一致）。
 *
 * 第 8 条（2026-10-20 晚）：**去掉 ST 这一项** —— ST 已经由「全部状态」筛选
 * （正常 / 停牌 / ST / *ST / 退市 / 新股）和表格的状态列表达，市场维度只按交易所分。
 * ``BoardKey`` 里的 'st' 仍保留：后端的板块判定与 ``classifyBoard`` 仍会把 ST 标出来，
 * 只是下拉里不再给这个入口。
 */
const BOARD_LABELS_ZH = {
  sh: '上证',
  sz: '深证',
  cyb: '创业',
  kcb: '科创',
}

export const BOARD_OPTIONS: BoardOption[] = [
  { key: 'sh', label: BOARD_LABELS_ZH.sh },
  { key: 'sz', label: BOARD_LABELS_ZH.sz },
  { key: 'cyb', label: BOARD_LABELS_ZH.cyb },
  { key: 'kcb', label: BOARD_LABELS_ZH.kcb },
]

interface BoardClassifiable {
  symbol?: string | null
  name?: string | null
  asset_type?: string | null
  market?: string | null
}

/** 名称里出现即视为 ST（含 *ST、SST、S*ST 等变体）。 */
export function isStName(name?: string | null): boolean {
  const n = String(name || '').toUpperCase().replace(/\s/g, '')
  return n.includes('ST')
}

export function isEtf(stock: BoardClassifiable): boolean {
  return String(stock.asset_type || '').toLowerCase() === 'etf'
}

/** 返回板块 key；'all' 表示不属于任何板块（北交所、非 A 股等）。 */
export function classifyBoard(stock: BoardClassifiable): BoardKey {
  // 行情库 symbol 带 sh/sz/bj 前缀；板块规则认的是 6 位数字代码（与后端 i.code 一致）。
  // 不剥 HK：00700 本身就以 00 开头，剥掉 HK 会把港股误判成深证。
  const symbol = String(stock.symbol || '').trim().replace(/^(sh|sz|bj)(?=\d)/i, '')
  const market = String(stock.market || '').toUpperCase()

  if (isStName(stock.name)) return 'st'
  if (isEtf(stock)) return 'all'
  // 非 A 股（港股/美股）不参与板块归类。
  if (market && market !== 'CN') return 'all'

  if (symbol.startsWith('688') || symbol.startsWith('689')) return 'kcb'
  if (symbol.startsWith('300') || symbol.startsWith('301')) return 'cyb'
  if (symbol.startsWith('60')) return 'sh'
  // 002xxx/003xxx 是深市主板；302xxx 是 2025 年起深市主板的新号段
  if (symbol.startsWith('00') || symbol.startsWith('302')) return 'sz'

  return 'all'
}

/** 某个板块筛选下的匹配判断（'all' 恒为真）。 */
export function matchesBoard(stock: BoardClassifiable, board: BoardKey): boolean {
  if (board === 'all') return true
  return classifyBoard(stock) === board
}

/** fork 的「关注」范围：只含股票，不含 ETF。 */
export function onlyStocks<T extends BoardClassifiable>(stocks: T[]): T[] {
  return stocks.filter(stock => !isEtf(stock))
}

/**
 * fork 分析页「关注」范围实际使用：只含 A 股股票。
 * 本页只服务 A 股（港股/美股 pills 已删除），所以自选里的 00700/AAPL
 * 这类标的也不再出现在列表里（数据仍留在库里，只是不展示）。
 */
export function onlyAShares<T extends BoardClassifiable>(stocks: T[]): T[] {
  return stocks.filter(
    stock => !isEtf(stock) && String(stock.market || '').toUpperCase() === 'CN',
  )
}

/** 统计每个板块的数量，用于市场下拉每一行的计数。 */
export function countByBoard(stocks: BoardClassifiable[]): Record<BoardKey, number> {
  const out: Record<BoardKey, number> = { all: stocks.length, sh: 0, sz: 0, kcb: 0, cyb: 0, st: 0 }
  for (const s of stocks) {
    const key = classifyBoard(s)
    if (key !== 'all') out[key] += 1
  }
  return out
}
