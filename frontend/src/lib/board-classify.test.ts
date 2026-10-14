import { describe, expect, it } from 'vitest'

import { classifyBoard, countByBoard, isEtf, matchesBoard, onlyAShares, onlyStocks } from '@/lib/board-classify'

/**
 * fork 分析页的板块归类。
 * 规则必须与后端 src/modules/market/api/fork_catalog.py 的 classify_board 一致。
 */
describe('classifyBoard', () => {
  it('按代码前缀归类沪深科创创业', () => {
    expect(classifyBoard({ symbol: '600519', name: '贵州茅台', market: 'CN' })).toBe('sh')
    expect(classifyBoard({ symbol: '601398', name: '工商银行', market: 'CN' })).toBe('sh')
    expect(classifyBoard({ symbol: '000001', name: '平安银行', market: 'CN' })).toBe('sz')
    expect(classifyBoard({ symbol: '002594', name: '比亚迪', market: 'CN' })).toBe('sz')
    // 深市主板 2025 年起的新号段
    expect(classifyBoard({ symbol: '302132', name: '中航成飞', market: 'CN' })).toBe('sz')
    expect(classifyBoard({ symbol: '300750', name: '宁德时代', market: 'CN' })).toBe('cyb')
    expect(classifyBoard({ symbol: '301029', name: '怡合达', market: 'CN' })).toBe('cyb')
    expect(classifyBoard({ symbol: '688111', name: '金山办公', market: 'CN' })).toBe('kcb')
  })

  it('ST 优先于交易所板块（*ST / SST 都算）', () => {
    expect(classifyBoard({ symbol: '600123', name: '*ST花王', market: 'CN' })).toBe('st')
    expect(classifyBoard({ symbol: '688622', name: '*ST禾信', market: 'CN' })).toBe('st')
    expect(classifyBoard({ symbol: '601398', name: 'SST前锋', market: 'CN' })).toBe('st')
  })

  it('ETF 与港美股不参与板块归类', () => {
    expect(classifyBoard({ symbol: '510300', name: '沪深300ETF', asset_type: 'etf', market: 'CN' })).toBe('all')
    expect(classifyBoard({ symbol: '00700', name: '腾讯控股', market: 'HK' })).toBe('all')
    expect(classifyBoard({ symbol: 'AAPL', name: '苹果', market: 'US' })).toBe('all')
  })

  it('北交所等无 pill 的代码只计入「全部」', () => {
    expect(classifyBoard({ symbol: '920992', name: '中科美菱', market: 'CN' })).toBe('all')
  })
})

describe('fork 的「关注」范围', () => {
  it('onlyStocks 过滤掉 ETF', () => {
    const list = [
      { symbol: '600519', name: '贵州茅台', market: 'CN' },
      { symbol: '510300', name: '沪深300ETF', market: 'CN', asset_type: 'etf' },
    ]
    expect(onlyStocks(list).map(s => s.symbol)).toEqual(['600519'])
    expect(isEtf(list[0])).toBe(false)
    expect(isEtf(list[1])).toBe(true)
  })

  it('onlyAShares 再过滤掉港股美股（本页只服务 A 股）', () => {
    const list = [
      { symbol: '600519', name: '贵州茅台', market: 'CN' },
      { symbol: '510300', name: '沪深300ETF', market: 'CN', asset_type: 'etf' },
      { symbol: '00700', name: '腾讯控股', market: 'HK' },
      { symbol: 'AAPL', name: '苹果', market: 'US' },
    ]
    expect(onlyAShares(list).map(s => s.symbol)).toEqual(['600519'])
  })

  it('countByBoard 的 all 是总数，其余是互斥板块数', () => {
    const counts = countByBoard([
      { symbol: '600519', name: '贵州茅台', market: 'CN' },
      { symbol: '300750', name: '宁德时代', market: 'CN' },
      { symbol: '600123', name: '*ST花王', market: 'CN' },
      { symbol: '920992', name: '中科美菱', market: 'CN' },
    ])
    expect(counts.all).toBe(4)
    expect(counts.sh).toBe(1)
    expect(counts.cyb).toBe(1)
    expect(counts.st).toBe(1)
    expect(counts.sz).toBe(0)
  })

  it('matchesBoard 在 all 下恒为真', () => {
    expect(matchesBoard({ symbol: '600519', name: '贵州茅台', market: 'CN' }, 'all')).toBe(true)
    expect(matchesBoard({ symbol: '600519', name: '贵州茅台', market: 'CN' }, 'st')).toBe(false)
  })
})
