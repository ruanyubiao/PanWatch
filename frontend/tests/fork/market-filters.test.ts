import { describe, expect, it, vi } from 'vitest'
import {
  CAP_FILTER_OPTIONS_ZH,
  CHANGE_FILTER_OPTIONS_ZH,
  EMPTY_MARKET_FILTERS,
  INDICATOR_FILTER_KEYS,
  TRADE_STATUS_FILTER_OPTIONS_ZH,
  capBucketOf,
  filterMarketRows,
  hasActiveFilters,
  hasAnyFilterActive,
  matchCap,
  matchChange,
  matchIndicator,
  matchTradeStatus,
  tradeStatusKeyOf,
  type MarketTableFilters,
} from '@/lib/market-filters'
import { BOARD_OPTIONS } from '@/lib/board-classify'
import { originalStockName } from '@/lib/stock-name'
import type { MarketRow } from '@/lib/fork-kline-summary'

/**
 * 分析页筛选组的口径钉在这里：
 *   - 市值分档：50亿 = **小于** 50 亿，往上每档是「上一档 ~ 本档」，「其他」= 1000 亿以上
 *   - 市值 / 指标 / 状态都是**多选**：一项都不选 = 不限，选了若干 = 并集（命中任一即可）
 *   - 涨跌：平盘既不算涨也不算跌
 *   - 「清空筛选」要连**市场**（板块下拉）一起复位 → hasAnyFilterActive(board, filters)
 *   - 板块选项顺序：全部 / 上证 / 深证 / **创业** / **科创** / ST
 *   - 2026-10-20 第 4/6 条：技术面那组从「状态」改名「指标」；新增**交易日状态**
 *     （正常 / 停牌 / ST / *ST / 退市 / 新股 / 其他），筛的是 `status_code`。
 */

const row = (over: Partial<MarketRow> = {}): MarketRow => ({
  code: '600519',
  symbol: 'sh600519',
  exchange: 'SH',
  name: '贵州茅台',
  board: 'sh',
  trade_date: '2026-10-14',
  pre_close: 1286,
  open: 1280,
  close: 1290.5,
  high: 1299,
  low: 1276,
  change_amount: 4.5,
  change_pct: 0.35,
  total_market_cap: 1607604938886,
  source: 'sina',
  adj_factor: 1,
  ma: { ma5: null, ma10: null, ma20: null, ma60: null },
  tech: null,
  ...over,
})

/** 只覆盖想测的那几组，其余用「不限」。 */
const F = (over: Partial<MarketTableFilters> = {}): MarketTableFilters => ({
  ...EMPTY_MARKET_FILTERS,
  ...over,
})

const YI = 1e8

describe('fork: 板块选项的顺序', () => {
  it('全部 / 上证 / 深证 / 创业 / 科创（第 8 条把 ST 去掉了：ST 由「全部状态」表达）', () => {
    const keys: string[] = BOARD_OPTIONS.map(option => String(option.key))
    const labels: string[] = BOARD_OPTIONS.map(option => option.label)
    expect(keys).toEqual(['sh', 'sz', 'cyb', 'kcb'])
    expect(labels).toEqual(['上证', '深证', '创业', '科创'])
    // 类型上 'st' 仍在（后端与 classifyBoard 还会把 ST 标出来），只是下拉不再给入口
    expect(keys).not.toContain('st')
  })
})

describe('fork: 市值分档（多选）', () => {
  it('「50亿」= 小于 50 亿，往上每档是上一档到本档，其他 = 1000 亿以上', () => {
    expect(capBucketOf(10 * YI)).toBe('lt50')
    expect(capBucketOf(49.99 * YI)).toBe('lt50')
    expect(capBucketOf(50 * YI)).toBe('lt100')
    expect(capBucketOf(99 * YI)).toBe('lt100')
    expect(capBucketOf(100 * YI)).toBe('lt300')
    expect(capBucketOf(300 * YI)).toBe('lt500')
    expect(capBucketOf(500 * YI)).toBe('lt1000')
    expect(capBucketOf(1000 * YI)).toBe('gt1000')
    expect(capBucketOf(3000 * YI)).toBe('gt1000')

    expect(matchCap(10 * YI, ['lt50'])).toBe(true)
    expect(matchCap(50 * YI, ['lt50'])).toBe(false)
    expect(matchCap(500 * YI, ['lt1000'])).toBe(true)
    expect(matchCap(999 * YI, ['gt1000'])).toBe(false)
  })

  it('一档都不选 = 不限；勾多档 = 并集', () => {
    expect(matchCap(10 * YI, [])).toBe(true)
    expect(matchCap(3000 * YI, [])).toBe(true)
    expect(matchCap(30 * YI, ['lt50', 'gt1000'])).toBe(true)
    expect(matchCap(2000 * YI, ['lt50', 'gt1000'])).toBe(true)
    expect(matchCap(200 * YI, ['lt50', 'gt1000'])).toBe(false)
  })

  it('缺市值（新股）只在「不限」里出现', () => {
    expect(matchCap(null, [])).toBe(true)
    expect(matchCap(null, ['lt50'])).toBe(false)
    expect(matchCap(0, ['lt50'])).toBe(false)
  })

  it('档位文案是用户给的顺序；「全部」不是档位（它是多选下拉的 allLabel）', () => {
    expect(CAP_FILTER_OPTIONS_ZH.map(o => o.label)).toEqual([
      '50亿',
      '100亿',
      '300亿',
      '500亿',
      '1000亿',
      '其他',
    ])
  })
})

