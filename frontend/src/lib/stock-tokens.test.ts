import { describe, expect, it } from 'vitest'

import { isLikelyAShareCode, looksLikeCode, normalizeSymbol, splitStockTokens } from '@/lib/stock-tokens'

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

  it('保留代码与名称混合的输入，并去掉首尾空白', () => {
    expect(splitStockTokens(' 600519  贵州茅台 ，比亚迪 ')).toEqual(['600519', '贵州茅台', '比亚迪'])
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
