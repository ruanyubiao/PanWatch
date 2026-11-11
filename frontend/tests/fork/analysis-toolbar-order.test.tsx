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
})
