import { describe, expect, it } from 'vitest'
import {
  CONDITION_DEFS_ZH,
  MAX_CONDITIONS,
  SCREEN_MARKETS,
  addChild,
  countConditions,
  createCondition,
  createDefaultRequest,
  createGroup,
  duplicateNode,
  findNode,
  formatRule,
  removeNode,
  requiredBarsOf,
  toApiRequest,
  treeDepth,
  updateNode,
  validateScreenRequest,
  type ConditionNode,
  type GroupNode,
  type ScreenRequest,
} from '@/lib/screen-rule'

/**
 * 条件选股的纯函数层（需求规格 §12.5 F1–F5）。
 *
 * 这一层没有 DOM、没有请求，所以可以逐条钉住规格里的边界：
 * `formatRule` 的括号规则、§10 的每一条校验、树操作的不可变、K 的算法、
 * 以及提交前剥掉 `collapsed`。
 */

const req = (rule: GroupNode, over: Partial<ScreenRequest> = {}): ScreenRequest => ({
  ...createDefaultRequest(),
  rule,
  ...over,
})

type RuleNode = GroupNode['children'][number]

const group = (children: RuleNode[], operator: 'AND' | 'OR' = 'AND'): GroupNode => ({
  ...createGroup(operator),
  children,
})

const cond = (name: ConditionNode['name'], params?: object): ConditionNode =>
  ({ ...createCondition(name as never), ...(params ? { params } : {}) }) as ConditionNode

const messages = (issues: { message: string }[]) => issues.map(i => i.message).join('；')

describe('条件选股 / 规则预览', () => {
  it('F1 AND / OR / 嵌套 / 单子节点组 / 空根组 / 空子组', () => {
    expect(formatRule(createGroup('AND'))).toBe('（无技术条件，仅按基础筛选）')

    const and = group([cond('close_above_ma', { period: 5 }), cond('consecutive_bullish', { days: 4 })])
    expect(formatRule(and)).toBe('收盘价站上 MA5 AND 连续 4 日阳线')

    const or = group([cond('more_bullish_candles'), cond('more_bearish_candles')], 'OR')
    expect(formatRule(or)).toBe('阳线多于阴线（统计窗口内） OR 阴线多于阳线（统计窗口内）')

    // 根组不加括号；子组有 ≥2 个子节点时加
    const nested = group([
      cond('ma_bullish', { periods: [5, 10, 20, 60] }),
      group([cond('consecutive_bullish', { days: 4 }), cond('change_pct', { n: 1, min: 5, max: 30 })], 'OR'),
    ])
    expect(formatRule(nested)).toBe(
      '均线多头排列(5/10/20/60) AND ( 连续 4 日阳线 OR 第 1 日涨跌幅 ∈ (5%, 30%) )',
    )

    // 只有 1 个子节点的子组不加括号
    const singleNested = group([group([cond('close_above_ma', { period: 10 })]), cond('more_bullish_candles')])
    expect(formatRule(singleNested)).toBe('收盘价站上 MA10 AND 阳线多于阴线（统计窗口内）')

    // 空子组用「( 空组 )」
    const emptySub = group([cond('more_bullish_candles'), group([])])
    expect(formatRule(emptySub)).toBe('阳线多于阴线（统计窗口内） AND ( 空组 )')
  })
})

