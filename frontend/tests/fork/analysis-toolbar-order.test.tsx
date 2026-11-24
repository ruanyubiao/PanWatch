import { describe, expect, it } from 'vitest'

/**
 * 分析页工具条里的按钮顺序（2026-11-11 用户指定）。
 *
 * 「添加股票」原来在第二行、夹在「刷新」和搜索框之间；用户要求挪到「条件选股」
 * 后面。这两个按钮都是「往列表里加东西」，放在一起才好找。
 *
 * 用源码位置断言而不是渲染断言：这一页 3000+ 行、依赖十几条接口，渲染成本高，
 * 而这里要钉的只是**顺序**这一件事（与 analysis-dialog.test.tsx 里钉「数据分析
 * 排在条件选股前面」同一套做法）。
 */
describe('fork: 分析页工具条按钮顺序', () => {
  const readSource = async () => {
    const { readFileSync } = await import('node:fs')
    return readFileSync(`${process.cwd()}/src/pages/ForkAnalysis.tsx`, 'utf-8')
  }

  it('「添加股票」紧跟在「条件选股」后面（第一行）', async () => {
    const source = await readSource()
    const actionsStart = source.indexOf('const tableToolbarActions')
    const actionsEnd = source.indexOf('const tableToolbarMeta')
    expect(actionsStart).toBeGreaterThan(-1)
    const toolbar = source.slice(actionsStart, actionsEnd)

    const screenIndex = toolbar.indexOf('data-tour="screen-stocks"')
    const addIndex = toolbar.indexOf('data-tour="add-stock"')
    expect(screenIndex).toBeGreaterThan(-1)
    expect(addIndex).toBeGreaterThan(screenIndex)
  })

  it('第二行（刷新 + 搜索框）不再出现「添加股票」', async () => {
    const source = await readSource()
    const leadingStart = source.indexOf('const tableToolbarLeading')
    const leadingEnd = source.indexOf('return (', leadingStart)
    const leading = source.slice(leadingStart, leadingEnd)
    expect(leading).toContain('data-tour="refresh-quotes"')
    expect(leading).not.toContain('data-tour="add-stock"')
  })

  it('「模型预测」紧跟在「添加股票」后面，且只开新窗口', async () => {
    const source = await readSource()
    const actionsStart = source.indexOf('const tableToolbarActions')
    const actionsEnd = source.indexOf('const tableToolbarMeta')
    const toolbar = source.slice(actionsStart, actionsEnd)

    const addIndex = toolbar.indexOf('data-tour="add-stock"')
    const predictIndex = toolbar.indexOf('data-tour="predict"')
    expect(addIndex).toBeGreaterThan(-1)
    expect(predictIndex).toBeGreaterThan(addIndex)
    // 只开新窗口，页面自己不请求预测接口（列表页/详情页自己读）
    expect(toolbar).toContain('openPredictWindow()')
    expect(toolbar).not.toContain('getPredictDaily')
  })

  it('「模型预测」列（原「来源」）：值是预测名次，点它新窗口进详情，旧信息进徽章悬停提示', async () => {
    const source = await readSource()
    const start = source.indexOf('const renderMarketSource')
    const end = source.indexOf('/** 操作列', start)
    const cell = source.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    // 数值与链接口径
    expect(cell).toContain('predictStockPath(row.code)')
    expect(cell).toContain('predictScores?.scores?.[row.code]')
    expect(cell).toContain('target="_blank"')
    // 这一格只说预测：原来那行来源文字不并排、也不塞进这一格的 title
    expect(cell).toContain('predictHint(predict.rank_no')
    expect(cell).not.toContain('legacyLine')
    // 没有预测时给「—」，不是 0
    expect(cell).toContain('predictNone')

    // 来源那行改挂到「指标」列徽章的悬停提示：技术面那行→技术面徽章，AI 那行→AI 徽章
    const hintStart = source.indexOf('const rowSourceHint')
    const indicatorStart = source.indexOf('const renderMarketIndicator')
    expect(hintStart).toBeGreaterThan(-1)
    expect(source.slice(hintStart, indicatorStart)).toContain("kind: 'ai'")
    const indicator = source.slice(indicatorStart, source.indexOf('const renderMarketTradeStatus'))
    expect(indicator).toContain("technicalHint={hint.kind === 'tech' ? hint.text : null}")
    expect(indicator).toContain("aiHint={hint.kind === 'ai' ? hint.text : null}")
  })
})
