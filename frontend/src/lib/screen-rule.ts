/**
 * 条件选股：类型、条件注册表、条件树操作、校验与规则预览（需求规格 §7.1 / §6.2 / §6.3 / §10）。
 *
 * 为什么集中在这一个文件
 * --------------------
 * 弹窗里的「预览」「校验」「footer 的预计读取 K 根」全都是**纯函数**，没有请求、
 * 没有 DOM。放在 lib 里既能直接单测（`frontend/tests/fork/screen-rule.test.ts`），
 * 也保证「前端校验」与「后端校验」用的是同一份规则定义、同一套口径 ——
 * 后端 `src/modules/market/fork_screen/` 是同一套规则的另一方面实现，两边靠
 * 单测钉住相同的边界值（见 tests/test_fork_screen_validation.py）。
 *
 * 树操作全部不可变（immutable）：返回新树，原树引用不变。React 里靠引用比较
 * 决定重渲染，就地改会「数据变了界面不变」。
 */

import type { MarketRow } from '@/lib/fork-kline-summary'

export type ScreenMarket = 'sh' | 'sz' | 'cyb' | 'kcb'
/** 与 BOARD_OPTIONS 同序（去掉 ST —— ST 是独立开关，不是市场）。 */
export const SCREEN_MARKETS: ScreenMarket[] = ['sh', 'sz', 'cyb', 'kcb']
export type LogicOperator = 'AND' | 'OR'
export type MaPeriod = 5 | 10 | 20 | 30 | 60 | 120 | 250
export const MA_PERIODS: MaPeriod[] = [5, 10, 20, 30, 60, 120, 250]

export interface ConditionParamsMap {
  ma_bullish: { periods: MaPeriod[] }
  ma_bearish: { periods: MaPeriod[] }
  close_above_ma: { period: MaPeriod }
  more_bullish_candles: Record<string, never>
  more_bearish_candles: Record<string, never>
  consecutive_bullish: { start: number; days: number }
  consecutive_rising: { start: number; days: number }
  change_pct: { n: number; min: number; max: number }
}
export type ConditionName = keyof ConditionParamsMap

export type ConditionNode = {
  [K in ConditionName]: { type: 'condition'; id: string; name: K; params: ConditionParamsMap[K] }
}[ConditionName]

export interface GroupNode {
  type: 'group'
  id: string
  operator: LogicOperator
  children: RuleNode[]
  /** 纯 UI 状态，提交前剥掉（`toApiRequest`） */
  collapsed?: boolean
}
export type RuleNode = ConditionNode | GroupNode

export interface ScreenRequest {
  trading_days: number
  markets: ScreenMarket[]
  include_st: boolean
  market_cap: { min_yi: number; max_yi: number }
  rule: GroupNode
}

export interface ScreenStats {
  /** 基础筛选后的股票数 */
  candidates: number
  /** 实际求值的股票数（空树时为 0） */
  evaluated: number
  /** 至少一个条件因数据不足判 false 的股票数 */
  insufficient: number
  elapsed_ms: number
}

export interface ScreenResponse {
  asof: string | null
  total: number
  /** 与 market-table 的行完全同形（后端 `map_row` 产出），按 code 升序 */
  items: MarketRow[]
  window: { trading_days: number; fetched_bars: number; start_date: string | null }
  stats: ScreenStats
}

export interface ValidationIssue {
  /** 定位用：`trading_days` / `rule.children[0].children[1]` */
  path: string
  nodeId?: string
  message: string
}

// ------------------------------------------------------------------ 常量与文案

/** 上限（与后端 evaluator 的常量一致）。 */
export const MAX_DEPTH = 5
export const MAX_CONDITIONS = 30
export const MAX_CHILDREN = 20
export const MIN_TRADING_DAYS = 1
export const MAX_TRADING_DAYS = 250
export const MAX_MARKET_CAP_YI = 1_000_000
/** 连续阳线的天数上限（与 W 取小） */
export const MAX_CONSECUTIVE_DAYS = 30

/**
 * 界面文案。变量名以 `_ZH` 结尾 —— 仓库的 `check:i18n` 会把这种声明当成
 * 资源目录放行（fork 代码只有中文界面）。
 */