describe('条件选股 / 校验（规格 §10）', () => {
  it('F2 统计窗口、市场、市值', () => {
    expect(messages(validateScreenRequest(req(createGroup(), { trading_days: 0 })))).toContain(
      '统计窗口需为 1–250 的整数',
    )
    expect(messages(validateScreenRequest(req(createGroup(), { trading_days: 251 })))).toContain(
      '统计窗口需为 1–250 的整数',
    )
    expect(messages(validateScreenRequest(req(createGroup(), { trading_days: 1.5 })))).toContain(
      '统计窗口需为 1–250 的整数',
    )
    expect(messages(validateScreenRequest(req(createGroup(), { markets: [] })))).toContain(
      '至少选择一个市场',
    )
    expect(
      messages(
        validateScreenRequest(
          req(createGroup(), { market_cap: { min_yi: 100, max_yi: 100 } }),
        ),
      ),
    ).toContain('下限必须小于上限')
    expect(
      messages(
        validateScreenRequest(
          req(createGroup(), { market_cap: { min_yi: -1, max_yi: 10 } }),
        ),
      ),
    ).toContain('总市值下限需为 ≥ 0 的数字')
    expect(
      messages(
        validateScreenRequest(
          req(createGroup(), { market_cap: { min_yi: 1, max_yi: 1_000_001 } }),
        ),
      ),
    ).toContain('总市值上限不能超过 1,000,000 亿')
  })

  it('F2 条件树结构（深度 / 空组 / 规模）', () => {
    let five: RuleNode = cond('close_above_ma', { period: 5 })
    for (let level = 1; level <= 5; level += 1) five = group([five])
    expect(validateScreenRequest(req(five as GroupNode))).toEqual([])

    const six = group([five as GroupNode])
    expect(messages(validateScreenRequest(req(six)))).toContain('条件组最多嵌套 5 层')

    const emptySub = group([cond('more_bullish_candles'), group([])])
    const issues = validateScreenRequest(req(emptySub))
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toBe('条件组不能为空：请添加条件，或删除该组')

    const tooMany = group(
      Array.from({ length: MAX_CONDITIONS + 1 }, () => cond('more_bullish_candles')),
    )
    expect(messages(validateScreenRequest(req(tooMany)))).toContain(
      `条件数量过多（最多 ${MAX_CONDITIONS} 个）`,
    )
  })

  it('F2 参数（均线周期 / 连续天数 / N / 涨跌幅区间）', () => {
    expect(
      messages(validateScreenRequest(req(group([cond('ma_bullish', { periods: [5] })])))),
    ).toContain('均线周期至少选 2 个且不能重复')

    expect(
      messages(validateScreenRequest(req(group([cond('ma_bearish', { periods: [5, 5] })])))),
    ).toContain('均线周期至少选 2 个且不能重复')

    expect(
      messages(validateScreenRequest(req(group([cond('close_above_ma', { period: 7 })])))),
    ).toContain('均线周期不合法')

    // 连续天数上限 = min(W, 30)
    expect(
      messages(
        validateScreenRequest(
          req(group([cond('consecutive_bullish', { days: 31 })]), { trading_days: 60 }),
        ),
      ),
    ).toContain('连续天数需为 1 至 30 的整数')

    expect(
      messages(validateScreenRequest(req(group([cond('change_pct', { n: 31, min: -5, max: 5 })])))),
    ).toContain('N 需为 1 至 30 之间的整数')

    expect(
      messages(validateScreenRequest(req(group([cond('change_pct', { n: 1, min: 10, max: -10 })])))),
    ).toContain('涨跌幅下限必须小于上限')
  })

  it('F2 错误的 path 与 nodeId 能定位到具体节点', () => {
    const bad = cond('change_pct', { n: 99, min: -5, max: 5 })
    const tree = group([cond('more_bullish_candles'), group([bad])])
    const issues = validateScreenRequest(req(tree))
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('rule.children[1].children[0]')
    expect(issues[0].nodeId).toBe(bad.id)
  })
})