describe('fork: 涨跌 / 指标 / 状态', () => {
  it('平盘既不算上涨也不算下跌', () => {
    expect(matchChange(0, 'all')).toBe(true)
    expect(matchChange(0, 'up')).toBe(false)
    expect(matchChange(0, 'down')).toBe(false)
    expect(matchChange(1.2, 'up')).toBe(true)
    expect(matchChange(-1.2, 'down')).toBe(true)
    expect(matchChange(null, 'up')).toBe(false)
    expect(CHANGE_FILTER_OPTIONS_ZH.map(o => o.label)).toEqual(['全部', '上涨', '下跌'])
  })

  it('指标（原「状态」）是多选：空 = 不限，选了命中其一即可', () => {
    expect(INDICATOR_FILTER_KEYS).toEqual(['buy', 'avoid', 'watch'])
    expect(matchIndicator('avoid', [])).toBe(true)
    expect(matchIndicator('avoid', ['avoid', 'buy'])).toBe(true)
    expect(matchIndicator('watch', ['avoid', 'buy'])).toBe(false)
    // 无 tech_* 的（新股）动作为空 → 只在「不限」里出现
    expect(matchIndicator(null, [])).toBe(true)
    expect(matchIndicator(null, ['buy'])).toBe(false)
  })

  it('交易日状态：status_code → 筛选键，缺省按「正常」', () => {
    expect(tradeStatusKeyOf(row({ status_code: 'SUSPENDED' }))).toBe('suspended')
    expect(tradeStatusKeyOf(row({ status_code: 'ST' }))).toBe('st')
    expect(tradeStatusKeyOf(row({ status_code: 'STAR_ST' }))).toBe('star_st')
    expect(tradeStatusKeyOf(row({ status_code: 'DELISTING' }))).toBe('delisting')
    expect(tradeStatusKeyOf(row({ status_code: 'DELIST_PENDING' }))).toBe('delisting')
    expect(tradeStatusKeyOf(row({ status_code: 'NEW_LISTING' }))).toBe('new_listing')
    expect(tradeStatusKeyOf(row({ status_code: 'NORMAL' }))).toBe('normal')
    // 老响应没有这个字段 → 正常
    expect(tradeStatusKeyOf(row({}))).toBe('normal')
    expect(tradeStatusKeyOf(row({ status_code: null }))).toBe('normal')
    // 没见过的状态码 → 其他（不冒充「正常」）
    expect(tradeStatusKeyOf(row({ status_code: 'SOMETHING_NEW' }))).toBe('other')
  })

  it('交易日状态多选：空 = 不限，选了命中其一即可', () => {
    const suspended = row({ status_code: 'SUSPENDED' })
    const normal = row({ status_code: 'NORMAL' })
    expect(matchTradeStatus(suspended, [])).toBe(true)
    expect(matchTradeStatus(suspended, ['suspended'])).toBe(true)
    expect(matchTradeStatus(suspended, ['normal'])).toBe(false)
    expect(matchTradeStatus(normal, ['suspended', 'normal'])).toBe(true)
  })

  it('状态下拉的选项文案与顺序（正常 / 停牌 / ST / *ST / 退市 / 新股 / 其他）', () => {
    expect(TRADE_STATUS_FILTER_OPTIONS_ZH.map(o => o.key)).toEqual([
      'normal',
      'suspended',
      'st',
      'star_st',
      'delisting',
      'new_listing',
      'other',
    ])
    expect(TRADE_STATUS_FILTER_OPTIONS_ZH.map(o => o.label)).toEqual([
      '正常',
      '停牌',
      'ST',
      '*ST',
      '退市',
      '新股',
      '其他',
    ])
  })

  it('hasActiveFilters 只看四组筛选（不含市场）', () => {
    expect(hasActiveFilters(EMPTY_MARKET_FILTERS)).toBe(false)
    expect(hasActiveFilters(F({ indicator: ['buy'] }))).toBe(true)
    expect(hasActiveFilters(F({ change: 'down' }))).toBe(true)
    expect(hasActiveFilters(F({ cap: ['lt50'] }))).toBe(true)
    expect(hasActiveFilters(F({ tradeStatus: ['suspended'] }))).toBe(true)
  })

  it('hasAnyFilterActive 把市场也算进来（「清空筛选」要连市场一起复位）', () => {
    expect(hasAnyFilterActive('all', EMPTY_MARKET_FILTERS)).toBe(false)
    expect(hasAnyFilterActive('cyb', EMPTY_MARKET_FILTERS)).toBe(true)
    expect(hasAnyFilterActive('all', F({ cap: ['lt50'] }))).toBe(true)
  })
})