export const SCREEN_TEXTS_ZH = {
  button: '条件选股',
  buttonActive: '条件选股 · 已启用',
  title: '条件选股',
  description:
    '按基础范围和技术条件筛选 A 股，结果替换分析页列表。每个条件组独立选择 AND / OR，可嵌套 5 层。',
  baseTitle: '基础筛选',
  baseHint: '先在数据库层过滤，与下方条件树为『且』关系',
  tradingDays: '统计窗口',
  tradingDaysSuffix: '个交易日',
  tradingDaysPlaceholder: '1–250',
  tradingDaysHint: '1–250；均线等指标所需的更早历史自动补足，不计入窗口',
  marketCap: '总市值（亿元）',
  capMin: '>',
  capMax: '且 <',
  capMinLabel: '总市值下限',
  capMaxLabel: '总市值上限',
  capHint: '按总市值，严格大于下限、严格小于上限',
  market: '市场',
  marketAll: '全部',
  marketSh: '上证',
  marketSz: '深证',
  marketCyb: '创业',
  marketKcb: '科创',
  stIncluded: '含 ST',
  stExcluded: '不含 ST',
  baseSummary: (markets: string, st: string, min: number, max: number, days: number) =>
    `${markets} · ${st} · 总市值 ${min}–${max} 亿 · 窗口 ${days} 日`,
  st: 'ST 股票',
  includeSt: '包含 ST / *ST',
  ruleTitle: '条件组合',
  rootGroup: '根条件组',
  subGroup: '条件组',
  level: (n: number) => `第 ${n} 层`,
  andLabel: 'AND 同时满足',
  orLabel: 'OR 任一满足',
  addCondition: '+ 条件',
  addGroup: '+ 条件组',
  collapse: '折叠',
  expand: '展开',
  remove: '删除',
  edit: '编辑',
  copy: '复制',
  emptyRoot: '未添加技术条件：将仅按基础筛选选股',
  emptyGroup: '条件组为空',
  emptyGroupError: '条件组不能为空：请添加条件，或删除该组',
  previewTitle: '规则预览',
  previewEmptyRoot: '（无技术条件，仅按基础筛选）',
  previewEmptyGroup: '( 空组 )',
  footerMeta: (asof: string, bars: number, conditions: number, depth: number) =>
    `数据截至 ${asof} · 预计读取 ${bars} 根日线 · ${conditions} 个条件 / ${depth} 层`,
  footerMetaNoAsOf: (bars: number, conditions: number, depth: number) =>
    `预计读取 ${bars} 根日线 · ${conditions} 个条件 / ${depth} 层`,
  cancel: '取消',
  submit: '开始选股',
  submitting: '选股中…',
  issueSummary: (n: number) => `有 ${n} 处需要修正：`,
  failed: (message: string) => `选股失败：${message}。当前列表未改变。`,
  success: (total: number) => `已筛出 ${total} 只股票`,
  noMatch: '没有股票满足当前条件',
  bannerTitle: (total: number) => `条件选股结果：${total} 只`,
  bannerMeta: (asof: string, candidates: number, evaluated: number, insufficient: number, seconds: string) =>
    evaluated === candidates
      ? `数据截至 ${asof} · 基础筛选后 ${candidates} 只参与计算 · 缺数据排除 ${insufficient} 只 · 耗时 ${seconds} s`
      : `数据截至 ${asof} · 基础筛选后 ${candidates} 只，其中 ${evaluated} 只参与计算 · 缺数据排除 ${insufficient} 只 · 耗时 ${seconds} s`,
  editRule: '修改条件',
  rerun: '重新选股',
  exit: '退出选股',
  rerunFailed: (message: string) => `重新选股失败：${message}`,
  conflictHint: '同一 AND 组同时包含多头与空头排列，结果必然为空',
  pickerSearch: '搜索条件',
  pickerEmpty: '没有匹配的条件',
  paramConfirm: '确定',
  paramCancel: '取消',
  maxDepthHint: '最多嵌套 5 层',
  deleteGroupConfirm: (n: number) => `删除该条件组及其中 ${n} 个条件？`,
  deleteGroupTitle: '删除条件组',
  marketRequired: '至少选择一个市场',
  tradingDaysInvalid: '统计窗口需为 1–250 的整数',
  capMinInvalid: '总市值下限需为 ≥ 0 的数字',
  capMaxInvalid: '总市值上限不能超过 1,000,000 亿',
  capOrderInvalid: '下限必须小于上限',
  capDecimalsInvalid: '总市值最多保留 2 位小数',
  depthExceeded: '条件组最多嵌套 5 层',
  tooManyConditions: (max: number) => `条件数量过多（最多 ${max} 个）`,
  tooManyChildren: (max: number) => `单个条件组的子节点不能超过 ${max} 个`,
  periodsInvalid: '均线周期至少选 2 个且不能重复',
  periodInvalid: '均线周期不合法',
  daysInvalid: (max: number) => `连续天数需为 1 至 ${max} 的整数`,
  startInvalid: (max: number) => `倒数第几个交易日需为 1 至 ${max} 的整数`,
  spanInvalid: (max: number) => `起点与天数之和不能超过 ${max}（统计窗口上限）`,
  nInvalid: (max: number) => `N 需为 1 至 ${max} 之间的整数`,
  pctInvalid: '涨跌幅下限必须小于上限',
  pctRangeInvalid: '涨跌幅需在 -100 至 1000 之间',
  periodsLabel: '周期（可多选）',
  periodLabel: '周期',
  startLabel: '倒数第几个交易日',
  daysLabel: '连续天数',
  nLabel: 'N（倒数第几个交易日）',
  nShortLabel: 'N',
  changePctHint: (max: number) => `N = 倒数第几个交易日（1 – ${max}），下限/上限为百分比、开区间`,
  consecutiveHint: (start: number, days: number) =>
    `自倒数第 ${start} 个交易日起连续 ${days} 个交易日都收阳（收盘价 > 开盘价）`,
  pctMinLabel: '下限 %',
  pctMaxLabel: '上限 %',
  summaryMaOrder: (periods: string) => `均线多头排列(${periods})`,
  summaryMaBear: (periods: string) => `均线空头排列(${periods})`,
  summaryAboveMa: (period: number) => `收盘价站上 MA${period}`,
  summaryPct: (n: number, min: number, max: number) => `第 ${n} 日涨跌幅 ∈ (${min}%, ${max}%)`,
  /**
   * 连续类条件的摘要（用户第 3 / 4 条指定的写法）：
   *
   *   ``倒数第7～4天连续4日上涨``
   *
   * 起点是**最早**那天、终点是**最近**那天：``start=4`` + ``days=4`` 覆盖倒数第
   * 4、5、6、7 天，写出来就是「倒数第7～4天」。只连续 1 天时不写区间。
   * 老草稿里缺 start / days 时用条件自己的默认值兜底 —— 绝不再出现「连续 undefined 日」。
   */
  summaryConsecutive: (start: number | undefined, days: number | undefined) => {
    const part = consecutiveParts(start, days, 4)
    return `${part.span}连续${part.days}日阳线`
  },
  summaryRising: (start: number | undefined, days: number | undefined) => {
    const part = consecutiveParts(start, days, 3)
    return `${part.span}连续${part.days}日上涨`
  },
  consecutiveRisingHint: (start: number, days: number) =>
    `自倒数第 ${start} 个交易日起连续 ${days} 个交易日都上涨（收盘价 > 前收）`,
  summaryPeriodsJoin: '/',
}