describe('条件选股 / 树操作', () => {
  it('F3 updateNode 返回新树，原树不变', () => {
    const child = cond('close_above_ma', { period: 5 })
    const tree = group([child])
    const next = updateNode(tree, child.id, node =>
      node.type === 'condition' ? { ...node, params: { period: 20 } } : node,
    )

    expect(next).not.toBe(tree)
    expect(tree.children[0]).toBe(child)
    expect((next.children[0] as ConditionNode).params).toEqual({ period: 20 })
    // 未命中的节点保持引用（避免无意义的重渲染）
    expect(next.children[0]).not.toBe(tree.children[0])
  })

  it('F3 duplicateNode 生成新 id 并插在原条件后面', () => {
    const first = cond('more_bullish_candles')
    const second = cond('consecutive_bullish', { days: 3 })
    const tree = group([first, second])
    const next = duplicateNode(tree, first.id)

    expect(next.children).toHaveLength(3)
    expect(next.children[0].id).toBe(first.id)
    const copy = next.children[1] as ConditionNode
    expect(copy.id).not.toBe(first.id)
    expect(copy.name).toBe('more_bullish_candles')
    expect(next.children[2].id).toBe(second.id)
    // 原树不受影响
    expect(tree.children).toHaveLength(2)
  })

  it('F3 addChild / removeNode / count / depth', () => {
    const sub = createGroup('OR')
    const root = createGroup('AND')
    let tree = addChild(root, root.id, cond('more_bullish_candles'))
    tree = addChild(tree, tree.id, sub)
    tree = addChild(tree, sub.id, cond('consecutive_bullish', { days: 2 }))

    expect(countConditions(tree)).toBe(2)
    expect(treeDepth(tree)).toBe(2)
    expect(findNode(tree, sub.id)).toMatchObject({ type: 'group', operator: 'OR' })

    const pruned = removeNode(tree, sub.id)
    expect(countConditions(pruned)).toBe(1)
    expect(treeDepth(pruned)).toBe(1)
  })

  it('F3 深拷贝参数：改副本不影响原条件', () => {
    const original = cond('ma_bullish', { periods: [5, 10] })
    const tree = group([original])
    const next = duplicateNode(tree, original.id)
    const copy = next.children[1] as ConditionNode
    ;(copy.params as { periods: number[] }).periods.push(60)
    expect((original.params as { periods: number[] }).periods).toEqual([5, 10])
  })
})

describe('条件选股 / K 与提交', () => {
  it('F4 requiredBarsOf 与后端 A10 一致', () => {
    // 空树 → 0（不读日线）
    expect(requiredBarsOf(req(createGroup()))).toBe(0)

    // 默认示例树：MA60 需要 60 根，W=30 → 60
    const example = group([
      cond('ma_bullish', { periods: [5, 10, 20, 60] }),
      cond('close_above_ma', { period: 5 }),
      group([cond('consecutive_bullish', { days: 4 }), cond('change_pct', { n: 1, min: 5, max: 30 })], 'OR'),
    ])
    expect(requiredBarsOf(req(example))).toBe(60)

    // change_pct 的 n+1：W=30、n=30 → 31
    expect(
      requiredBarsOf(req(group([cond('change_pct', { n: 30, min: -30, max: 30 })]))),
    ).toBe(31)

    // W 比任何条件都大时以 W 为准
    expect(
      requiredBarsOf(req(group([cond('more_bullish_candles')]), { trading_days: 250 })),
    ).toBe(250)
  })

  it('F5 toApiRequest 剥掉 collapsed，字符串数字转成 number', () => {
    const collapsed = { ...createGroup('AND'), collapsed: true } as GroupNode
    const condition = cond('close_above_ma', { period: '20' as unknown as 20 })
    const state = {
      ...createDefaultRequest(),
      trading_days: '45' as unknown as number,
      markets: [...SCREEN_MARKETS],
      market_cap: { min_yi: '2' as unknown as number, max_yi: '500' as unknown as number },
      rule: { ...collapsed, children: [condition] },
    } as ScreenRequest

    const payload = toApiRequest(state)
    expect(payload.trading_days).toBe(45)
    expect(payload.market_cap).toEqual({ min_yi: 2, max_yi: 500 })
    expect('collapsed' in payload.rule).toBe(false)
    expect((payload.rule.children[0] as ConditionNode).params).toEqual({ period: 20 })
    // 请求里不该出现 id 之外的多余键（后端 extra="forbid"）
    expect(Object.keys(payload.rule).sort()).toEqual(['children', 'id', 'operator', 'type'])
  })
})

