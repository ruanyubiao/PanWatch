import { describe, expect, it } from 'vitest'
import {
  CONDITION_CATEGORIES,
  CONDITION_DEFS_ZH,
  MAX_CONDITIONS,
  PICKABLE_CONDITION_NAMES,
  SCREEN_MARKETS,
  SCREEN_TEXTS_ZH,
  addChild,
  countConditions,
  createCondition,
  createDefaultRequest,
  createGroup,
  duplicateNode,
  fillDefaultParams,
  findNode,
  formatRule,
  migrateLegacyMarketCap,
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
    expect(formatRule(and)).toBe('收盘价站上 MA5 AND 倒数第4～1天连续4日阳线')

    const or = group([cond('more_bullish_candles'), cond('more_bearish_candles')], 'OR')
    expect(formatRule(or)).toBe('阳线多于阴线（统计窗口内） OR 阴线多于阳线（统计窗口内）')

    // 根组不加括号；子组有 ≥2 个子节点时加
    const nested = group([
      cond('ma_bullish', { periods: [5, 10, 20, 60] }),
      group([cond('consecutive_bullish', { days: 4 }), cond('change_pct', { n: 1, min: 5, max: 30 })], 'OR'),
    ])
    expect(formatRule(nested)).toBe(
      '均线多头排列(5/10/20/60) AND ( 倒数第4～1天连续4日阳线 OR 第 1 日涨跌幅 ∈ (5%, 30%) )',
    )

    // 只有 1 个子节点的子组不加括号
    const singleNested = group([group([cond('close_above_ma', { period: 10 })]), cond('more_bullish_candles')])
    expect(formatRule(singleNested)).toBe('收盘价站上 MA10 AND 阳线多于阴线（统计窗口内）')

    // 空子组用「( 空组 )」
    const emptySub = group([cond('more_bullish_candles'), group([])])
    expect(formatRule(emptySub)).toBe('阳线多于阴线（统计窗口内） AND ( 空组 )')
  })

  it('F1b 同组多条「代码 / 名称」按「或」显示（与后端编译期合并一致）', () => {
    const twoIdentity = group([
      cond('stock_code', { text: '600933' }),
      cond('stock_name', { text: '锦江航运' }),
    ])
    expect(formatRule(twoIdentity)).toBe('( 代码 ∈ { 600933 } OR 名称 ∈ { 锦江航运 } )')

    // 混进非身份条件：身份几条合成一组，其余仍按 AND
    const mixed = group([
      cond('stock_name', { text: '爱柯迪' }),
      cond('close_above_ma', { period: 5 }),
      cond('stock_name', { text: '锦江航运' }),
    ])
    expect(formatRule(mixed)).toBe(
      '( 名称 ∈ { 爱柯迪 } OR 名称 ∈ { 锦江航运 } ) AND 收盘价站上 MA5',
    )

    // 单独一条不加括号、不加「或」
    expect(formatRule(group([cond('stock_name', { text: '爱柯迪' })]))).toBe('名称 ∈ { 爱柯迪 }')
  })
})

describe('条件选股 / 校验（规格 §10）', () => {
  it('F2 统计窗口、市场（市值已搬进条件列表）', () => {
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
    // 基础市值区间已经不是界面字段：老请求带着也不拦（语义由 market_cap 条件表达）
    expect(
      messages(validateScreenRequest(req(createGroup(), { market_cap: { min_yi: 100, max_yi: 100 } }))),
    ).toBe('')
    // 市值条件的校验在条件自己身上
    expect(
      CONDITION_DEFS_ZH.market_cap.validate({ op: 'gte', value: -1 }, 30),
    ).not.toEqual([])
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
      rule: { ...collapsed, children: [condition] },
    } as ScreenRequest

    const payload = toApiRequest(state)
    expect(payload.trading_days).toBe(45)
    // 市值不再作为基础参数提交（是条件列表里的一条条件）
    expect(payload.market_cap).toBeUndefined()
    expect('collapsed' in payload.rule).toBe(false)
    expect((payload.rule.children[0] as ConditionNode).params).toEqual({ period: 20 })
    // 请求里不该出现 id 之外的多余键（后端 extra="forbid"）
    expect(Object.keys(payload.rule).sort()).toEqual(['children', 'id', 'operator', 'type'])
  })
})