/** 条件注册表：label / 分类 / 默认值 / 摘要 / 需要的根数 / 校验。 */
export interface ConditionDef<K extends ConditionName> {
  name: K
  label: string
  category: '均线' | 'K 线' | '涨跌幅'
  description: string
  defaults: ConditionParamsMap[K]
  summary: (p: ConditionParamsMap[K]) => string
  requiredBars: (p: ConditionParamsMap[K]) => number
  validate: (p: ConditionParamsMap[K], tradingDays: number) => string[]
}

type ConditionDefMap = { [K in ConditionName]: ConditionDef<K> }

const T = SCREEN_TEXTS_ZH

export const CONDITION_DEFS_ZH: ConditionDefMap = {
  ma_bullish: {
    name: 'ma_bullish',
    label: '均线多头排列',
    category: '均线',
    description: '短期均线在上、长期均线在下（MA5 > MA10 > MA20 > …）',
    defaults: { periods: [5, 10, 20, 60] },
    summary: p => T.summaryMaOrder([...p.periods].sort((a, b) => a - b).join(T.summaryPeriodsJoin)),
    requiredBars: p => Math.max(...p.periods, 1),
    validate: p => validateMaPeriods(p.periods),
  },
  ma_bearish: {
    name: 'ma_bearish',
    label: '均线空头排列',
    category: '均线',
    description: '短期均线在下、长期均线在上（MA5 < MA10 < MA20 < …）',
    defaults: { periods: [5, 10, 20, 60] },
    summary: p => T.summaryMaBear([...p.periods].sort((a, b) => a - b).join(T.summaryPeriodsJoin)),
    requiredBars: p => Math.max(...p.periods, 1),
    validate: p => validateMaPeriods(p.periods),
  },
  close_above_ma: {
    name: 'close_above_ma',
    label: '股价站上均线',
    category: '均线',
    description: '最新收盘价（复权）高于指定周期的均线',
    defaults: { period: 5 },
    summary: p => T.summaryAboveMa(p.period),
    requiredBars: p => p.period,
    validate: p => (MA_PERIODS.includes(p.period) ? [] : [T.periodInvalid]),
  },
  more_bullish_candles: {
    name: 'more_bullish_candles',
    label: '阳线多于阴线',
    category: 'K 线',
    description: '统计窗口内收阳的天数多于收阴的天数（平盘不计）',
    defaults: {},
    summary: () => '阳线多于阴线（统计窗口内）',
    requiredBars: () => 0,
    validate: () => [],
  },
  more_bearish_candles: {
    name: 'more_bearish_candles',
    label: '阴线多于阳线',
    category: 'K 线',
    description: '统计窗口内收阴的天数多于收阳的天数（平盘不计）',
    defaults: {},
    summary: () => '阴线多于阳线（统计窗口内）',
    requiredBars: () => 0,
    validate: () => [],
  },
  consecutive_bullish: {
    name: 'consecutive_bullish',
    label: '连续阳线（收盘 > 开盘）',
    category: 'K 线',
    description:
      '两个参数：倒数第几个交易日（默认 1 = 最近一个交易日）＋连续天数（默认 4）。' +
      '自倒数第 M 个交易日起连续 N 个交易日收盘价都高于开盘价（阳线），' +
      '中途有一根收阴、平盘或停牌缺数据就不成立。' +
      '注意：只看开盘价到收盘价，低开高走但全天仍下跌的那根也算阳线 —— ' +
      '要「当天真正上涨」请用另一条「连续上涨（涨幅 > 0）」',
    defaults: { start: 1, days: 4 },
    summary: p => T.summaryConsecutive(p.start, p.days),
    requiredBars: p => Math.max(1, consecutiveStart(p) - 1 + consecutiveDays(p, 4)),
    validate: (p, tradingDays) => {
      const limit = Math.min(tradingDays, MAX_CONSECUTIVE_DAYS)
      const issues: string[] = []
      if (!Number.isInteger(p.start) || p.start < 1 || p.start > limit) issues.push(T.startInvalid(limit))
      if (!Number.isInteger(p.days) || p.days < 1 || p.days > limit) issues.push(T.daysInvalid(limit))
      if (issues.length === 0 && p.start - 1 + p.days > limit) issues.push(T.spanInvalid(limit))
      return issues
    },
  },
  /**
   * 连续上涨（涨幅 > 0）：与「连续阳线」**不是同一个条件**（用户要求分成两条、
   * 名字里写清区别）。
   *
   *   阳线：收盘 > **开盘**（低开高走的那根也算，哪怕全天是跌的）
   *   上涨：收盘 > **前收**（那根低开回升但收跌 1.4% 的 K 线不算）
   */
  consecutive_rising: {
    name: 'consecutive_rising',
    label: '连续上涨（涨幅 > 0）',
    category: 'K 线',
    description:
      '两个参数：倒数第几个交易日（默认 1 = 最近一个交易日）＋连续天数（默认 3）。' +
      '自倒数第 M 个交易日起连续 N 个交易日收盘价都高于前一交易日收盘价（涨幅 > 0），' +
      '中途有一根下跌、平盘或停牌缺数据就不成立。' +
      '与「连续阳线（收盘 > 开盘）」的区别：那条只比开盘价，这条比的是当天涨跌幅',
    defaults: { start: 1, days: 3 },
    summary: p => T.summaryRising(p.start, p.days),
    // +1：前收缺失时要往回多取一根做回退
    requiredBars: p => Math.max(1, consecutiveStart(p) - 1 + consecutiveDays(p, 3) + 1),
    validate: (p, tradingDays) => {
      const limit = Math.min(tradingDays, MAX_CONSECUTIVE_DAYS)
      const issues: string[] = []
      if (!Number.isInteger(p.start) || p.start < 1 || p.start > limit) issues.push(T.startInvalid(limit))
      if (!Number.isInteger(p.days) || p.days < 1 || p.days > limit) issues.push(T.daysInvalid(limit))
      if (issues.length === 0 && p.start - 1 + p.days > limit) issues.push(T.spanInvalid(limit))
      return issues
    },
  },
  change_pct: {
    name: 'change_pct',
    label: '第 N 日涨跌幅',
    category: '涨跌幅',
    description: '倒数第 N 个交易日的涨跌幅落在区间内（开区间）',
    defaults: { n: 1, min: -30, max: 30 },
    summary: p => T.summaryPct(p.n, p.min, p.max),
    requiredBars: p => p.n + 1,
    validate: (p, tradingDays) => {
      const issues: string[] = []
      if (!Number.isInteger(p.n) || p.n < 1 || p.n > tradingDays) issues.push(T.nInvalid(tradingDays))
      if (!(p.min < p.max)) issues.push(T.pctInvalid)
      else if (!inPctRange(p.min) || !inPctRange(p.max)) issues.push(T.pctRangeInvalid)
      return issues
    },
  },
}

