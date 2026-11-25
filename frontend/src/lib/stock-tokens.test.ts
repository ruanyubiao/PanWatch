import { describe, expect, it } from 'vitest'

import { isLikelyAShareCode, looksLikeCode, normalizeSymbol, parseStockInput, sameListingCode, splitStockTokens } from '@/lib/stock-tokens'

/**
 * 批量添加的输入切分。
 * 用户明确列出的分隔符：空白（空格/换行/\t）、中文逗号、英文逗号、顿号、
 * 斜杠、反斜杠、竖线、冒号（中英文）、分号（中英文）。
 */
describe('splitStockTokens', () => {
  it('支持用户列出的全部分隔符', () => {
    expect(splitStockTokens('600519 000001\t300750')).toEqual(['600519', '000001', '300750'])
    expect(splitStockTokens('600519,000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519，000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519、000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519/000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519\\000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519|000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519:000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519：000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519;000001')).toEqual(['600519', '000001'])
    expect(splitStockTokens('600519；000001')).toEqual(['600519', '000001'])
  })

  it('处理换行（\\r\\n 与 \\n）和连续分隔符', () => {
    expect(splitStockTokens('600519\r\n000001\n300750')).toEqual(['600519', '000001', '300750'])
    expect(splitStockTokens('  600519，，,000001,,  ')).toEqual(['600519', '000001'])
  })

  it('一行「代码 名称」合成一条，名称不再单独成条', () => {
    // 用户 2026-11-25 报的原始输入：三行输入只应得到两只股票
    expect(splitStockTokens('600486 扬农化工\n000981 山子高科\n600486 扬农化工')).toEqual([
      '600486',
      '000981',
    ])
    // 名称单独出现（没有代码）时仍各自成条，交给搜索解析
    expect(splitStockTokens(' 600519  贵州茅台 ，比亚迪 ')).toEqual(['600519', '比亚迪'])
  })

  it('去重但保留首次出现的顺序', () => {
    expect(splitStockTokens('600519 000001 600519')).toEqual(['600519', '000001'])
    // 去重按大小写不敏感处理
    expect(splitStockTokens('aapl AAPL')).toEqual(['aapl'])
  })

  it('空输入返回空数组', () => {
    expect(splitStockTokens('')).toEqual([])
    expect(splitStockTokens('   \n\t ')).toEqual([])
  })
})

describe('parseStockInput', () => {
  it('代码 + 名称成一条，并带上名称提示', () => {
    expect(parseStockInput('600486 扬农化工')).toEqual([
      { token: '600486', nameHint: '扬农化工', raw: '600486 扬农化工' },
    ])
  })

  it('用户这次的三行输入：同一只票合并，只剩两条', () => {
    const entries = parseStockInput('600486 扬农化工\n000981 山子高科\n600486 扬农化工')
    expect(entries.map(e => e.token)).toEqual(['600486', '000981'])
    expect(entries.map(e => e.nameHint)).toEqual(['扬农化工', '山子高科'])
  })

  it('同一行多组「代码 名称」逐组配对，两个代码不会互相吞掉', () => {
    expect(parseStockInput('600519 贵州茅台 000001 平安银行').map(e => e.token)).toEqual([
      '600519',
      '000001',
    ])
    // 两个代码相邻时谁也不是谁的名字
    expect(parseStockInput('600519 000001')).toEqual([
      { token: '600519', raw: '600519' },
      { token: '000001', raw: '000001' },
    ])
  })

  it('只有名称、或名称在前，都不配对（交给搜索解析）', () => {
    expect(parseStockInput('比亚迪')).toEqual([{ token: '比亚迪', raw: '比亚迪' }])
    expect(parseStockInput('扬农化工 600486').map(e => e.token)).toEqual(['扬农化工', '600486'])
  })

  it('先出现纯代码、后来带上名称时补上提示，不新增条目', () => {
    const entries = parseStockInput('600486\n600486 扬农化工')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ token: '600486', nameHint: '扬农化工' })
  })

  it('分隔符混用时仍然一行一条', () => {
    expect(parseStockInput('600486 扬农化工，000981 山子高科').map(e => e.raw)).toEqual([
      '600486 扬农化工',
      '000981 山子高科',
    ])
  })
})

describe('normalizeSymbol', () => {
  it('去掉交易所后缀', () => {
    expect(normalizeSymbol('600519.SH')).toBe('600519')
    expect(normalizeSymbol('000001.sz')).toBe('000001')
    expect(normalizeSymbol('600519.SS')).toBe('600519')
    expect(normalizeSymbol('00700.HK')).toBe('00700')
  })

  it('保留纯代码不变', () => {
    expect(normalizeSymbol('300750')).toBe('300750')
  })

  it('去掉 sh/sz/bj 前缀，并和纯代码视为同一只', () => {
    expect(normalizeSymbol('sh600519')).toBe('600519')
    expect(normalizeSymbol('SZ000001')).toBe('000001')
    expect(normalizeSymbol('SH600519.SH')).toBe('600519')
    expect(sameListingCode('sh600519', '600519')).toBe(true)
    expect(sameListingCode('sz000001', '000001.SZ')).toBe(true)
    expect(sameListingCode('600519', '000001')).toBe(false)
    expect(isLikelyAShareCode('sh600519')).toBe(true)
    expect(isLikelyAShareCode('sz300750')).toBe(true)
  })
})

describe('looksLikeCode', () => {
  it('识别 5-6 位纯数字代码', () => {
    expect(looksLikeCode('600519')).toBe(true)
    expect(looksLikeCode('00700.HK')).toBe(true)
    expect(looksLikeCode('贵州茅台')).toBe(false)
    expect(looksLikeCode('123')).toBe(false)
  })
})

describe('isLikelyAShareCode', () => {
  it('只认 6 位且前缀属于 A 股', () => {
    expect(isLikelyAShareCode('600519')).toBe(true)
    expect(isLikelyAShareCode('000001')).toBe(true)
    expect(isLikelyAShareCode('300750')).toBe(true)
    expect(isLikelyAShareCode('688111')).toBe(true)
    expect(isLikelyAShareCode('920992')).toBe(true)   // 北交所
    expect(isLikelyAShareCode('600519.SH')).toBe(true)
    // 5 位随手输入、ETF 代码、港美股代码都不算，避免写成垃圾自选
    expect(isLikelyAShareCode('12345')).toBe(false)
    expect(isLikelyAShareCode('510300')).toBe(false)
    expect(isLikelyAShareCode('999999')).toBe(false)
    expect(isLikelyAShareCode('00700.HK')).toBe(false)
  })
})
