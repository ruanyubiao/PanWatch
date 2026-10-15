import { describe, expect, it, vi } from 'vitest'
import {
  CAP_FILTER_OPTIONS_ZH,
  CHANGE_FILTER_OPTIONS_ZH,
  EMPTY_MARKET_FILTERS,
  STATUS_FILTER_KEYS,
  capBucketOf,
  filterMarketRows,
  hasActiveFilters,
  hasAnyFilterActive,
  matchCap,
  matchChange,
  matchStatus,
} from '@/lib/market-filters'
import { BOARD_OPTIONS } from '@/lib/board-classify'
import { originalStockName } from '@/lib/stock-name'
import type { MarketRow } from '@/lib/fork-kline-summary'

/**
 * 分析页筛选组（用户第 9 条 + 第二轮把控件改成「机会页那套下拉」）与
 * 「原始名字」（第 3 条）的口径钉在这里：
 *   - 市值分档：50亿 = **小于** 50 亿，往上每档是「上一档 ~ 本档」，「其他」= 1000 亿以上
 *   - 市值与状态都是**多选**：一档都不选 = 不限，选了若干 = 并集（命中任一即可）
 *   - 涨跌：平盘既不算涨也不算跌
 *   - 「清空筛选」要连**市场**（板块下拉）一起复位 → hasAnyFilterActive(board, filters)
 *   - 板块选项顺序：全部 / 上证 / 深证 / **创业** / **科创** / ST
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

describe('fork: 板块选项的顺序', () => {
  it('全部 / 上证 / 深证 / 创业 / 科创 / ST（「全部」由范围那一格单独渲染）', () => {
    expect(BOARD_OPTIONS.map(o => o.key)).toEqual(['sh', 'sz', 'cyb', 'kcb', 'st'])
    expect(BOARD_OPTIONS.map(o => o.label)).toEqual(['上证', '深证', '创业', '科创', 'ST'])
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
    // 无 tech_* 的（新股）动作为空 → 只在「不限」里出现
    expect(matchStatus(null, [])).toBe(true)
    expect(matchStatus(null, ['buy'])).toBe(false)
  })

  it('hasActiveFilters 只看三组筛选（不含市场）', () => {
    expect(hasActiveFilters(EMPTY_MARKET_FILTERS)).toBe(false)
    expect(hasActiveFilters({ status: ['buy'], change: 'all', cap: [] })).toBe(true)
    expect(hasActiveFilters({ status: [], change: 'down', cap: [] })).toBe(true)
    expect(hasActiveFilters({ status: [], change: 'all', cap: ['lt50'] })).toBe(true)
  })

  it('hasAnyFilterActive 把市场也算进来（「清空筛选」要连市场一起复位）', () => {
    expect(hasAnyFilterActive('all', EMPTY_MARKET_FILTERS)).toBe(false)
    expect(hasAnyFilterActive('cyb', EMPTY_MARKET_FILTERS)).toBe(true)
    expect(hasAnyFilterActive('all', { status: [], change: 'all', cap: ['lt50'] })).toBe(true)
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
      filterMarketRows(rows, 'all', '', { status: [], change: 'down', cap: [] }).map(r => r.code),
    ).toEqual(['000001', '920000'])
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: ['lt50'] }).map(r => r.code),
    ).toEqual(['920000'])
    // 多选 = 并集（先看两档各自命中谁，并起来就是两份之和）
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: ['gt1000'] }).map(r => r.code),
    ).toEqual(['600519', '000001'])
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: ['lt50'] }).map(r => r.code),
    ).toEqual(['920000'])
    expect(
      filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: ['lt50', 'gt1000'] }).map(r => r.code),
    ).toEqual(['600519', '000001', '920000'])
  })

  it('状态筛选走页面注入的 actionOf（保证与徽章同源）', () => {
    const actionOf = (r: MarketRow) => (r.code === '600519' ? 'buy' : r.code === '000001' ? 'avoid' : null)
    expect(
      filterMarketRows(rows, 'all', '', { status: ['avoid'], change: 'all', cap: [] }, actionOf).map(
        r => r.code,
      ),
    ).toEqual(['000001'])
    // 多选状态 = 并集
    expect(
      filterMarketRows(rows, 'all', '', { status: ['buy', 'avoid'], change: 'all', cap: [] }, actionOf).map(
        r => r.code,
      ),
    ).toEqual(['600519', '000001'])
    // 没传 actionOf 时状态筛选不会把所有行都滤掉（空数组 = 不限）
    expect(filterMarketRows(rows, 'all', '', { status: [], change: 'all', cap: [] }).length).toBe(3)
  })

  it('状态未选时不调用 actionOf，避免搜索时对全市场重算技术面', () => {
    const actionOf = vi.fn(() => 'buy')
    expect(filterMarketRows(rows, 'all', '茅台', EMPTY_MARKET_FILTERS, actionOf).map(r => r.code)).toEqual(['600519'])
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