/** 涨跌幅取值区间（与后端 ``_validate_change_pct`` 一致）。 */
export const MIN_CHANGE_PCT = -100
export const MAX_CHANGE_PCT = 1000

/** 连续阳线的起点；缺（老草稿 / 老请求）按 1。 */
function consecutiveStart(params: { start?: number }): number {
  const start = Number(params.start)
  return Number.isFinite(start) && start >= 1 ? Math.trunc(start) : 1
}

/** 连续类条件的天数；缺失时用条件自己的默认值（防止 NaN 传进 requiredBars）。 */
function consecutiveDays(params: { days?: number }, fallback: number): number {
  const days = Number(params.days)
  return Number.isFinite(days) && days >= 1 ? Math.trunc(days) : fallback
}

/**
 * 连续类条件的「倒数第 a～b 天」＋天数（摘要与提示共用）。
 *
 * 语义与后端一致（``ctx.calendar[0]`` = asof，求值区间是
 * ``calendar[start-1 .. start-1+days)``）：``start`` 是**最近**那天、往回数 ``days``
 * 天。所以覆盖到的**最早**那天是 ``start + days - 1``，写出来是
 * ``倒数第(start+days-1)～start 天`` —— 用户第 3 / 4 条要的正是这个写法
 * （``start=4, days=4`` → 「倒数第7～4天」）。
 *
 * 两个参数都可能缺失（老草稿只带 days，或者存在服务器上的老条件文件里参数被
 * 丢空了）：缺失一律回落到默认值，**绝不拼出 undefined**。
 */
