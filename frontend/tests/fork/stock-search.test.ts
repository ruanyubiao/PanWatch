import { describe, expect, it } from 'vitest'
import { buildStockSearchText, stockMatchesSearch } from '@/lib/stock-search'
import { paginationItems } from '@/components/fork/TablePagination'
import { nextSortState, DEFAULT_SORT } from '@/components/fork/StockMarketTable'

/**
 * fork 分析页表格的三块纯逻辑：
 *   1. 搜索（Everything 语法库 + 「代码 + 名称」合并匹配）
 *   2. 分页页码序列（截图 2 那种 1 2 3 … N 的形式）
 *   3. 表头排序的默认方向
 */

describe('stock-search：代码 + 名称合并匹配（Everything 语法）', () => {
  const maotai = { code: '600519', symbol: 'sh600519', name: '贵州茅台' }
  const pingan = { code: '000001', symbol: 'sz000001', name: '平安银行' }
  const st = { code: '600145', symbol: 'sh600145', name: 'ST新亿' }

  it('匹配文本 = 代码 + 空格 + 名称', () => {
    expect(buildStockSearchText(maotai)).toBe('600519 贵州茅台')
  })

  it('只有 symbol 的行（自选列表）也能剥出 6 位代码', () => {
    expect(buildStockSearchText({ symbol: 'sz000001', name: '平安银行' })).toBe('000001 平安银行')
  })

  it('空格 = 与（AND），且允许一半落在代码、一半落在名称', () => {
    expect(stockMatchesSearch(maotai, '600519 茅台')).toBe(true)
    expect(stockMatchesSearch(maotai, '601 平安')).toBe(false)
    expect(stockMatchesSearch(pingan, '000001 平安')).toBe(true)
  })

  it('| = 或；! = 非', () => {
    expect(stockMatchesSearch(maotai, '平安|茅台')).toBe(true)
    expect(stockMatchesSearch(pingan, '平安|茅台')).toBe(true)
    expect(stockMatchesSearch(st, '平安|茅台')).toBe(false)
    expect(stockMatchesSearch(st, '!ST')).toBe(false)
    expect(stockMatchesSearch(maotai, '!ST')).toBe(true)
  })

  it('通配与短语', () => {
    expect(stockMatchesSearch(maotai, '6005*')).toBe(true)
    expect(stockMatchesSearch(maotai, '60051?')).toBe(true)
    expect(stockMatchesSearch(maotai, '"贵州茅台"')).toBe(true)
    expect(stockMatchesSearch(maotai, '"贵州"')).toBe(true)
  })

  it('空查询不过滤；中文弯引号与全角问号会被库自己归一化', () => {
    expect(stockMatchesSearch(maotai, '')).toBe(true)
    expect(stockMatchesSearch(maotai, '   ')).toBe(true)
    expect(stockMatchesSearch(maotai, '“贵州茅台”')).toBe(true)
  })
})

describe('TablePagination：页码序列', () => {
  it('页数少时全列（截图 2 里就是 1..7）', () => {
    expect(paginationItems(1, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(paginationItems(3, 5)).toEqual([1, 2, 3, 4, 5])
  })

  it('页数多时首页 + 当前附近 + 末页，中间用省略号', () => {
    expect(paginationItems(1, 56)).toEqual([1, 2, 3, 4, 5, 'gap', 56])
    expect(paginationItems(6, 56)).toEqual([1, 'gap', 5, 6, 7, 'gap', 56])
    expect(paginationItems(56, 56)).toEqual([1, 'gap', 52, 53, 54, 55, 56])
    // 当前页永远在序列里
    for (const current of [1, 2, 30, 55, 56]) {
      expect(paginationItems(current, 56)).toContain(current)
    }
  })
})

describe('表头排序：默认方向', () => {
  it('换列时文字/代码/市场升序，数值与分数降序', () => {
    expect(nextSortState(DEFAULT_SORT, 'name')).toEqual({ key: 'name', dir: 'asc' })
    expect(nextSortState(DEFAULT_SORT, 'market')).toEqual({ key: 'market', dir: 'asc' })
    expect(nextSortState(DEFAULT_SORT, 'score')).toEqual({ key: 'score', dir: 'desc' })
    expect(nextSortState(DEFAULT_SORT, 'close')).toEqual({ key: 'close', dir: 'desc' })
  })

  it('同列再点则翻转方向', () => {
    expect(nextSortState({ key: 'score', dir: 'desc' }, 'score')).toEqual({ key: 'score', dir: 'asc' })
    expect(nextSortState({ key: 'code', dir: 'asc' }, 'code')).toEqual({ key: 'code', dir: 'desc' })
  })
})