describe('fork: 组合过滤', () => {
  const rows = [
    row({ code: '600519', board: 'sh', total_market_cap: 1607 * YI, change_pct: 0.35 }),
    row({
      code: '000001',
      board: 'sz',
      name: '平安银行',
      total_market_cap: 2249 * YI,
      change_pct: -1.61,
      status_code: 'SUSPENDED',
    }),
    row({
      code: '920000',
      board: 'other',
      name: '安徽凤凰',
      total_market_cap: 10 * YI,
      change_pct: -1.6,
      status_code: 'ST',
    }),
  ]

  it('板块 + 搜索 + 四组筛选一起生效', () => {
    expect(filterMarketRows(rows, 'all', '', EMPTY_MARKET_FILTERS).map(r => r.code)).toEqual([
      '600519',
      '000001',
      '920000',
    ])
    expect(filterMarketRows(rows, 'sh', '', EMPTY_MARKET_FILTERS).map(r => r.code)).toEqual(['600519'])
    expect(filterMarketRows(rows, 'all', '平安', EMPTY_MARKET_FILTERS).map(r => r.code)).toEqual(['000001'])
    expect(filterMarketRows(rows, 'all', '', F({ change: 'down' })).map(r => r.code)).toEqual([
      '000001',
      '920000',
    ])
    expect(filterMarketRows(rows, 'all', '', F({ cap: ['lt50'] })).map(r => r.code)).toEqual(['920000'])
    // 多选 = 并集（先看两档各自命中谁，并起来就是两份之和）
    expect(filterMarketRows(rows, 'all', '', F({ cap: ['gt1000'] })).map(r => r.code)).toEqual([
      '600519',
      '000001',
    ])
    expect(filterMarketRows(rows, 'all', '', F({ cap: ['lt50', 'gt1000'] })).map(r => r.code)).toEqual([
      '600519',
      '000001',
      '920000',
    ])
  })

  it('状态筛选（交易日状态）：停牌 / ST 各命中一只', () => {
    expect(filterMarketRows(rows, 'all', '', F({ tradeStatus: ['suspended'] })).map(r => r.code)).toEqual([
      '000001',
    ])
    expect(filterMarketRows(rows, 'all', '', F({ tradeStatus: ['st'] })).map(r => r.code)).toEqual(['920000'])
    expect(
      filterMarketRows(rows, 'all', '', F({ tradeStatus: ['suspended', 'st'] })).map(r => r.code),
    ).toEqual(['000001', '920000'])
    expect(filterMarketRows(rows, 'all', '', F({ tradeStatus: ['normal'] })).map(r => r.code)).toEqual([
      '600519',
    ])
  })

  it('指标筛选走页面注入的 actionOf（保证与徽章同源）', () => {
    const actionOf = (r: MarketRow) => (r.code === '600519' ? 'buy' : r.code === '000001' ? 'avoid' : null)
    expect(
      filterMarketRows(rows, 'all', '', F({ indicator: ['avoid'] }), actionOf).map(r => r.code),
    ).toEqual(['000001'])
    // 多选指标 = 并集
    expect(
      filterMarketRows(rows, 'all', '', F({ indicator: ['buy', 'avoid'] }), actionOf).map(r => r.code),
    ).toEqual(['600519', '000001'])
    // 没传 actionOf 时指标筛选不会把所有行都滤掉（空数组 = 不限）
    expect(filterMarketRows(rows, 'all', '', EMPTY_MARKET_FILTERS).length).toBe(3)
  })

  it('指标未选时不调用 actionOf，避免搜索时对全市场重算技术面', () => {
    const actionOf = vi.fn(() => 'buy')
    expect(filterMarketRows(rows, 'all', '茅台', EMPTY_MARKET_FILTERS, actionOf).map(r => r.code)).toEqual([
      '600519',
    ])
    expect(actionOf).not.toHaveBeenCalled()
  })
})

describe('fork: 原始名字', () => {
  it('剥掉 *ST / S*ST / SST / ST 前缀', () => {
    expect(originalStockName('*ST闻泰')).toBe('闻泰')
    expect(originalStockName('ST人福')).toBe('人福')
    expect(originalStockName('SST前锋')).toBe('前锋')
    expect(originalStockName('S*ST佳通')).toBe('佳通')
  })

  it('不带标记的名字原样返回；名字恰好等于标记时不剥成空串', () => {
    expect(originalStockName('贵州茅台')).toBe('贵州茅台')
    expect(originalStockName('ST')).toBe('ST')
    expect(originalStockName('STAR')).toBe('AR')
    expect(originalStockName(null)).toBe('')
    expect(originalStockName(undefined)).toBe('')
  })
})