export function consecutiveParts(
  start: number | undefined,
  days: number | undefined,
  defaultDays: number,
): { span: string; days: number } {
  const rawStart = Number(start)
  const first = Number.isFinite(rawStart) && rawStart >= 1 ? Math.trunc(rawStart) : 1
  const rawDays = Number(days)
  const count = Number.isFinite(rawDays) && rawDays >= 1 ? Math.trunc(rawDays) : defaultDays
  const oldest = first + count - 1
  return {
    span: oldest === first ? `倒数第${first}天` : `倒数第${oldest}～${first}天`,
    days: count,
  }
}

function inPctRange(value: number): boolean {
  return value >= MIN_CHANGE_PCT && value <= MAX_CHANGE_PCT
}

// 无参数条件的摘要走固定文案（上面已写在各定义里，这里只导出分类顺序）

export const CONDITION_NAMES = Object.keys(CONDITION_DEFS_ZH) as ConditionName[]

/** 选择列表按分类分组（顺序：均线 → K 线 → 涨跌幅）。 */
export const CONDITION_CATEGORIES: Array<ConditionDef<ConditionName>['category']> = ['均线', 'K 线', '涨跌幅']

function validateMaPeriods(periods: MaPeriod[]): string[] {
  if (periods.length !== new Set(periods).size) return [T.periodsInvalid]
  if (periods.length < 2 || periods.length > 6) return [T.periodsInvalid]
  if (periods.some(p => !MA_PERIODS.includes(p))) return [T.periodInvalid]
  return []
}

