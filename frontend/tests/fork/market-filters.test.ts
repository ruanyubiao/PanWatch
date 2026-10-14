import { describe, expect, it } from 'vitest'
import {
  CAP_FILTER_OPTIONS_ZH,
  CHANGE_FILTER_OPTIONS_ZH,
  EMPTY_MARKET_FILTERS,
  STATUS_FILTER_KEYS,
  filterMarketRows,
  hasActiveFilters,
  matchCap,
  matchChange,
  matchStatus,
} from '@/lib/market-filters'
import { originalStockName } from '@/lib/stock-name'
import type { MarketRow } from '@/lib/fork-kline-summary'

/**
 * 分析页筛选组（用户第 9 条）与「原始名字」（第 3 条）的口径钉在这里：
 *   - 市值分档：50亿 = **小于** 50 亿，往上每档是「上一档 ~ 本档」，「其他」= 1000 亿以上
 *   - 涨跌：平盘既不算涨也不算跌
 *   - 状态：多选，空 = 不限
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

const YI = 1e8

describe('fork: 市值分档', () => {
  it('「50亿」= 小于 50 亿，往上每档是上一档到本档，其他 = 1000 亿以上', () => {
    expect(matchCap(10 * YI, 'lt50')).toBe(true)
    expect(matchCap(49.99 * YI, 'lt50')).toBe(true)
    expect(matchCap(50 * YI, 'lt50')).toBe(false)

    expect(matchCap(50 * YI, 'lt100')).toBe(true)
    expect(matchCap(99 * YI, 'lt100')).toBe(true)
    expect(matchCap(100 * YI, 'lt100')).toBe(false)

    expect(matchCap(100 * YI, 'lt300')).toBe(true)
    expect(matchCap(300 * YI, 'lt300')).toBe(false)
    expect(matchCap(300 * YI, 'lt500')).toBe(true)
    expect(matchCap(500 * YI, 'lt500')).toBe(false)
    expect(matchCap(500 * YI, 'lt1000')).toBe(true)
    expect(matchCap(1000 * YI, 'lt1000')).toBe(false)

    expect(matchCap(1000 * YI, 'gt1000')).toBe(true)
    expect(matchCap(3000 * YI, 'gt1000')).toBe(true)
    expect(matchCap(999 * YI, 'gt1000')).toBe(false)
  })

  it('缺市值（新股）只在「全部」里出现', () => {
    expect(matchCap(null, 'all')).toBe(true)
    expect(matchCap(null, 'lt50')).toBe(false)
    expect(matchCap(0, 'lt50')).toBe(false)
  })

  it('选项文案是用户给的顺序', () => {
    expect(CAP_FILTER_OPTIONS_ZH.map(o => o.label)).toEqual([
      '全部',
      '50亿',
      '100亿',
      '300亿',
      '500亿',
      '1000亿',
      '其他',
    ])
  })
})

describe('fork: 涨跌与状态', () => {
  it('平盘既不算上涨也不算下跌', () => {
    expect(matchChange(0, 'all')).toBe(true)
    expect(matchChange(0, 'up')).toBe(false)
    expect(matchChange(0, 'down')).toBe(false)
    expect(matchChange(1.2, 'up')).toBe(true)
    expect(matchChange(-1.2, 'down')).toBe(true)
    expect(matchChange(null, 'up')).toBe(false)
    expect(CHANGE_FILTER_OPTIONS_ZH.map(o => o.label)).toEqual(['全部', '上涨', '下跌'])
  })

  it('状态是多选：空 = 不限，选了命中其一即可', () => {
    expect(STATUS_FILTER_KEYS).toEqual(['buy', 'avoid', 'watch'])
    expect(matchStatus('avoid', [])).toBe(true)
    expect(matchStatus('avoid', ['avoid', 'buy'])).toBe(true)
    expect(matchStatus('watch', ['avoid', 'buy'])).toBe(false)
    // 无 tech_* 的（新股）动作为空 → 只在「全部」里出现
    expect(matchStatus(null, [])).toBe(true)
    expect(matchStatus(null, ['buy'])).toBe(false)
  })

  it('hasActiveFilters 只看三组筛选', () => {
    expect(hasActiveFilters(EMPTY_MARKET_FILTERS)).toBe(false)
    expect(hasActiveFilters({ status: ['buy'], change: 'all', cap: 'all' })).toBe(true)
    expect(hasActiveFilters({ status: [], change: 'down', cap: 'all' })).toBe(true)
    expect(hasActiveFilters({ status: [], change: 'all', cap: 'lt50' })).toBe(true)
  })
})

describe('fork: 组合过滤', () => {
  const rows = [
    row({ code: '600519', board: 'sh', total_market_cap: 1607 * YI, change_pct: 0.35 }),
    row({ code: '000001', board: 'sz', name: '平安银行', total_market_cap: 2249 * YI, change_pct: -1.61 }),
    row({ code: '920000', board: 'other', name: '安徽凤凰', total_market_cap: 10 * YI, change_pct: -1.6 }),
  ]

  it('板块 + 搜索 + 三组筛选一起生效', () => {
    expect(filterMarketRows(rows, 'all', '', EMPTY_MARKET_FILTERS).map(r => r.code)).toEqual([
      '600519',
      '000001',
      '920000',
    ])
    expect(filterMarketRows(rows, 'sh', '', EMPTY_MARKET_FILTERS).map(r => r.code)).toEqual(['600519'])
    expect(filterMarketRows(rows, 'all', '平安', EMPTY_MARKET_FILTERS).map(r => r.code)).toEqual(['000001'])
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'down', cap: 'all' }).map(r => r.code),
    ).toEqual(['000001', '920000'])
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: 'lt50' }).map(r => r.code),
    ).toEqual(['920000'])
  })

  it('状态筛选走页面注入的 actionOf（保证与徽章同源）', () => {
    const actionOf = (r: MarketRow) => (r.code === '600519' ? 'buy' : r.code === '000001' ? 'avoid' : null)
    expect(
      filterMarketRows(rows, 'all', '', { status: ['avoid'], change: 'all', cap: 'all' }, actionOf).map(
        r => r.code,
      ),
    ).toEqual(['000001'])
    // 没传 actionOf 时状态筛选不会把所有行都滤掉（空数组 = 不限）
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: 'all' }).length,
    ).toBe(3)
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