describe('条件选股 / 注册表', () => {
  it('连续 N 日阳线的起点参与预览、所需根数与校验', () => {
    const def = CONDITION_DEFS_ZH.consecutive_bullish
    // 用户第 4 条指定的写法：起点是最近那天、往回数 N 天，写成「倒数第a～b天连续N日阳线」
    expect(def.summary({ start: 1, days: 4 })).toBe('倒数第4～1天连续4日阳线')
    expect(def.summary({ start: 3, days: 4 })).toBe('倒数第6～3天连续4日阳线')
    // 只连续 1 天时不写区间
    expect(def.summary({ start: 3, days: 1 })).toBe('倒数第3天连续1日阳线')
    // 起点之前那 start-1 根也要读进来
    expect(def.requiredBars({ start: 3, days: 4 })).toBe(6)
    expect(formatRule(group([cond('consecutive_bullish', { start: 3, days: 4 })]))).toBe(
      '倒数第6～3天连续4日阳线',
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

  it('结果横幅摘要：参与计算用实际求值数，缺数据只算被排除的', () => {
    // 全部候选都求了值 → 合并成一句
    expect(SCREEN_TEXTS_ZH.bannerMeta('2026-10-20', 285, 285, 0, '0.2')).toBe(
      '数据截至 2026-10-20 · 基础筛选后 285 只参与计算 · 缺数据排除 0 只 · 耗时 0.2 s',
    )
    // 有候选没取到当日 K 线（evaluated < candidates）→ 两个数分开写，不能并成一句
    expect(SCREEN_TEXTS_ZH.bannerMeta('2026-10-20', 5226, 5217, 550, '1.9')).toBe(
      '数据截至 2026-10-20 · 基础筛选后 5226 只，其中 5217 只参与计算 · 缺数据排除 550 只 · 耗时 1.9 s',
    )
    // 条件树为空（纯基础筛选）：evaluated=0 不是「一只都没算」，而是没有技术条件可算
    expect(SCREEN_TEXTS_ZH.bannerMeta('2026-10-20', 5029, 0, 0, '0.3')).toBe(
      '数据截至 2026-10-20 · 基础筛选后 5029 只（未设技术条件） · 耗时 0.3 s',
    )
  })

  it('F6 老请求缺 start 时按 1 提交（后端 extra=forbid，不能漏字段）', () => {
    const payload = toApiRequest(req(group([cond('consecutive_bullish', { days: 4 })])))
    expect((payload.rule.children[0] as ConditionNode).params).toEqual({ start: 1, days: 4 })
  })

  /**
   * 用户第 2 条报的 bug：截图里「连续 undefined 日上涨」＋两条
   * 「倒数第几个交易日 / 连续天数需为 1 至 30 的整数」。
   *
   * 根因是 `normalizeParams` 只认 `consecutive_bullish`，「连续上涨」的
   * start/days 被整段丢掉（params 变成 {}）。这三条钉住修复：
   *   ① 提交时不能丢参数；② 参数缺失时摘要不出现 undefined；
   *   ③ 老条件文件（params 被丢空）读进来时能补回默认值。
   */
  it('F6b 连续上涨提交时 start/days 不能被丢掉（params 变 {} 就会报两条校验错）', () => {
    const payload = toApiRequest(req(group([cond('consecutive_rising', { start: 4, days: 7 })])))
    expect((payload.rule.children[0] as ConditionNode).params).toEqual({ start: 4, days: 7 })
    // 存到服务器上的条件也是这样一份请求，所以 params 必须完整
    expect(payload.rule.children[0]).toMatchObject({ name: 'consecutive_rising' })

    // 缺字段（老草稿）时按 1 补齐，仍然不许漏键
    const legacy = toApiRequest(req(group([cond('consecutive_rising', { days: 3 })])))
    expect((legacy.rule.children[0] as ConditionNode).params).toEqual({ start: 1, days: 3 })
  })

  it('F6c 参数整组缺失时摘要也只出默认值，绝不出现 undefined', () => {
    const rise = CONDITION_DEFS_ZH.consecutive_rising
    const bull = CONDITION_DEFS_ZH.consecutive_bullish
    // 老条件文件里 params 被丢空 → 运行时是 {}，类型上仍是 {start,days}
    const empty = {} as never
    expect(rise.summary(empty)).toBe('倒数第3～1天连续3日上涨')
    expect(bull.summary(empty)).toBe('倒数第4～1天连续4日阳线')
    expect(formatRule(group([cond('consecutive_rising', {})]))).not.toContain('undefined')
    // 所需根数也不能是 NaN（footer 会照原样打印出来）
    expect(Number.isFinite(rise.requiredBars(empty))).toBe(true)
    expect(Number.isFinite(bull.requiredBars(empty))).toBe(true)
  })

  it('F6d 读老条件文件时用 fillDefaultParams 补回缺失参数（不覆盖已有值）', () => {
    const broken = group([
      { ...cond('consecutive_rising', {}), params: {} } as ConditionNode,
      cond('close_above_ma', { period: 20 }),
    ])
    const fixed = fillDefaultParams(broken)
    expect((fixed.children[0] as ConditionNode).params).toEqual({ start: 1, days: 3 })
    // 已有值原样保留；缺失的按日参数补默认（n=1，与以前语义一致）
    expect((fixed.children[1] as ConditionNode).params).toEqual({ period: 20, n: 1, m: 1 })
    // 补完之后能正常摘要、正常校验
    expect(formatRule(fixed)).toContain('倒数第3～1天连续3日上涨')
    expect(messages(validateScreenRequest(req(fixed)))).toHaveLength(0)
  })

  it('条件齐全（原有 + 量价 + 总市值 + 第二批 + 按日变体），分类与默认值符合规格', () => {
    expect(Object.keys(CONDITION_DEFS_ZH)).toEqual([
      'ma_bullish',
      'ma_bullish_all',
      'ma_bullish_any',
      'ma_bearish',
      'ma_bearish_all',
      'ma_bearish_any',
      'close_above_ma',
      'close_above_ma_all',
      'close_above_ma_any',
      'more_bullish_candles',
      'more_bearish_candles',
      'consecutive_bullish',
      'consecutive_rising',
      'change_pct',
      'change_pct_all',
      'change_pct_any',
      'change_pct_span',
      'turnover_single',
      'turnover_all',
      'turnover_any',
      'turnover_span',
      'volume_single',
      'volume_all',
      'volume_any',
      'volume_span',
      'amount_single',
      'amount_all',
      'amount_any',
      'amount_span',
      'vol_ratio_single',
      'vol_ratio_all',
      'vol_ratio_any',
      'vol_ratio_avg',
      'vol_ratio_consecutive',
      'consecutive_shrinking',
      'market_cap_single',
      'market_cap_all',
      'market_cap_any',
      'consecutive_falling',
      'new_high',
      'new_low',
      'ma_golden_cross',
      'ma_dead_cross',
      'ma_golden_cross_any',
      'ma_dead_cross_any',
      'stock_match',
      'stock_code',
      'stock_name',
      'market_cap',
    ])
    expect(Object.keys(CONDITION_DEFS_ZH)).toHaveLength(49)
    expect(CONDITION_DEFS_ZH.ma_bullish.defaults).toEqual({ periods: [5, 10, 20, 60], n: 1, m: 1 })
    expect(CONDITION_DEFS_ZH.close_above_ma.defaults).toEqual({ period: 5, n: 1, m: 1 })
    expect(CONDITION_DEFS_ZH.consecutive_bullish.defaults).toEqual({ start: 1, days: 4 })
    expect(CONDITION_DEFS_ZH.change_pct.defaults).toEqual({ n: 1, min: -30, max: 30 })
    expect(CONDITION_DEFS_ZH.ma_bullish.category).toBe('均线')
    expect(CONDITION_DEFS_ZH.more_bearish_candles.category).toBe('K 线')
    expect(CONDITION_DEFS_ZH.change_pct.category).toBe('涨跌幅')

    // 量价：默认区间按指标走，量比多一个回看天数
    expect(CONDITION_DEFS_ZH.turnover_single.defaults).toEqual({ n: 1, min: 0, max: 30 })
    expect(CONDITION_DEFS_ZH.volume_span.defaults).toEqual({ n: 1, m: 5, min: 0, max: 100000 })
    expect(CONDITION_DEFS_ZH.amount_span.defaults).toEqual({ n: 1, m: 5, min: 0, max: 100 })
    expect(CONDITION_DEFS_ZH.vol_ratio_single.defaults).toEqual({
      n: 1,
      min: 0,
      max: 10,
      window: 5,
    })
    expect(CONDITION_DEFS_ZH.consecutive_shrinking.defaults).toEqual({
      start: 1,
      days: 4,
      min: 0,
      max: 1,
      window: 5,
    })
    expect(CONDITION_DEFS_ZH.turnover_all.category).toBe('换手率')
    expect(CONDITION_DEFS_ZH.amount_all.category).toBe('成交额')
    expect(CONDITION_DEFS_ZH.vol_ratio_avg.category).toBe('量比')

    // 第二批
    expect(CONDITION_DEFS_ZH.new_high.defaults).toEqual({ m: 20, n: 1 })
    expect(CONDITION_DEFS_ZH.ma_golden_cross.defaults).toEqual({ fast: 5, slow: 10, n: 1, m: 1 })
    expect(CONDITION_DEFS_ZH.stock_match.defaults).toEqual({ text: '' })
    // 分类顺序覆盖全部分类，选择列表不会漏掉一整组
    expect(new Set(CONDITION_CATEGORIES)).toEqual(
      new Set(Object.values(CONDITION_DEFS_ZH).map(def => (def as { category: string }).category)),
    )
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

    expect(rise.summary({ start: 1, days: 3 })).toBe('倒数第3～1天连续3日上涨')
    expect(rise.summary({ start: 2, days: 3 })).toBe('倒数第4～2天连续3日上涨')
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

// ------------------------------------------------------------------ 量价条件

describe('量价条件（指标 × 形状）', () => {
  it('摘要把「倒数第 M～N 日」和单位写清楚', () => {
    expect(
      CONDITION_DEFS_ZH.turnover_single.summary({ n: 1, min: 5, max: 10 }),
    ).toBe('第 1 日换手率 ∈ (5%, 10%)')
    expect(
      CONDITION_DEFS_ZH.amount_all.summary({ n: 1, m: 5, min: 1, max: 3 }),
    ).toBe('倒数第5～1日每天成交额 ∈ (1亿元, 3亿元)')
    expect(
      CONDITION_DEFS_ZH.volume_any.summary({ n: 2, m: 6, min: 10, max: 20 }),
    ).toBe('倒数第6～2日任意一天成交量 ∈ (10万手, 20万手)')
    expect(
      CONDITION_DEFS_ZH.change_pct_span.summary({ n: 1, m: 10, min: 20, max: 60 }),
    ).toBe('倒数第10～1日涨跌幅 ∈ (20%, 60%)')
    expect(
      CONDITION_DEFS_ZH.turnover_span.summary({ n: 1, m: 30, min: 50, max: 120 }),
    ).toBe('倒数第30～1日累计换手率 ∈ (50%, 120%)')
    // 连续形状沿用「倒数第7～4天连续4日」的写法
    expect(
      CONDITION_DEFS_ZH.consecutive_shrinking.summary({
        start: 4,
        days: 4,
        min: 0,
        max: 1,
        window: 5,
      }),
    ).toBe('倒数第7～4天连续4日量比 ∈ (0倍, 1倍)，量比回看 5 日')
  })

  it('K 跟着条件和形状走（量比要多取回看天数）', () => {
    expect(CONDITION_DEFS_ZH.turnover_single.requiredBars({ n: 1, min: 0, max: 1 })).toBe(1)
    expect(CONDITION_DEFS_ZH.turnover_all.requiredBars({ n: 1, m: 5, min: 0, max: 1 })).toBe(5)
    // 涨跌幅要多取一根做 pre_close 回退
    expect(
      CONDITION_DEFS_ZH.change_pct_span.requiredBars({ n: 1, m: 5, min: 0, max: 1 }),
    ).toBe(6)
    expect(
      CONDITION_DEFS_ZH.vol_ratio_single.requiredBars({ n: 1, min: 0, max: 1, window: 5 }),
    ).toBe(6)
    expect(
      CONDITION_DEFS_ZH.consecutive_shrinking.requiredBars({
        start: 1,
        days: 4,
        min: 0,
        max: 1,
        window: 5,
      }),
    ).toBe(9)
  })

  it('区间形状的校验：M ≥ N、跨度 ≤ 30、下限 < 上限', () => {
    const issues = (params: object, tradingDays = 30) =>
      CONDITION_DEFS_ZH.turnover_all.validate(params as never, tradingDays)

    expect(issues({ n: 5, m: 3, min: 0, max: 1 }).join()).toContain('M ≥ N')
    // 窗口给到 250 才可能触发「跨度」这条（窗口 30 时 M 先被上界拦住）
    expect(issues({ n: 1, m: 31, min: 0, max: 1 }, 250).join()).toContain('区间跨度不能超过 30')
    expect(issues({ n: 1, m: 5, min: 9, max: 1 }).join()).toContain('下限必须小于上限')
    // 换手率不能为负（与后端 `_METRIC_BOUNDS` 一致）
    expect(issues({ n: 1, m: 5, min: -3, max: 1 }).join()).toContain('需在 0 至 1000 之间')
  })

  it('量比回看天数的边界是 1–60', () => {
    const issues = CONDITION_DEFS_ZH.vol_ratio_single.validate(
      { n: 1, min: 0, max: 10, window: 0 } as never,
      30,
    )
    expect(issues.join()).toContain('量比回看天数')
  })

  it('提交时每个键都要在，量比带 window、其余不带', () => {
    const withRatio = toApiRequest(
      req(group([cond('vol_ratio_single', { n: 2, min: 1.5, max: 4, window: 10 })])),
    )
    expect(withRatio.rule.children[0]).toMatchObject({
      params: { n: 2, min: 1.5, max: 4, window: 10 },
    })

    const plain = toApiRequest(
      req(group([cond('turnover_all', { n: 1, m: 5, min: 0, max: 3 })])),
    )
    expect(plain.rule.children[0]).toMatchObject({
      params: { n: 1, m: 5, min: 0, max: 3 },
    })

    // 字符串字段原样保留（后端 extra=forbid，键必须对得上）
    const stock = toApiRequest(req(group([cond('stock_match', { text: '600519' })])))
    expect(stock.rule.children[0]).toMatchObject({ params: { text: '600519' } })
  })

  it('空参数不会把 NaN 提交上去（回落到条件默认值）', () => {
    const submitted = toApiRequest(
      req(group([cond('turnover_single', { n: 1, min: Number.NaN, max: Number.NaN })])),
    )
    const params = submitted.rule.children[0] as { params: Record<string, number> }
    expect(Number.isFinite(params.params.min)).toBe(true)
    expect(Number.isFinite(params.params.max)).toBe(true)
  })
})

describe('数据截至（指定窗口结束日）', () => {
  it('留空按 null 提交，填了原样带上', () => {
    expect(toApiRequest(req(group([]))).asof).toBeNull()
    expect(toApiRequest(req(group([]), { asof: '2026-09-01' })).asof).toBe('2026-09-01')
    // 前后空格要走掉，否则后端 422
    expect(toApiRequest(req(group([]), { asof: ' 2026-09-01 ' })).asof).toBe('2026-09-01')
  })

  it('格式不对时前端就拦住', () => {
    expect(messages(validateScreenRequest(req(group([]), { asof: '2026/09/01' })))).toContain(
      'YYYY-MM-DD',
    )
    expect(messages(validateScreenRequest(req(group([]), { asof: '2026-09-01' })))).toBe('')
  })

  it('非交易日回退时横幅两种日期都写出来', () => {
    // 实际用 09-04、请求 09-05（周六）→ 文案里两个日期都在，用户不会以为没生效
    expect(SCREEN_TEXTS_ZH.asofFallback('2026-09-04', '2026-09-05')).toContain('2026-09-04')
    expect(SCREEN_TEXTS_ZH.asofFallback('2026-09-04', '2026-09-05')).toContain('2026-09-05')
  })
})

describe('总市值条件（2026-10-22 从基础筛选搬进条件列表）', () => {
  it('四个比较符的摘要写法', () => {
    const def = CONDITION_DEFS_ZH.market_cap
    expect(def.summary({ op: 'gt', value: 100 })).toBe('总市值 > 100 亿元')
    expect(def.summary({ op: 'gte', value: 100 })).toBe('总市值 ≥ 100 亿元')
    expect(def.summary({ op: 'lt', value: 200 })).toBe('总市值 < 200 亿元')
    expect(def.summary({ op: 'lte', value: 200 })).toBe('总市值 ≤ 200 亿元')
  })

  it('阈值越界 / 非数字都被拦；只取窗口末日那一根', () => {
    const def = CONDITION_DEFS_ZH.market_cap
    expect(def.validate({ op: 'gte', value: 100 }, 30)).toEqual([])
    expect(def.validate({ op: 'gte', value: -1 }, 30)).not.toEqual([])
    expect(def.validate({ op: 'gte', value: Number.NaN }, 30)).not.toEqual([])
    expect(def.requiredBars({ op: 'gte', value: 100 })).toBe(1)
  })

  it('三个历史市值条件都在「总市值」分类下，单位亿元', () => {
    for (const name of ['market_cap_single', 'market_cap_all', 'market_cap_any'] as const) {
      expect(CONDITION_DEFS_ZH[name].category).toBe('总市值')
    }
    expect(CONDITION_DEFS_ZH.market_cap_single.summary({ n: 1, min: 100, max: 200 })).toContain(
      '亿元',
    )
  })

  it('老条件文件里的基础市值区间翻译成两条条件（严格开区间）', () => {
    const legacy = req(group([cond('consecutive_bullish', { start: 1, days: 4 })]), {
      market_cap: { min_yi: 100, max_yi: 200 },
    })
    const migrated = migrateLegacyMarketCap(legacy)
    expect(migrated.children).toHaveLength(3)
    expect(formatRule(migrated)).toBe(
      '倒数第4～1天连续4日阳线 AND 总市值 > 100 亿元 AND 总市值 < 200 亿元',
    )
    const added = migrated.children.slice(1) as ConditionNode[]
    expect(added.every(node => node.name === 'market_cap')).toBe(true)
  })

  it('老默认区间 {1, 100000} 等于不限：不额外加条件', () => {
    const legacy = req(group([]), { market_cap: { min_yi: 1, max_yi: 100000 } })
    expect(migrateLegacyMarketCap(legacy).children).toHaveLength(0)
  })

  it('根组是 OR 时，市值条件套一层 AND（老区间与条件树是「且」）', () => {
    const legacy = req(
      { type: 'group', id: 'g', operator: 'OR', children: [cond('new_high', { m: 20 })] },
      { market_cap: { min_yi: 100, max_yi: 200 } },
    )
    const migrated = migrateLegacyMarketCap(legacy)
    const tail = migrated.children[1]
    expect(tail.type).toBe('group')
    if (tail.type === 'group') {
      expect(tail.operator).toBe('AND')
      expect(tail.children).toHaveLength(2)
    }
  })
})

describe('股票代码 / 股票名称（两个独立条件）', () => {
  it('注册表里有两条；老的 stock_match 仍在但不在可选列表里', () => {
    expect(CONDITION_DEFS_ZH.stock_code.label).toContain('股票代码')
    expect(CONDITION_DEFS_ZH.stock_name.label).toContain('股票名称')
    expect(CONDITION_DEFS_ZH.stock_match.hidden).toBe(true)
    expect(PICKABLE_CONDITION_NAMES).not.toContain('stock_match')
    expect(PICKABLE_CONDITION_NAMES).toContain('stock_code')
    expect(PICKABLE_CONDITION_NAMES).toContain('stock_name')
  })

  it('名称的说明写清了「不用带 ST 前缀」', () => {
    expect(CONDITION_DEFS_ZH.stock_name.description).toContain('ST')
  })

  it('提交时名称/代码的 text 原样保留（不做 trim 以外的加工）', () => {
    const payload = toApiRequest(req(group([cond('stock_code', { text: '600000,000001' })])))
    expect((payload.rule.children[0] as ConditionNode).params).toEqual({ text: '600000,000001' })
  })
})