// ------------------------------------------------------------------ id

let fallbackIdCounter = 0

/** 节点 id：优先 crypto.randomUUID，环境不支持时退回计数器。 */
export function newNodeId(): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID()
  fallbackIdCounter += 1
  return `n${fallbackIdCounter}`
}

// ------------------------------------------------------------------ 构造

export function createGroup(operator: LogicOperator = 'AND'): GroupNode {
  return { type: 'group', id: newNodeId(), operator, children: [] }
}

export function createCondition<K extends ConditionName>(name: K): ConditionNode {
  const def = CONDITION_DEFS_ZH[name]
  return {
    type: 'condition',
    id: newNodeId(),
    name,
    params: cloneParams(def.defaults) as ConditionParamsMap[K],
  } as ConditionNode
}

function cloneParams<P>(params: P): P {
  return JSON.parse(JSON.stringify(params)) as P
}

export function createDefaultRequest(): ScreenRequest {
  return {
    trading_days: 30,
    markets: [...SCREEN_MARKETS],
    include_st: false,
    market_cap: { min_yi: 1, max_yi: 100000 },
    rule: createGroup('AND'),
  }
}

// ------------------------------------------------------------------ 树操作（不可变）

export function updateNode(tree: GroupNode, id: string, updater: (node: RuleNode) => RuleNode): GroupNode {
  // 根节点也要能被更新（「往根组加条件 / 加子组」走的就是这条路径）
  if (tree.id === id) return updater(tree) as GroupNode
  const children = tree.children.map(child => {
    if (child.id === id) return updater(child)
    return child.type === 'group' ? updateNode(child, id, updater) : child
  })
  return { ...tree, children }
}

export function addChild(tree: GroupNode, groupId: string, node: RuleNode): GroupNode {
  return updateNode(tree, groupId, current => {
    if (current.type !== 'group') return current
    return { ...current, children: [...current.children, node] }
  })
}

export function removeNode(tree: GroupNode, id: string): GroupNode {
  const children: RuleNode[] = []
  for (const child of tree.children) {
    if (child.id === id) continue
    children.push(child.type === 'group' ? removeNode(child, id) : child)
  }
  return { ...tree, children }
}

export function findNode(tree: GroupNode, id: string): RuleNode | null {
  for (const child of tree.children) {
    if (child.id === id) return child
    if (child.type === 'group') {
      const found = findNode(child, id)
      if (found) return found
    }
  }
  return null
}

export function findParent(tree: GroupNode, id: string): GroupNode | null {
  for (const child of tree.children) {
    if (child.id === id) return tree
    if (child.type === 'group') {
      const found = findParent(child, id)
      if (found) return found
    }
  }
  return null
}

/** 复制一个条件：深拷贝参数、换新 id，插在原节点**后面**（同组内）。 */
export function duplicateNode(tree: GroupNode, id: string): GroupNode {
  const source = findNode(tree, id)
  if (!source || source.type !== 'condition') return tree
  const copy: ConditionNode = {
    type: 'condition',
    id: newNodeId(),
    name: source.name,
    params: cloneParams(source.params),
  } as ConditionNode
  const insert = (group: GroupNode): GroupNode => {
    const children: RuleNode[] = []
    for (const child of group.children) {
      children.push(child.type === 'group' ? insert(child) : child)
      if (child.id === id) children.push(copy)
    }
    return { ...group, children }
  }
  return insert(tree)
}

export function treeDepth(tree: GroupNode): number {
  let deepest = 1
  for (const child of tree.children) {
    if (child.type === 'group') deepest = Math.max(deepest, 1 + treeDepth(child))
  }
  return deepest
}

export function countConditions(tree: GroupNode): number {
  let total = 0
  for (const child of tree.children) {
    if (child.type === 'group') total += countConditions(child)
    else total += 1
  }
  return total
}

/** 子树里的节点 id（删除非空组时的确认文案要用）。 */
export function countConditionsIn(node: RuleNode): number {
  if (node.type === 'condition') return 1
  return countConditions(node)
}

