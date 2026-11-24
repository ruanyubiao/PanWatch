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

  it('「模型预测」列（原「来源」）：值是预测名次，点它新窗口进详情，旧信息进悬停提示', async () => {
    const source = await readSource()
    const start = source.indexOf('const renderMarketSource')
    const end = source.indexOf('/** 操作列', start)
    const block = source.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    // 数值与链接口径
    expect(block).toContain('predictStockPath(row.code)')
    expect(block).toContain('predictScores?.scores?.[row.code]')
    expect(block).toContain('target="_blank"')
    // 原来那行来源文字不并排显示，但**没有丢**：塞进同一格的悬停提示（两行）
    expect(block).toContain('rowSourceHint(row).text')
    expect(block).toContain('predictHint(legacyLine, predict.rank_no')
    // 没有预测时给「—」，不是 0
    expect(block).toContain('predictNone')
  })

  it('上游徽章组件一个字符都没动（悬停提示不往徽章上接线）', async () => {
    const source = await readSource()
    // 页面侧不传 titleHint / technicalHint / aiHint 这类为 fork 新增的徽章属性
    expect(source).not.toContain('titleHint')
    expect(source).not.toContain('technicalHint')
    expect(source).not.toContain('aiHint')
  })
})