describe('条件选股 / 注册表', () => {
  it('连续 N 日阳线的起点参与预览、所需根数与校验', () => {
    const def = CONDITION_DEFS_ZH.consecutive_bullish
    expect(def.summary({ start: 1, days: 4 })).toBe('连续 4 日阳线')
    expect(def.summary({ start: 3, days: 4 })).toBe('自倒数第 3 日起连续 4 日阳线')
    // 起点之前那 start-1 根也要读进来
    expect(def.requiredBars({ start: 3, days: 4 })).toBe(6)
    expect(formatRule(group([cond('consecutive_bullish', { start: 3, days: 4 })]))).toBe(
      '自倒数第 3 日起连续 4 日阳线',
    )

    // 起点 + 天数 必须落在窗口（默认 W=30）内
    expect(
      messages(
        validateScreenRequest(req(group([cond('consecutive_bullish', { start: 10, days: 25 })]))),
      ),
    ).toContain('起点与天数之和不能超过 30')
    expect(
      messages(validateScreenRequest(req(group([cond('consecutive_bullish', { start: 0, days: 4 })])))),
    ).toContain('倒数第几个交易日需为 1 至 30 的整数')
  })

  it('F6 老请求缺 start 时按 1 提交（后端 extra=forbid，不能漏字段）', () => {
    const payload = toApiRequest(req(group([cond('consecutive_bullish', { days: 4 })])))
    expect((payload.rule.children[0] as ConditionNode).params).toEqual({ start: 1, days: 4 })
  })

  it('八个条件齐全，分类与默认值符合规格', () => {
    expect(Object.keys(CONDITION_DEFS_ZH)).toEqual([
      'ma_bullish',
      'ma_bearish',
      'close_above_ma',
      'more_bullish_candles',
      'more_bearish_candles',
      'consecutive_bullish',
      'consecutive_rising',
      'change_pct',
    ])
    expect(CONDITION_DEFS_ZH.ma_bullish.defaults).toEqual({ periods: [5, 10, 20, 60] })
    expect(CONDITION_DEFS_ZH.close_above_ma.defaults).toEqual({ period: 5 })
    expect(CONDITION_DEFS_ZH.consecutive_bullish.defaults).toEqual({ start: 1, days: 4 })
    expect(CONDITION_DEFS_ZH.change_pct.defaults).toEqual({ n: 1, min: -30, max: 30 })
    expect(CONDITION_DEFS_ZH.ma_bullish.category).toBe('均线')
    expect(CONDITION_DEFS_ZH.more_bearish_candles.category).toBe('K 线')
    expect(CONDITION_DEFS_ZH.change_pct.category).toBe('涨跌幅')
  })

  it('摘要按周期升序显示', () => {
    expect(CONDITION_DEFS_ZH.ma_bullish.summary({ periods: [60, 5, 20, 10] })).toBe(
      '均线多头排列(5/10/20/60)',
    )
  })

  it('连续上涨（涨幅 > 0）与连续阳线是两个条件，判据在名字与说明里分开写清', () => {
    const bull = CONDITION_DEFS_ZH.consecutive_bullish
    const rise = CONDITION_DEFS_ZH.consecutive_rising

    // 名字里就写清区别
    expect(bull.label).toContain('收盘 > 开盘')
    expect(rise.label).toContain('涨幅 > 0')
    // 说明互相点名对方，避免「低开高走但全天跌」那种歧义
    expect(bull.description).toContain('连续上涨')
    expect(rise.description).toContain('前一交易日收盘价')

    expect(rise.summary({ start: 1, days: 3 })).toBe('连续 3 日上涨')
    expect(rise.summary({ start: 2, days: 3 })).toBe('自倒数第 2 日起连续 3 日上涨')
    expect(rise.defaults).toEqual({ start: 1, days: 3 })
    // 前收缺失要回退前一根 → 比阳线多读一根
    expect(rise.requiredBars({ start: 1, days: 3 })).toBe(4)
    expect(bull.requiredBars({ start: 1, days: 3 })).toBe(3)

    // 校验跟阳线同一套：起点 + 天数落在窗口上限内
    expect(
      messages(validateScreenRequest(req(group([cond('consecutive_rising', { start: 10, days: 25 })])))),
    ).toContain('起点与天数之和不能超过 30')
  })

  it('连续阳线的说明要点名两个参数（倒数第几个交易日 + 连续天数）', () => {
    const text = CONDITION_DEFS_ZH.consecutive_bullish.description
    expect(text).toContain('倒数第几个交易日')
    expect(text).toContain('连续天数')
    expect(text).toContain('默认 1')
    expect(text).toContain('默认 4')
    expect(text).toContain('收盘价')
  })
})

// 类型别名在文件顶部（RuleNode = GroupNode['children'][number]）