/** 基础筛选的一句话摘要（横幅第二行用）。 */
export function summarizeBase(req: ScreenRequest): string {
  const marketLabels: Record<ScreenMarket, string> = {
    sh: T.marketSh,
    sz: T.marketSz,
    cyb: T.marketCyb,
    kcb: T.marketKcb,
  }
  const markets =
    req.markets.length === SCREEN_MARKETS.length
      ? T.marketAll
      : req.markets.map(m => marketLabels[m]).join(T.summaryPeriodsJoin)
  return T.baseSummary(
    markets,
    req.include_st ? T.stIncluded : T.stExcluded,
    req.market_cap.min_yi,
    req.market_cap.max_yi,
    req.trading_days,
  )
}

// ------------------------------------------------------------------ 校验

export function validateScreenRequest(req: ScreenRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const days = req.trading_days
  if (!Number.isInteger(days) || days < MIN_TRADING_DAYS || days > MAX_TRADING_DAYS) {
    issues.push({ path: 'trading_days', message: T.tradingDaysInvalid })
  }
  if (req.markets.length === 0) {
    issues.push({ path: 'markets', message: T.marketRequired })
  } else if (new Set(req.markets).size !== req.markets.length) {
    issues.push({ path: 'markets', message: T.marketRequired })
  }

  const cap = req.market_cap
  if (!(cap.min_yi >= 0)) issues.push({ path: 'market_cap.min_yi', message: T.capMinInvalid })
  if (!(cap.max_yi <= MAX_MARKET_CAP_YI)) issues.push({ path: 'market_cap.max_yi', message: T.capMaxInvalid })
  if (!hasTwoDecimals(cap.min_yi) || !hasTwoDecimals(cap.max_yi)) {
    issues.push({ path: 'market_cap', message: T.capDecimalsInvalid })
  } else if (!(cap.min_yi < cap.max_yi)) {
    issues.push({ path: 'market_cap', message: T.capOrderInvalid })
  }

  issues.push(...validateGroup(req.rule, 'rule', 1, days, { count: 0 }))
  return issues
}

function hasTwoDecimals(value: number): boolean {
  if (!Number.isFinite(value)) return false
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6
}

function validateGroup(
  node: GroupNode,
  path: string,
  depth: number,
  tradingDays: number,
  stats: { count: number },
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (depth > MAX_DEPTH) {
    return [{ path, nodeId: node.id, message: T.depthExceeded }]
  }
  if (node.children.length > MAX_CHILDREN) {
    issues.push({ path, nodeId: node.id, message: T.tooManyChildren(MAX_CHILDREN) })
  }
  if (depth > 1 && node.children.length === 0) {
    issues.push({ path, nodeId: node.id, message: T.emptyGroupError })
  }
  node.children.forEach((child, index) => {
    const childPath = `${path}.children[${index}]`
    if (child.type === 'group') {
      issues.push(...validateGroup(child, childPath, depth + 1, tradingDays, stats))
      return
    }
    stats.count += 1
    if (stats.count > MAX_CONDITIONS) {
      issues.push({ path: childPath, nodeId: child.id, message: T.tooManyConditions(MAX_CONDITIONS) })
      return
    }
    const def = CONDITION_DEFS_ZH[child.name]
    for (const message of def.validate(child.params as never, tradingDays)) {
      issues.push({ path: childPath, nodeId: child.id, message })
    }
  })
  return issues
}

// ------------------------------------------------------------------ 规则预览

export function formatRule(rule: GroupNode): string {
  return formatGroup(rule, true)
}

function formatGroup(node: GroupNode, isRoot: boolean): string {
  if (node.children.length === 0) return isRoot ? T.previewEmptyRoot : T.previewEmptyGroup
  const joiner = node.operator === 'AND' ? ' AND ' : ' OR '
  const inner = node.children.map(child => formatNode(child)).join(joiner)
  if (isRoot || node.children.length < 2) return inner
  return `( ${inner} )`
}

export function formatNode(node: RuleNode): string {
  if (node.type === 'group') return formatGroup(node, false)
  const def = CONDITION_DEFS_ZH[node.name]
  return def.summary(node.params as never)
}

/** 同一 AND 组里同时有多头与空头排列 → 结果必为空（非阻塞提示）。 */
export function findConflictGroup(rule: GroupNode): GroupNode | null {
  if (rule.operator === 'AND') {
    const names = new Set(rule.children.filter(c => c.type === 'condition').map(c => c.name))
    if (names.has('ma_bullish') && names.has('ma_bearish')) return rule
  }
  for (const child of rule.children) {
    if (child.type === 'group') {
      const found = findConflictGroup(child)
      if (found) return found
    }
  }
  return null
}

// ------------------------------------------------------------------ K 与提交

/** 前端算的 K（与后端 `required_bars_of_group` 同式，只用于 footer 的提示）。 */
export function requiredBarsOf(req: ScreenRequest): number {
  if (countConditions(req.rule) === 0) return 0
  // 窗口留空（NaN）时只按条件自己的预热需求算，footer 不会出现 NaN
  const days = Number.isFinite(req.trading_days) ? req.trading_days : 0
  return Math.max(days, requiredBarsOfGroup(req.rule))
}

function requiredBarsOfGroup(node: GroupNode): number {
  let best = 0
  for (const child of node.children) {
    if (child.type === 'group') best = Math.max(best, requiredBarsOfGroup(child))
    else best = Math.max(best, CONDITION_DEFS_ZH[child.name].requiredBars(child.params as never))
  }
  return best
}

/** 提交用：剥掉 `collapsed`、数字字段转 number（输入框里可能是字符串）。 */
export function toApiRequest(state: ScreenRequest): ScreenRequest {
  return {
    trading_days: Number(state.trading_days),
    markets: [...state.markets],
    include_st: Boolean(state.include_st),
    market_cap: {
      min_yi: Number(state.market_cap.min_yi),
      max_yi: Number(state.market_cap.max_yi),
    },
    rule: stripGroup(state.rule),
  }
}

function stripGroup(node: GroupNode): GroupNode {
  const children = node.children.map(child =>
    child.type === 'group'
      ? stripGroup(child)
      : ({
          type: 'condition',
          id: child.id,
          name: child.name,
          params: normalizeParams(child.name, child.params),
        } as ConditionNode),
  )
  return { type: 'group', id: node.id, operator: node.operator, children }
}

function normalizeParams<K extends ConditionName>(name: K, params: ConditionParamsMap[K]): ConditionParamsMap[K] {
  if (name === 'ma_bullish' || name === 'ma_bearish') {
    const p = params as ConditionParamsMap['ma_bullish']
    return { periods: p.periods.map(value => Number(value) as MaPeriod) } as ConditionParamsMap[K]
  }
  if (name === 'close_above_ma') {
    const p = params as ConditionParamsMap['close_above_ma']
    return { period: Number(p.period) as MaPeriod } as ConditionParamsMap[K]
  }
  if (name === 'consecutive_bullish' || name === 'consecutive_rising') {
    const p = params as ConditionParamsMap['consecutive_bullish']
    // start 缺失时按 1 处理：老草稿 / 老请求只带 days。
    // **两条连续条件必须走同一个分支** —— 上一版只写了 consecutive_bullish，
    // 「连续上涨」的 start/days 因此被整段丢掉（params 变成 {}），于是
    // 摘要显示「连续 undefined 日上涨」、提交时后端报两条「需为 1 至 30 的整数」。
    const start = Number(p.start)
    return {
      start: Number.isFinite(start) && start > 0 ? start : 1,
      days: Number(p.days),
    } as ConditionParamsMap[K]
  }
  if (name === 'change_pct') {
    const p = params as ConditionParamsMap['change_pct']
    return { n: Number(p.n), min: Number(p.min), max: Number(p.max) } as ConditionParamsMap[K]
  }
  return {} as ConditionParamsMap[K]
}

/**
 * 把缺失的参数补回条件自己的默认值（**不覆盖已有值**）。
 *
 * 用途：读「已保存条件」时修复老文件 —— 上一版前端在保存「连续上涨」时把
 * ``start`` / ``days`` 整段丢了（见 ``normalizeParams`` 的注释），服务器上可能还留着
 * 这类 ``params: {}`` 的条件。补默认值之后它们能正常回填、正常展示、正常提交。
 */
export function fillDefaultParams(rule: GroupNode): GroupNode {
  return {
    ...rule,
    children: rule.children.map(child => {
      if (child.type === 'group') return fillDefaultParams(child)
      const defaults = CONDITION_DEFS_ZH[child.name]?.defaults as Record<string, unknown> | undefined
      if (!defaults) return child
      const current = (child.params ?? {}) as Record<string, unknown>
      return { ...child, params: { ...defaults, ...current } } as RuleNode
    }),
  }
}
