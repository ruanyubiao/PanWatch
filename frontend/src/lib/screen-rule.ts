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

/** 总市值阈值的比较符（后端 `MarketCapOpParams.op` 同名）。 */
export type MarketCapOp = 'gt' | 'gte' | 'lt' | 'lte'

/** 量价指标（后端 `METRICS` 同名）。 */
export type MetricKey = 'pct' | 'turnover' | 'volume' | 'amount' | 'vol_ratio' | 'market_cap'
/** 量价条件的形状：单日 / 每日 / 任意一天 / 累计 / 连续。 */
export type MetricShape = 'single' | 'all' | 'any' | 'span' | 'consecutive'

/** 单日形状的参数（倒数第 n 日）。 */
export interface MetricSingleParams {
  n: number
  min: number
  max: number
}
/** 区间形状的参数（倒数第 n ～ m 日，n 更近）。 */
export interface MetricRangeParams {
  n: number
  m: number
  min: number
  max: number
}
/** 连续形状的参数（起点 + 天数）。 */
export interface MetricConsecutiveParams {
  start: number
  days: number
  min: number
  max: number
}
/** 量比多一个「回看几日均量」。 */
export interface RatioSingleParams extends MetricSingleParams {
  window: number
}
export interface RatioRangeParams extends MetricRangeParams {
  window: number
}
export interface RatioConsecutiveParams extends MetricConsecutiveParams {
  window: number
}

/**
 * 按日定位：``n`` = 倒数第几个交易日（1 = 窗口末日）。
 *
 * ``m`` 只给「范围内每日 / 范围内任意一天」用（倒数第 n～m 日）；
 * 单日条件也带着 `m`，让同一份参数形状在两种模式下都能提交。
 */
export interface DaySlot {
  n: number
  m: number
}
/** 均线排列（周期可多选）+ 按日定位。 */
export interface MaOrderDayParams extends DaySlot {
  periods: MaPeriod[]
}
/** 股价站上均线（单周期）+ 按日定位。 */
export interface MaDayParams extends DaySlot {
  period: MaPeriod
}
/** 金叉 / 死叉 + 按日定位。 */
export interface MaCrossDayParams extends DaySlot {
  fast: MaPeriod
  slow: MaPeriod
}
/**
 * 阴阳线计数的统计区间：D[n..m]。
 *
 * ``m = 0`` 是哨兵，表示「统计窗口的最后一天」—— 换统计窗口时跟着走，
 * 而不是钉死在保存那天的窗口长度（后端同名口径）。
 */
export interface CandleRangeParams {
  n: number
  m: number
}

export interface ConditionParamsMap {
  ma_bullish: MaOrderDayParams
  ma_bearish: MaOrderDayParams
  /** 均线多头排列 · 范围内每日 */
  ma_bullish_all: MaOrderDayParams
  /** 均线多头排列 · 范围内任意一天 */
  ma_bullish_any: MaOrderDayParams
  /** 均线空头排列 · 范围内每日 */
  ma_bearish_all: MaOrderDayParams
  /** 均线空头排列 · 范围内任意一天 */
  ma_bearish_any: MaOrderDayParams
  close_above_ma: MaDayParams
  /** 股价站上均线 · 范围内每日 */
  close_above_ma_all: MaDayParams
  /** 股价站上均线 · 范围内任意一天 */
  close_above_ma_any: MaDayParams
  more_bullish_candles: CandleRangeParams
  more_bearish_candles: CandleRangeParams
  consecutive_bullish: { start: number; days: number }
  consecutive_rising: { start: number; days: number }
  change_pct: { n: number; min: number; max: number }
  // ---- 涨跌幅（第二批：范围内每日 / 任意一天 / 区间）
  change_pct_all: MetricRangeParams
  change_pct_any: MetricRangeParams
  change_pct_span: MetricRangeParams
  // ---- 换手率
  turnover_single: MetricSingleParams
  turnover_all: MetricRangeParams
  turnover_any: MetricRangeParams
  turnover_span: MetricRangeParams
  // ---- 成交量
  volume_single: MetricSingleParams
  volume_all: MetricRangeParams
  volume_any: MetricRangeParams
  volume_span: MetricRangeParams
  // ---- 成交额
  amount_single: MetricSingleParams
  amount_all: MetricRangeParams
  amount_any: MetricRangeParams
  amount_span: MetricRangeParams
  // ---- 量比（放量 / 缩量）
  vol_ratio_single: RatioSingleParams
  vol_ratio_all: RatioRangeParams
  vol_ratio_any: RatioRangeParams
  vol_ratio_avg: RatioRangeParams
  vol_ratio_consecutive: RatioConsecutiveParams
  // ---- 第二批
  consecutive_falling: { start: number; days: number }
  consecutive_shrinking: RatioConsecutiveParams
  new_high: { m: number; n: number }
  new_low: { m: number; n: number }
  ma_golden_cross: MaCrossDayParams
  ma_dead_cross: MaCrossDayParams
  /** 均线金叉 · 范围内任意一天 */
  ma_golden_cross_any: MaCrossDayParams
  /** 均线死叉 · 范围内任意一天 */
  ma_dead_cross_any: MaCrossDayParams
  stock_match: { text: string }
  /** 股票代码（6 位）完整匹配；与「股票名称」是两个独立条件 */
  stock_code: { text: string }
  /** 股票名称完整匹配（可不带 ST / *ST 前缀） */
  stock_name: { text: string }
  /** 总市值阈值（亿元）：> / ≥ / < / ≤，比较倒数第 n 日那根 */
  market_cap: { op: MarketCapOp; value: number; n: number }
  /** 第 N 日总市值 */
  market_cap_single: MetricSingleParams
  /** 范围内每一天总市值 */
  market_cap_all: MetricRangeParams
  /** 范围内任意一天总市值 */
  market_cap_any: MetricRangeParams
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
  /**
   * 基础市值区间（亿元）。**只在读老条件文件时出现**：2026-10-22 起「总市值」
   * 搬进了条件列表（`market_cap` 条件），新请求不再带这个字段。
   */
  market_cap?: { min_yi: number; max_yi: number }
  rule: GroupNode
  /**
   * 统计窗口的**结束日**（`YYYY-MM-DD`）；留空/不传 = 库里最新交易日。
   * 30 个交易日从这一天往前数，非交易日由后端自动落到 ≤ 它的最大交易日。
   */
  asof?: string | null
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
  /** 用户填的日期（可能不是交易日）；没填时是 null */
  requested_asof?: string | null
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
  asofLabel: '窗口截止日',
  asofEnable: '启用',
  asofHint: '不勾「启用」= 最新交易日；勾上后 30 个交易日从这天往前数，非交易日自动取之前最近的交易日',
  asofInvalid: '数据截至需为 YYYY-MM-DD 格式的日期',
  asofFallback: (actual: string, requested: string) => `${actual}（请求 ${requested}，已回退到之前最近的交易日）`,
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
  baseSummary: (markets: string, st: string, days: number) =>
    `${markets} · ${st} · 窗口 ${days} 日`,
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
    // evaluated = 0 只有一种情况：条件树是空的（纯基础筛选，没有可算的技术条件）
    evaluated === 0
      ? `数据截至 ${asof} · 基础筛选后 ${candidates} 只（未设技术条件） · 耗时 ${seconds} s`
      : evaluated === candidates
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
  nInvalid: (max: number) => `n 需为 1 至 ${max} 之间的整数`,
  pctInvalid: '涨跌幅下限必须小于上限',
  pctRangeInvalid: '涨跌幅需在 -100 至 1000 之间',
  periodsLabel: '周期（可多选）',
  periodLabel: '周期',
  startLabel: '倒数第几个交易日',
  daysLabel: '连续天数',
  nLabel: 'n（倒数第几个交易日）',
  nShortLabel: 'n',
  // ---- 按日定位（2026-10-23 第 6 条：所有条件都能指定倒数第 N 日）
  dayLabel: '倒数第几个交易日',
  dayShortLabel: '倒数第 n 日',
  spanStartLabel: '起点 N',
  spanEndLabel: '终点 M',
  candleSpanTitle: '统计范围（起点 n ～ 终点 f）',
  dayInvalid: (max: number) => `倒数第几个交易日需为 1 至 ${max} 的整数`,
  spanStartInvalid: (max: number) => `起点 N 需为 1 至 ${max} 的整数`,
  spanEndInvalid: (n: number, max: number) => `终点 f 需为 ${n} 至 ${max} 的整数（f ≥ n）`,
  candleEndHint: '终点 M 留空 = 统计窗口的最后一天（默认）',
  /** 「倒数第 n 日」/「倒数第 m～n 日」——摘要里统一用这两个 */
  slotDay: (n: number) => `倒数第${n}日`,
  slotSpan: (n: number, m: number) => (n === m ? `倒数第${n}日` : `倒数第${m}～${n}日`),
  summaryMaOrderAt: (periods: string, suffix: string) => `均线多头排列(${periods})${suffix}`,
  summaryMaBearAt: (periods: string, suffix: string) => `均线空头排列(${periods})${suffix}`,
  summaryMaOrderSpan: (periods: string, slot: string) => `${slot} 每天均线多头排列(${periods})`,
  summaryMaBearSpan: (periods: string, slot: string) => `${slot} 每天均线空头排列(${periods})`,
  summaryMaOrderAny: (periods: string, slot: string) => `${slot} 任意一天均线多头排列(${periods})`,
  summaryMaBearAny: (periods: string, slot: string) => `${slot} 任意一天均线空头排列(${periods})`,
  summaryAboveAt: (period: number, suffix: string) => `收盘价站上 MA${period}${suffix}`,
  summaryAboveSpan: (period: number, slot: string) => `${slot} 每天收盘价站上 MA${period}`,
  summaryAboveAny: (period: number, slot: string) => `${slot} 任意一天收盘价站上 MA${period}`,
  summaryCrossAt: (fast: number, slow: number, label: string, slot: string) => `${label} MA${fast}/MA${slow} · ${slot}`,
  summaryCrossAny: (fast: number, slow: number, label: string, slot: string) =>
    `${slot} 任意一天${label}：MA${fast} / MA${slow}`,
  summaryCandleSpan: (slot: string, label: string) => `${slot} ${label}`,
  summaryCandleWindow: (label: string) => `${label}（统计窗口内）`,
  changePctHint: (max: number) => `n = 倒数第几个交易日（1 – ${max}），下限/上限为百分比、开区间`,
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

  // ---- 均线 / 阴阳线的按日形态（2026-10-23 第 3、4、5 条）
  labelMaOrder: '均线多头排列',
  labelMaBear: '均线空头排列',
  labelAboveMa: '股价站上均线',
  labelMoreBullish: '阳线多于阴线',
  labelMoreBearish: '阴线多于阳线',
  modeAll: '范围内每日',
  modeAny: '范围内任意一天',
  descMaOrder: (mode: 'day' | 'all' | 'any') =>
    mode === 'day'
      ? '倒数第 N 个交易日：短期均线在上、长期均线在下（MA5 > MA10 > MA20 > …）'
      : mode === 'all'
        ? '倒数第 N ～ M 个交易日的**每一天**都满足「短期均线在上、长期均线在下」'
        : '倒数第 N ～ M 个交易日里**至少有一天**满足「短期均线在上、长期均线在下」',
  descMaBear: (mode: 'day' | 'all' | 'any') =>
    mode === 'day'
      ? '倒数第 N 个交易日：短期均线在下、长期均线在上（MA5 < MA10 < MA20 < …）'
      : mode === 'all'
        ? '倒数第 N ～ M 个交易日的**每一天**都满足「短期均线在下、长期均线在上」'
        : '倒数第 N ～ M 个交易日里**至少有一天**满足「短期均线在下、长期均线在上」',
  descAboveMa: (mode: 'day' | 'all' | 'any') =>
    mode === 'day'
      ? '倒数第 N 个交易日的收盘价（复权）高于指定周期的均线'
      : mode === 'all'
        ? '倒数第 N ～ M 个交易日的每一天，收盘价（复权）都高于指定周期的均线'
        : '倒数第 N ～ M 个交易日里，至少有一天的收盘价（复权）高于指定周期的均线',
  descCrossDaySuffix: '；只看倒数第 N 个交易日当天',
  descCrossAnySuffix: '；倒数第 N ～ M 个交易日里任意一天发生就算命中',
  descMoreBullish:
    '在指定的 D[n..m] 窗口内，收阳的天数多于收阴的天数（平盘不计）。' +
    '终点 M 留空 = 整个统计窗口；N 默认 1（最近一个交易日）',
  descMoreBearish:
    '在指定的 D[n..m] 窗口内，收阴的天数多于收阳的天数（平盘不计）。' +
    '终点 M 留空 = 整个统计窗口；N 默认 1（最近一个交易日）',
}

/** 参数表单的形态（新增量价条件按这个渲染，不再按条件名写分支）。 */
export type ParamEditorKind =
  | 'metric-single'
  | 'metric-range'
  | 'metric-consecutive'
  | 'lookback'
  | 'ma-cross'
  | 'text'
  | 'market-cap-op'

/** 条件分类（选择列表按这个分组，顺序见 `CONDITION_CATEGORIES`）。 */
export type ConditionCategory =
  | '均线'
  | 'K 线'
  | '总市值'
  | '涨跌幅'
  | '换手率'
  | '成交量'
  | '成交额'
  | '量比'

/** 条件注册表：label / 分类 / 默认值 / 摘要 / 需要的根数 / 校验。 */
export interface ConditionDef<K extends ConditionName> {
  name: K
  label: string
  category: ConditionCategory
  description: string
  defaults: ConditionParamsMap[K]
  summary: (p: ConditionParamsMap[K]) => string
  requiredBars: (p: ConditionParamsMap[K]) => number
  validate: (p: ConditionParamsMap[K], tradingDays: number) => string[]
  /** 缺省时按条件名走老的专用表单（均线周期 / 连续阳线 / 涨跌幅） */
  editor?: ParamEditorKind
  /**
   * 按日选择器（2026-10-23 第 6 条：所有条件都能指定「倒数第 N 日」）。
   *
   * - ``single``：一个 N 输入框（默认 1 = 窗口末日，与以前完全一致）；
   * - ``range``：N + M 两个输入框（范围内每日 / 任意一天 / 阴阳线统计区间）。
   *
   * 表单按这个字段统一渲染，不再为每个条件各写一份 N 输入框。
   */
  daySelector?: 'single' | 'range' | 'range-window'
  /**
   * 不在「+ 条件」的选择列表里露出来（但注册表里保留）。
   *
   * 用途：``stock_match``（代码或名称合一）已被 ``stock_code`` / ``stock_name``
   * 取代，服务器上的老条件文件里还可能有它 —— 要能回填、能编辑、能提交，只是
   * 不再作为「新条件」推荐。
   */
  hidden?: boolean
}

type ConditionDefMap = { [K in ConditionName]: ConditionDef<K> }

const T = SCREEN_TEXTS_ZH

// ------------------------------------------------------------------ 量价条件

/**
 * 量价条件的界面文案。
 *
 * 变量名以 `_ZH` 结尾是这个仓库的硬约定：`check:i18n` 只放行「最近的 VariableDeclaration
 * 名字以 ZH/EN 结尾」的中文字面量（见 `scripts/check-i18n-literals.mjs`）。所以所有
 * 中文都收进这两个常量里，下面的构建函数只调用它们、不写字面量。
 */
export const METRIC_TEXTS_ZH = {
  label: {
    pct: '涨跌幅',
    turnover: '换手率',
    volume: '成交量',
    amount: '成交额',
    vol_ratio: '量比',
    market_cap: '总市值',
  } as Record<MetricKey, string>,
  unit: {
    pct: '%',
    turnover: '%',
    volume: '万手',
    amount: '亿元',
    vol_ratio: '倍',
    market_cap: '亿元',
  } as Record<MetricKey, string>,
  singleSummary: (n: number, label: string, unit: string, min: number, max: number) =>
    `第 ${n} 日${label} ∈ (${min}${unit}, ${max}${unit})`,
  allSummary: (m: number, n: number, label: string, unit: string, min: number, max: number) =>
    `倒数第${m}～${n}日每天${label} ∈ (${min}${unit}, ${max}${unit})`,
  anySummary: (m: number, n: number, label: string, unit: string, min: number, max: number) =>
    `倒数第${m}～${n}日任意一天${label} ∈ (${min}${unit}, ${max}${unit})`,
  spanPct: (m: number, n: number, label: string) => `倒数第${m}～${n}日${label}`,
  spanSum: (m: number, n: number, label: string) => `倒数第${m}～${n}日累计${label}`,
  spanAvg: (m: number, n: number, label: string) => `倒数第${m}～${n}日平均${label}`,
  spanSummary: (prefix: string, unit: string, min: number, max: number) =>
    `${prefix} ∈ (${min}${unit}, ${max}${unit})`,
  consecutiveSummary: (span: string, days: number, label: string, unit: string, min: number, max: number) =>
    `${span}连续${days}日${label} ∈ (${min}${unit}, ${max}${unit})`,
  ratioWindowSuffix: (window: number) => `，量比回看 ${window} 日`,
  hintSingle: (max: number) => `n = 倒数第几个交易日（1 – ${max}），上下限为开区间`,
  hintRange: (max: number) =>
    `起点 n 距今天最近、终点 f 更早（n ≤ f，1 – ${max}），跨度不超过 ${max} 个交易日；上下限为开区间`,
  hintConsecutive: '自倒数第 X 个交易日起连续 Y 个交易日都落在区间内；缺一根即不成立',
  hintVolRatio: '量比 = 当日成交量 ÷ 前若干交易日均量（不含当日），1 倍 = 平量',
  startLabel: '起点 n',
  endLabel: '终点 f',
  minLabel: '下限',
  maxLabel: '上限',
  windowLabel: '回看天数',
  lookbackLabel: '回看 M 日',
  crossFast: '快线',
  crossSlow: '慢线',
  stockLabel: '股票代码或名称',
  stockPlaceholder: '600519 或 贵州茅台',
  stockHint: '必须完整相等（不做模糊匹配）：代码填 6 位，多个用逗号或空格分隔',
  summaryLookback: (m: number, label: string) => `${label}（回看 ${m} 日）`,
  summaryCross: (fast: number, slow: number, label: string) => `${label}：MA${fast} / MA${slow}`,
  summaryStock: (text: string) => (text.trim() ? `股票 ∈ { ${text.trim()} }` : '股票（未填写）'),
  nInvalid: (max: number) => `n 需为 1 至 ${max} 之间的整数`,
  mInvalid: (max: number) => `f 需为 n 至 ${max} 之间的整数（f ≥ n）`,
  spanTooWide: (max: number) => `区间跨度不能超过 ${max} 个交易日`,
  rangeInvalid: (label: string) => `${label}下限必须小于上限`,
  boundsInvalid: (label: string, lo: number, hi: number) => `${label}需在 ${lo} 至 ${hi} 之间`,
  ratioWindowInvalid: '量比回看天数需为 1 至 60 的整数',
  lookbackInvalid: (max: number) => `回看天数需为 1 至 ${max} 的整数`,
  crossInvalid: '快线周期必须小于慢线周期',
  stockRequired: '请填写股票代码或名称',
  labelNewHigh: '收盘创 M 日新高',
  labelNewLow: '收盘创 M 日新低',
  descNewHigh: '最新收盘价（复权）高于之前 M 个交易日的最高收盘价，不含当日',
  descNewLow: '最新收盘价（复权）低于之前 M 个交易日的最低收盘价，不含当日',
  labelCrossUp: '均线金叉',
  labelCrossDown: '均线死叉',
  descCrossUp: '快线在上一交易日不高于慢线、今天高于慢线（默认 MA5 上穿 MA10）',
  descCrossDown: '快线在上一交易日不低于慢线、今天低于慢线（默认 MA5 下穿 MA10）',
  labelStockMatch: '股票代码或名称（完整匹配）',
  descStockMatch:
    '按代码（6 位）或名称完整相等筛选，不做模糊匹配；多个用逗号或空格分隔。名称要带 ST 前缀（如 *ST 康美）',
  labelFalling: '连续下跌（涨幅 < 0）',
  descFalling:
    '两个参数：倒数第几个交易日（默认 1）＋连续天数（默认 3）。每天都收跌（收盘价 < 前收），中途有一天不跌或停牌缺数据就不成立',
  summaryFalling: (span: string, days: number) => `${span}连续${days}日下跌`,
  unitSuffix: (unit: string) => `单位：${unit}`,
  lookbackHint: (max: number) => `回看 1 – ${max} 个交易日（不含当日）`,
  crossHint: '快线必须小于慢线；金叉 = 快线今天上穿慢线，死叉 = 下穿',
  nShortLabel: 'n',
  consecutiveStartLabel: '起点 n（倒数第几个交易日）',
  consecutiveDaysLabel: '连续天数',
  // ---- 总市值（2026-10-22 从基础筛选搬进条件列表）
  labelMarketCap: '总市值',
  descMarketCap:
    '窗口末日（数据截至那天）的总市值与阈值比较：大于 / 大于等于 / 小于 / 小于等于，单位亿元',
  summaryMarketCap: (op: string, value: number) => `总市值 ${op} ${value} 亿元`,
  marketCapValueLabel: '阈值（亿元）',
  marketCapOpLabel: '比较',
  marketCapHint: '比较的是窗口末日的总市值；停牌日市值照旧有效（停牌不改股本）',
  marketCapInvalid: (hi: number) => `总市值需为 0 至 ${hi} 亿元之间的数字`,
  opGt: '大于',
  opGte: '大于等于',
  opLt: '小于',
  opLte: '小于等于',
  opGtSymbol: '>',
  opGteSymbol: '≥',
  opLtSymbol: '<',
  opLteSymbol: '≤',
  // ---- 股票代码 / 股票名称（拆成两个条件）
  labelStockCode: '股票代码（完整匹配）',
  labelStockName: '股票名称（完整匹配）',
  descStockCode: '按 6 位代码完整相等筛选，不做模糊匹配；多个用逗号或空格分隔，彼此是「或」的关系',
  descStockName:
    '按股票名称完整相等筛选，不做模糊匹配；不用写 ST / *ST 前缀（写了也认），多个用逗号或空格分隔；多条代码/名称条件之间也是「或」',
  stockCodePlaceholder: '600519',
  stockNamePlaceholder: '贵州茅台',
  stockCodeRequired: '请填写股票代码',
  stockNameRequired: '请填写股票名称',
  summaryStockCode: (text: string) => (text.trim() ? `代码 ∈ { ${text.trim()} }` : '代码（未填写）'),
  summaryStockName: (text: string) => (text.trim() ? `名称 ∈ { ${text.trim()} }` : '名称（未填写）'),
} as const

/** 区间形状的跨度上限：= 统计窗口（用户第 8 条，30 不是常数）。保留导出给老调用方。 */
export const MAX_VALUE_SPAN = 30

/** 指标的取值边界（与后端 `_METRIC_BOUNDS` 一致）。 */
const METRIC_LIMITS: Record<MetricKey, [number, number]> = {
  pct: [-100, 1000],
  turnover: [0, 1000],
  volume: [0, 1e9],
  amount: [0, 1e9],
  vol_ratio: [0, 1e6],
  market_cap: [0, 1e6],
}

/** 指标的默认区间（与后端 `_METRIC_DEFAULTS` 一致）。 */
const METRIC_DEFAULTS: Record<MetricKey, [number, number]> = {
  pct: [-30, 30],
  turnover: [0, 30],
  volume: [0, 100000],
  amount: [0, 100],
  vol_ratio: [0, 10],
  market_cap: [0, 1000],
}

/** 指标 → 选择列表里的分组名。 */
const METRIC_CATEGORY_ZH: Record<MetricKey, ConditionCategory> = {
  pct: '涨跌幅',
  turnover: '换手率',
  volume: '成交量',
  amount: '成交额',
  vol_ratio: '量比',
  market_cap: '总市值',
}

interface MetricSeed {
  metric: MetricKey
  shape: MetricShape
  label: string
  description: string
  defaultMin?: number
  defaultMax?: number
}

/**
 * 量价条件的种子表：**指标 + 形状**决定求值循环，这里只给名字与文案。
 *
 * 加一条量价条件 = 在这个表里加一行（后端 `_VALUE_CONDITIONS` 同步加一行），
 * 不再写新的求值器、也不再写新的表单分支。
 */
const METRIC_SEEDS_ZH: Record<string, MetricSeed> = {
  change_pct_all: {
    metric: 'pct',
    shape: 'all',
    label: '涨跌幅 · 范围内每日',
    description: '倒数第 N ～ M 个交易日的每一天涨跌幅都落在区间内（开区间），任一天不满足即不成立',
  },
  change_pct_any: {
    metric: 'pct',
    shape: 'any',
    label: '涨跌幅 · 范围内任意一天',
    description: '倒数第 N ～ M 个交易日里至少有一天的涨跌幅落在区间内（开区间）',
  },
  change_pct_span: {
    metric: 'pct',
    shape: 'span',
    label: '区间涨跌幅',
    description: '倒数第 N 日相对倒数第 M 日的涨跌幅落在区间内（开区间）。按后复权价计算：N 日 30 元、M 日 20 元 → +50%',
  },
  turnover_single: {
    metric: 'turnover',
    shape: 'single',
    label: '第 N 日换手率',
    description: '倒数第 N 个交易日的换手率落在区间内（开区间，百分数）',
  },
  turnover_all: {
    metric: 'turnover',
    shape: 'all',
    label: '换手率 · 范围内每日',
    description: '倒数第 N ～ M 个交易日每天的换手率都落在区间内（开区间）',
  },
  turnover_any: {
    metric: 'turnover',
    shape: 'any',
    label: '换手率 · 范围内任意一天',
    description: '倒数第 N ～ M 个交易日里至少有一天的换手率落在区间内（开区间）',
  },
  turnover_span: {
    metric: 'turnover',
    shape: 'span',
    label: '区间累计换手率',
    description: '倒数第 N ～ M 个交易日的换手率之和落在区间内（开区间，可理解为这段时间换了多少遍手）',
  },
  volume_single: {
    metric: 'volume',
    shape: 'single',
    label: '第 N 日成交量',
    description: '倒数第 N 个交易日的成交量落在区间内（开区间，单位万手）',
  },
  volume_all: {
    metric: 'volume',
    shape: 'all',
    label: '成交量 · 范围内每日',
    description: '倒数第 N ～ M 个交易日每天的成交量都落在区间内（开区间，单位万手）',
  },
  volume_any: {
    metric: 'volume',
    shape: 'any',
    label: '成交量 · 范围内任意一天',
    description: '倒数第 N ～ M 个交易日里至少有一天的成交量落在区间内（开区间，单位万手）',
  },
  volume_span: {
    metric: 'volume',
    shape: 'span',
    label: '区间累计成交量',
    description: '倒数第 N ～ M 个交易日的成交量合计落在区间内（开区间，单位万手）',
  },
  amount_single: {
    metric: 'amount',
    shape: 'single',
    label: '第 N 日成交额',
    description: '倒数第 N 个交易日的成交额落在区间内（开区间，单位亿元）',
  },
  amount_all: {
    metric: 'amount',
    shape: 'all',
    label: '成交额 · 范围内每日',
    description: '倒数第 N ～ M 个交易日每天的成交额都落在区间内（开区间，单位亿元）',
  },
  amount_any: {
    metric: 'amount',
    shape: 'any',
    label: '成交额 · 范围内任意一天',
    description: '倒数第 N ～ M 个交易日里至少有一天的成交额落在区间内（开区间，单位亿元）',
  },
  amount_span: {
    metric: 'amount',
    shape: 'span',
    label: '区间累计成交额',
    description: '倒数第 N ～ M 个交易日的成交额合计落在区间内（开区间，单位亿元）',
  },
  vol_ratio_single: {
    metric: 'vol_ratio',
    shape: 'single',
    label: '某日量比（放量 / 缩量）',
    description: '倒数第 N 个交易日的量比落在区间内（开区间）。量比 = 当日量 ÷ 前若干日均量，只填下限就是放量、只填上限就是缩量',
  },
  vol_ratio_all: {
    metric: 'vol_ratio',
    shape: 'all',
    label: '量比 · 范围内每日',
    description: '倒数第 N ～ M 个交易日每天的量比都落在区间内（开区间）',
  },
  vol_ratio_any: {
    metric: 'vol_ratio',
    shape: 'any',
    label: '量比 · 范围内任意一天',
    description: '倒数第 N ～ M 个交易日里至少有一天的量比落在区间内（开区间）',
  },
  vol_ratio_avg: {
    metric: 'vol_ratio',
    shape: 'span',
    label: '区间平均量比',
    description: '倒数第 N ～ M 个交易日量比的平均值落在区间内（开区间），用来看「这一段时间整体放量没有」',
  },
  vol_ratio_consecutive: {
    metric: 'vol_ratio',
    shape: 'consecutive',
    label: '连续 N 日量比落在区间',
    description: '自倒数第 M 个交易日起连续 N 个交易日量比都落在区间内（开区间）。留空下限=连续放量的门槛，留空上限=连续缩量',
    defaultMin: 0,
    defaultMax: 10,
  },
  consecutive_shrinking: {
    metric: 'vol_ratio',
    shape: 'consecutive',
    label: '连续缩量（量比 < 上限）',
    description: '自倒数第 M 个交易日起连续 N 个交易日量比都小于上限（开区间），与「连续放量」是同一个条件的两侧',
    defaultMin: 0,
    defaultMax: 1,
  },
  market_cap_single: {
    metric: 'market_cap',
    shape: 'single',
    label: '第 N 日总市值',
    description: '倒数第 N 个交易日的总市值落在区间内（开区间，单位亿元）',
  },
  market_cap_all: {
    metric: 'market_cap',
    shape: 'all',
    label: '总市值 · 范围内每日',
    description: '倒数第 N ～ M 个交易日每天的总市值都落在区间内（开区间，单位亿元）',
  },
  market_cap_any: {
    metric: 'market_cap',
    shape: 'any',
    label: '总市值 · 范围内任意一天',
    description: '倒数第 N ～ M 个交易日里至少有一天的总市值落在区间内（开区间，单位亿元）',
  },
}

/** 量价条件的构建器：指标 × 形状 → 完整注册项。 */
function metricDef<K extends ConditionName>(name: K): ConditionDef<K> {
  const seed = METRIC_SEEDS_ZH[name]
  const { metric, shape } = seed
  const [lo, hi] = METRIC_DEFAULTS[metric]
  const min = seed.defaultMin ?? lo
  const max = seed.defaultMax ?? hi
  const core =
    shape === 'single'
      ? { n: 1, min, max }
      : shape === 'consecutive'
        ? { start: 1, days: 4, min, max }
        : { n: 1, m: 5, min, max }
  const defaults = metric === 'vol_ratio' ? { ...core, window: 5 } : core
  return {
    name,
    label: seed.label,
    category: METRIC_CATEGORY_ZH[metric],
    description: seed.description,
    defaults: defaults as ConditionParamsMap[K],
    summary: p => metricSummary(metric, shape, p as unknown as Record<string, number>),
    requiredBars: p => metricRequiredBars(metric, shape, p as unknown as Record<string, number>),
    validate: (p, tradingDays) =>
      metricValidate(metric, shape, p as unknown as Record<string, number>, tradingDays),
    editor:
      shape === 'single'
        ? 'metric-single'
        : shape === 'consecutive'
          ? 'metric-consecutive'
          : 'metric-range',
  }
}

function metricSummary(
  metric: MetricKey,
  shape: MetricShape,
  p: Record<string, number>,
): string {
  const M = METRIC_TEXTS_ZH
  const label = M.label[metric]
  const unit = M.unit[metric]
  const tail = metric === 'vol_ratio' ? M.ratioWindowSuffix(p.window) : ''
  if (shape === 'single') return M.singleSummary(p.n, label, unit, p.min, p.max) + tail
  if (shape === 'all') return M.allSummary(p.m, p.n, label, unit, p.min, p.max) + tail
  if (shape === 'any') return M.anySummary(p.m, p.n, label, unit, p.min, p.max) + tail
  if (shape === 'consecutive') {
    const part = consecutiveParts(p.start, p.days, 4)
    return M.consecutiveSummary(part.span, part.days, label, unit, p.min, p.max) + tail
  }
  const prefix =
    metric === 'pct'
      ? M.spanPct(p.m, p.n, label)
      : metric === 'vol_ratio'
        ? M.spanAvg(p.m, p.n, label)
        : M.spanSum(p.m, p.n, label)
  return M.spanSummary(prefix, unit, p.min, p.max) + tail
}

function metricRequiredBars(
  metric: MetricKey,
  shape: MetricShape,
  p: Record<string, number>,
): number {
  const warm =
    metric === 'pct'
      ? 1 // pre_close 缺失时回退前一根
      : metric === 'vol_ratio'
        ? Math.max(1, Number(p.window) || 5)
        : 0
  if (shape === 'single') return Math.max(1, p.n) + warm
  if (shape === 'consecutive') {
    return Math.max(1, consecutiveStart(p)) - 1 + consecutiveDays(p, 4) + warm
  }
  return Math.max(1, p.m) + warm
}

function metricValidate(
  metric: MetricKey,
  shape: MetricShape,
  p: Record<string, number>,
  tradingDays: number,
): string[] {
  const M = METRIC_TEXTS_ZH
  const label = M.label[metric]
  const limit = Math.max(1, Number.isFinite(tradingDays) ? tradingDays : 1)
  const [lo, hi] = METRIC_LIMITS[metric]
  const issues: string[] = []

  if (shape === 'consecutive') {
    const span = limit
    if (!Number.isInteger(p.start) || p.start < 1 || p.start > span) issues.push(T.startInvalid(span))
    if (!Number.isInteger(p.days) || p.days < 1 || p.days > span) issues.push(T.daysInvalid(span))
    if (issues.length === 0 && p.start - 1 + p.days > span) issues.push(T.spanInvalid(span))
  } else {
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > limit) issues.push(M.nInvalid(limit))
    if (shape !== 'single') {
      if (!Number.isInteger(p.m) || p.m < p.n || p.m > limit) issues.push(M.mInvalid(limit))
      // 跨度上限 = 统计窗口（用户第 8 条：30 不是常数）
      else if (p.m - p.n + 1 > limit) issues.push(M.spanTooWide(limit))
    }
  }

  if (!(p.min < p.max)) issues.push(M.rangeInvalid(label))
  else if (p.min < lo || p.max > hi) issues.push(M.boundsInvalid(label, lo, hi))

  if (metric === 'vol_ratio' && (!Number.isInteger(p.window) || p.window < 1 || p.window > 60)) {
    issues.push(M.ratioWindowInvalid)
  }
  return issues
}

/** 第二批：创 M 日新高 / 新低（可按倒数第 N 日判断）。 */
function lookbackDef<K extends ConditionName>(name: K, high: boolean): ConditionDef<K> {
  const M = METRIC_TEXTS_ZH
  const label = high ? M.labelNewHigh : M.labelNewLow
  return {
    name,
    label,
    category: 'K 线',
    description: high ? M.descNewHigh : M.descNewLow,
    defaults: { m: 20, n: 1 } as ConditionParamsMap[K],
    summary: p => {
      const params = p as { m: number; n?: number }
      return `${M.summaryLookback(params.m, label)}${daySuffix(daySlot(params))}`
    },
    requiredBars: p => {
      const params = p as { m: number; n?: number }
      return daySlot(params) - 1 + Math.max(1, params.m) + 1
    },
    validate: (p, tradingDays) => {
      const params = p as { m: number; n?: number }
      const m = Number(params.m)
      const limit = Math.min(Math.max(1, tradingDays || 1), 250)
      if (!Number.isInteger(m) || m < 1 || m > limit) return [M.lookbackInvalid(limit)]
      return checkDay(rawDay(params), tradingDays)
    },
    editor: 'lookback',
    daySelector: 'single',
  }
}

/**
 * 均线金叉 / 死叉。
 *
 * ``mode='day'`` 看倒数第 N 日当天；``mode='any'`` 看 D[n..m] 里任意一天
 * （用户第 4 条：金叉 / 死叉只要「倒数第 N 日」和「范围内任意一天」两种）。
 */
function crossDef<K extends ConditionName>(name: K, upward: boolean, mode: MaDayMode = 'day'): ConditionDef<K> {
  const M = METRIC_TEXTS_ZH
  const label = upward ? M.labelCrossUp : M.labelCrossDown
  return {
    name,
    label: mode === 'day' ? label : `${label} · ${T.modeAny}`,
    category: '均线',
    description: (upward ? M.descCrossUp : M.descCrossDown) + (mode === 'any' ? T.descCrossAnySuffix : T.descCrossDaySuffix),
    defaults: { fast: 5, slow: 10, n: 1, m: mode === 'day' ? 1 : 5 } as ConditionParamsMap[K],
    summary: p => {
      const params = p as MaCrossDayParams
      return mode === 'day'
        ? M.summaryCross(params.fast, params.slow, label) + daySuffix(daySlot(params))
        : T.summaryCrossAny(params.fast, params.slow, label, T.slotSpan(daySlot(params), dayEnd(params, 1)))
    },
    requiredBars: p => {
      const params = p as MaCrossDayParams
      const need = Math.max(1, params.slow) + 1
      return mode === 'day' ? daySlot(params) - 1 + need : dayEnd(params, 1) - 1 + need
    },
    validate: (p, tradingDays) => {
      const { fast, slow } = p as MaCrossDayParams
      const params = p as MaCrossDayParams
      if (!MA_PERIODS.includes(fast) || !MA_PERIODS.includes(slow)) return [T.periodInvalid]
      if (fast >= slow) return [M.crossInvalid]
      return mode === 'day'
        ? checkDay(rawDay(params), tradingDays)
        : checkSpan(rawDay(params), rawEnd(params), tradingDays)
    },
    editor: 'ma-cross',
    daySelector: mode === 'day' ? 'single' : 'range',
  }
}

/** 股票代码或名称（完整匹配）。 */
function stockMatchDef(): ConditionDef<'stock_match'> {
  const M = METRIC_TEXTS_ZH
  return {
    name: 'stock_match',
    label: M.labelStockMatch,
    category: 'K 线',
    description: M.descStockMatch,
    defaults: { text: '' },
    summary: p => M.summaryStock(p.text),
    // 不需要日线，但要 ≥1 让取数层仍然取日历（K=0 会让整段取数被跳过）
    requiredBars: () => 1,
    validate: p => (p.text.trim() ? [] : [M.stockRequired]),
    editor: 'text',
    // 已被 stock_code / stock_name 取代：老条件文件仍能回填编辑，但不再出现在选择列表
    hidden: true,
  }
}

/** 股票代码（完整匹配）。 */
function stockCodeDef(): ConditionDef<'stock_code'> {
  const M = METRIC_TEXTS_ZH
  return {
    name: 'stock_code',
    label: M.labelStockCode,
    category: 'K 线',
    description: M.descStockCode,
    defaults: { text: '' },
    summary: p => M.summaryStockCode(p.text),
    requiredBars: () => 1,
    validate: p => (p.text.trim() ? [] : [M.stockCodeRequired]),
    editor: 'text',
  }
}

/** 股票名称（完整匹配，忽略 ST / *ST 前缀）。 */
function stockNameDef(): ConditionDef<'stock_name'> {
  const M = METRIC_TEXTS_ZH
  return {
    name: 'stock_name',
    label: M.labelStockName,
    category: 'K 线',
    description: M.descStockName,
    defaults: { text: '' },
    summary: p => M.summaryStockName(p.text),
    requiredBars: () => 1,
    validate: p => (p.text.trim() ? [] : [M.stockNameRequired]),
    editor: 'text',
  }
}

/** 总市值阈值（> / ≥ / < / ≤，单位亿元），可按倒数第 N 日比较。 */
function marketCapDef(): ConditionDef<'market_cap'> {
  const M = METRIC_TEXTS_ZH
  return {
    name: 'market_cap',
    label: M.labelMarketCap,
    category: '总市值',
    description: M.descMarketCap,
    defaults: { op: 'gte', value: 100, n: 1 },
    // 摘要用符号（大于/大于等于写进摘要太长，一眼看不出比较方向）
    summary: p =>
      M.summaryMarketCap(
        p.op === 'gt'
          ? M.opGtSymbol
          : p.op === 'lt'
            ? M.opLtSymbol
            : p.op === 'lte'
              ? M.opLteSymbol
              : M.opGteSymbol,
        p.value,
      ) + daySuffix(daySlot(p)),
    // 倒数第 N 日那一根
    requiredBars: p => daySlot(p),
    validate: (p, tradingDays) => {
      const value = Number(p.value)
      if (!Number.isFinite(value) || value < 0 || value > MAX_MARKET_CAP_YI) {
        return [M.marketCapInvalid(MAX_MARKET_CAP_YI)]
      }
      return checkDay(rawDay(p), tradingDays)
    },
    editor: 'market-cap-op',
    daySelector: 'single',
  }
}

/** 连续下跌：与「连续上涨」镜像，参数形状一样。 */
function fallingDef(): ConditionDef<'consecutive_falling'> {
  const M = METRIC_TEXTS_ZH
  return {
    name: 'consecutive_falling',
    label: M.labelFalling,
    category: 'K 线',
    description: M.descFalling,
    defaults: { start: 1, days: 3 },
    summary: p => {
      const part = consecutiveParts(p.start, p.days, 3)
      return M.summaryFalling(part.span, part.days)
    },
    requiredBars: p => Math.max(1, consecutiveStart(p)) - 1 + consecutiveDays(p, 3) + 1,
    validate: (p, tradingDays) => {
      const limit = Math.max(1, Math.trunc(tradingDays || 1))
      const issues: string[] = []
      if (!Number.isInteger(p.start) || p.start < 1 || p.start > limit) issues.push(T.startInvalid(limit))
      if (!Number.isInteger(p.days) || p.days < 1 || p.days > limit) issues.push(T.daysInvalid(limit))
      if (issues.length === 0 && p.start - 1 + p.days > limit) issues.push(T.spanInvalid(limit))
      return issues
    },
  }
}

// ---------------------------------------------------------------- 按日定位的工具

/** 倒数第 n 日（缺失 / 非法按 1：老预设里没有这个字段）。 */
export function daySlot(params: { n?: number }): number {
  const value = Number(params.n)
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : 1
}

/**
 * 区间终点 M：``0`` / 空 = 整个统计窗口（'' 哨兵，见 ``CandleRangeParams``）。
 * 摘要与校验都走它，保证界面上写的和提交的一致。
 */
export function dayEnd(params: { m?: number }, tradingDays: number): number {
  const value = Number(params.m)
  if (!Number.isFinite(value) || value <= 0) return Math.max(1, Math.trunc(tradingDays || 1))
  return Math.trunc(value)
}

function checkDay(n: number, tradingDays: number): string[] {
  const limit = Math.max(1, Math.trunc(tradingDays || 1))
  return Number.isInteger(n) && n >= 1 && n <= limit ? [] : [T.dayInvalid(limit)]
}

/**
 * 校验用的原始 N：**缺失**按 1（老预设没有这个字段），但显式写的非法值
 * （0 / 负数 / 小数 / 超窗口）原样进入校验 —— 不能被 ``daySlot`` 悄悄夹回 1。
 */
function rawDay(params: { n?: number }): number {
  const value = params.n
  if (value === undefined || value === null) return 1
  return Number(value)
}

/** 校验用的原始 M（同上；0 / 缺失都交给调用方决定含义）。 */
function rawEnd(params: { m?: number }): number {
  const value = params.m
  if (value === undefined || value === null) return 1
  return Number(value)
}

/**
 * 单日条件的摘要后缀：``n = 1``（默认）不写 —— 「没指定 = 倒数第 1 日」，
 * 每条摘要都拖一句「· 倒数第1日」只是噪音；指定了才写出来。
 */
function daySuffix(n: number): string {
  return n === 1 ? '' : ` · ${T.slotDay(n)}`
}

function checkSpan(n: number, m: number, tradingDays: number): string[] {
  const limit = Math.max(1, Math.trunc(tradingDays || 1))
  const issues: string[] = []
  if (!Number.isInteger(n) || n < 1 || n > limit) issues.push(T.spanStartInvalid(limit))
  if (!Number.isInteger(m) || m < n || m > limit) issues.push(T.spanEndInvalid(n, limit))
  else if (issues.length === 0 && m - n + 1 > limit) issues.push(METRIC_TEXTS_ZH.spanTooWide(limit))
  return issues
}

type MaDayMode = 'day' | 'all' | 'any'

/**
 * 均线排列的三种按日形态（用户第 3 条）：倒数第 N 日 / 范围内每日 / 范围内任意一天。
 *
 * 三种形态共用「周期多选」这一个参数块，差别只在按日定位与摘要措辞 ——
 * 所以用工厂生成，避免三段几乎一样的代码各自漂移。
 */
function maOrderDef<K extends ConditionName>(name: K, mode: MaDayMode, bullish: boolean): ConditionDef<K> {
  const M = T
  const periodText = (p: MaOrderDayParams) =>
    [...p.periods].sort((a, b) => a - b).join(T.summaryPeriodsJoin)
  const label = bullish ? M.labelMaOrder : M.labelMaBear
  return {
    name,
    label: mode === 'day' ? label : `${label} · ${mode === 'all' ? M.modeAll : M.modeAny}`,
    category: '均线',
    description: bullish ? M.descMaOrder(mode) : M.descMaBear(mode),
    defaults: { periods: [5, 10, 20, 60], n: 1, m: mode === 'day' ? 1 : 5 } as ConditionParamsMap[K],
    summary: p => {
      const params = p as MaOrderDayParams
      if (mode === 'day') {
        return bullish
          ? M.summaryMaOrderAt(periodText(params), daySuffix(daySlot(params)))
          : M.summaryMaBearAt(periodText(params), daySuffix(daySlot(params)))
      }
      const slot = M.slotSpan(daySlot(params), dayEnd(params, 1))
      if (mode === 'all')
        return bullish ? M.summaryMaOrderSpan(periodText(params), slot) : M.summaryMaBearSpan(periodText(params), slot)
      return bullish ? M.summaryMaOrderAny(periodText(params), slot) : M.summaryMaBearAny(periodText(params), slot)
    },
    requiredBars: p => {
      const params = p as MaOrderDayParams
      const need = Math.max(...params.periods, 1)
      return mode === 'day' ? daySlot(params) - 1 + need : dayEnd(params, 1) - 1 + need
    },
    validate: (p, tradingDays) => {
      const params = p as MaOrderDayParams
      const issues = validateMaPeriods(params.periods)
      return issues.length
        ? issues
        : mode === 'day'
          ? checkDay(rawDay(params), tradingDays)
          : checkSpan(rawDay(params), rawEnd(params), tradingDays)
    },
    daySelector: mode === 'day' ? 'single' : 'range',
  }
}

/** 股价站上均线的三种按日形态。 */
function maAboveDef<K extends ConditionName>(name: K, mode: MaDayMode): ConditionDef<K> {
  const M = T
  return {
    name,
    label: mode === 'day' ? M.labelAboveMa : `${M.labelAboveMa} · ${mode === 'all' ? M.modeAll : M.modeAny}`,
    category: '均线',
    description: M.descAboveMa(mode),
    defaults: { period: 5, n: 1, m: mode === 'day' ? 1 : 5 } as ConditionParamsMap[K],
    summary: p => {
      const params = p as MaDayParams
      if (mode === 'day') return M.summaryAboveAt(params.period, daySuffix(daySlot(params)))
      const slot = M.slotSpan(daySlot(params), dayEnd(params, 1))
      return mode === 'all' ? M.summaryAboveSpan(params.period, slot) : M.summaryAboveAny(params.period, slot)
    },
    requiredBars: p => {
      const params = p as MaDayParams
      return mode === 'day'
        ? daySlot(params) - 1 + params.period
        : dayEnd(params, 1) - 1 + params.period
    },
    validate: (p, tradingDays) => {
      const params = p as MaDayParams
      if (!MA_PERIODS.includes(params.period)) return [T.periodInvalid]
      return mode === 'day'
        ? checkDay(rawDay(params), tradingDays)
        : checkSpan(rawDay(params), rawEnd(params), tradingDays)
    },
    daySelector: mode === 'day' ? 'single' : 'range',
  }
}

/** 阴阳线计数：D[n..m]，M 留空 = 整个统计窗口。 */
function candleDef<K extends ConditionName>(name: K, bullish: boolean): ConditionDef<K> {
  const M = T
  const label = bullish ? M.labelMoreBullish : M.labelMoreBearish
  return {
    name,
    label,
    category: 'K 线',
    description: bullish ? M.descMoreBullish : M.descMoreBearish,
    defaults: { n: 1, m: 0 } as ConditionParamsMap[K],
    summary: p => {
      const params = p as CandleRangeParams
      return Number(params.m) > 0
        ? M.summaryCandleSpan(M.slotSpan(daySlot(params), dayEnd(params, 1)), label)
        : M.summaryCandleWindow(label)
    },
    requiredBars: p => {
      const params = p as CandleRangeParams
      return Number(params.m) > 0 ? dayEnd(params, 1) : 0
    },
    validate: (p, tradingDays) => {
      const params = p as CandleRangeParams
      // M 留空 = 整个统计窗口（最多 250 天），不能再套 30 根跨度上限
      return Number(params.m) > 0
        ? checkSpan(rawDay(params), rawEnd(params), tradingDays)
        : checkDay(rawDay(params), tradingDays)
    },
    daySelector: 'range-window',
  }
}

export const CONDITION_DEFS_ZH: ConditionDefMap = {
  ma_bullish: maOrderDef('ma_bullish', 'day', true),
  ma_bullish_all: maOrderDef('ma_bullish_all', 'all', true),
  ma_bullish_any: maOrderDef('ma_bullish_any', 'any', true),
  ma_bearish: maOrderDef('ma_bearish', 'day', false),
  ma_bearish_all: maOrderDef('ma_bearish_all', 'all', false),
  ma_bearish_any: maOrderDef('ma_bearish_any', 'any', false),
  close_above_ma: maAboveDef('close_above_ma', 'day'),
  close_above_ma_all: maAboveDef('close_above_ma_all', 'all'),
  close_above_ma_any: maAboveDef('close_above_ma_any', 'any'),
  more_bullish_candles: candleDef('more_bullish_candles', true),
  more_bearish_candles: candleDef('more_bearish_candles', false),
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
      const limit = Math.max(1, Math.trunc(tradingDays || 1))
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
      const limit = Math.max(1, Math.trunc(tradingDays || 1))
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

  // ---- 量价：指标 × 形状，一行一条（求值器与表单都是共享的）
  change_pct_all: metricDef('change_pct_all'),
  change_pct_any: metricDef('change_pct_any'),
  change_pct_span: metricDef('change_pct_span'),
  turnover_single: metricDef('turnover_single'),
  turnover_all: metricDef('turnover_all'),
  turnover_any: metricDef('turnover_any'),
  turnover_span: metricDef('turnover_span'),
  volume_single: metricDef('volume_single'),
  volume_all: metricDef('volume_all'),
  volume_any: metricDef('volume_any'),
  volume_span: metricDef('volume_span'),
  amount_single: metricDef('amount_single'),
  amount_all: metricDef('amount_all'),
  amount_any: metricDef('amount_any'),
  amount_span: metricDef('amount_span'),
  vol_ratio_single: metricDef('vol_ratio_single'),
  vol_ratio_all: metricDef('vol_ratio_all'),
  vol_ratio_any: metricDef('vol_ratio_any'),
  vol_ratio_avg: metricDef('vol_ratio_avg'),
  vol_ratio_consecutive: metricDef('vol_ratio_consecutive'),
  consecutive_shrinking: metricDef('consecutive_shrinking'),
  market_cap_single: metricDef('market_cap_single'),
  market_cap_all: metricDef('market_cap_all'),
  market_cap_any: metricDef('market_cap_any'),

  // ---- 第二批
  consecutive_falling: fallingDef(),
  new_high: lookbackDef('new_high', true),
  new_low: lookbackDef('new_low', false),
  ma_golden_cross: crossDef('ma_golden_cross', true),
  ma_dead_cross: crossDef('ma_dead_cross', false),
  ma_golden_cross_any: crossDef('ma_golden_cross_any', true, 'any'),
  ma_dead_cross_any: crossDef('ma_dead_cross_any', false, 'any'),
  stock_match: stockMatchDef(),
  stock_code: stockCodeDef(),
  stock_name: stockNameDef(),
  market_cap: marketCapDef(),
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

/** 「+ 条件」列表里能选的条件（隐藏掉已被取代的老条件，如 stock_match）。 */
export const PICKABLE_CONDITION_NAMES = CONDITION_NAMES.filter(
  name => !CONDITION_DEFS_ZH[name].hidden,
)

/**
 * 身份条件：只比代码 / 名称，不读日线。
 * 同一个 AND 组里出现多条时后端按「或」合并（见 formatGroup），画摘要时也要跟着走。
 */
export const IDENTITY_CONDITIONS = new Set<ConditionName>(['stock_code', 'stock_name', 'stock_match'])

export function metricOf(name: ConditionName): { metric: MetricKey; shape: MetricShape } | null {
  const seed = METRIC_SEEDS_ZH[name]
  return seed ? { metric: seed.metric, shape: seed.shape } : null
}

/** 指标的取值边界（参数表单据此限制输入，与后端校验同一套数）。 */
export function metricBounds(metric: MetricKey): [number, number] {
  return METRIC_LIMITS[metric]
}

/** 量价条件的单位（摘要之外的提示文案用）。 */
export function metricUnit(metric: MetricKey): string {
  return METRIC_TEXTS_ZH.unit[metric]
}

/** 选择列表按分类分组（顺序：均线 → K 线 → 涨跌幅 → 量价四项）。 */
export const CONDITION_CATEGORIES: ConditionCategory[] = [
  '均线',
  'K 线',
  '总市值',
  '涨跌幅',
  '换手率',
  '成交量',
  '成交额',
  '量比',
]

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
    rule: createGroup('AND'),
  }
}

/**
 * 老条件文件里的「基础市值区间」→ 条件树里的两条市值条件。
 *
 * 2026-10-22 起总市值搬进条件列表，服务器上已存的条件文件里仍然带
 * ``market_cap: {min_yi, max_yi}``。直接丢掉会让老条件的筛选范围忽然变宽
 * （相当于「全市场」），所以读进来时**等价翻译**成：
 *
 *   ``总市值 > min_yi`` 且 ``总市值 < max_yi``   ← 与老 SQL 的严格开区间一致
 *
 * 老默认区间 ``{1, 100000}`` 实际等于「不限」，直接忽略（不然每个老条件都会
 * 多出两条无意义的条件）。
 */

/** 老条件的「默认市值区间」——等于不限（见 `migrateLegacyMarketCap`） */
const LEGACY_CAP_DEFAULT_MIN = 1
const LEGACY_CAP_DEFAULT_MAX = 100000

export function migrateLegacyMarketCap(request: ScreenRequest): GroupNode {
  const cap = request.market_cap
  if (!cap) return request.rule
  const min = Number(cap.min_yi)
  const max = Number(cap.max_yi)
  if (!Number.isFinite(min) || !Number.isFinite(max)) return request.rule
  if (min <= LEGACY_CAP_DEFAULT_MIN && max >= LEGACY_CAP_DEFAULT_MAX) return request.rule

  const children: RuleNode[] = []
  if (min > 0) {
    children.push({
      type: 'condition',
      id: newNodeId(),
      name: 'market_cap',
      params: { op: 'gt', value: min, n: 1 },
    })
  }
  if (max < MAX_MARKET_CAP_YI) {
    children.push({
      type: 'condition',
      id: newNodeId(),
      name: 'market_cap',
      params: { op: 'lt', value: max, n: 1 },
    })
  }
  if (children.length === 0) return request.rule
  if (request.rule.children.length === 0) return { ...request.rule, children }
  // 老区间与老条件树是「且」的关系：并在根组里（根组是 OR 时套一层 AND）
  if (request.rule.operator === 'AND') {
    return { ...request.rule, children: [...request.rule.children, ...children] }
  }
  return {
    ...request.rule,
    children: [...request.rule.children, { type: 'group', id: newNodeId(), operator: 'AND', children }],
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
  return T.baseSummary(markets, req.include_st ? T.stIncluded : T.stExcluded, req.trading_days)
}

// ------------------------------------------------------------------ 校验

export function validateScreenRequest(req: ScreenRequest): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const days = req.trading_days
  if (!Number.isInteger(days) || days < MIN_TRADING_DAYS || days > MAX_TRADING_DAYS) {
    issues.push({ path: 'trading_days', message: T.tradingDaysInvalid })
  }
  // 数据截至：留空 = 最新交易日；填了就必须是 YYYY-MM-DD（日期控件的值一定是这个形状，
  // 手写或者老条件文件里的脏值要在这里拦住，否则后端 422）
  const asof = typeof req.asof === 'string' ? req.asof.trim() : ''
  if (asof !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    issues.push({ path: 'asof', message: T.asofInvalid })
  }
  if (req.markets.length === 0) {
    issues.push({ path: 'markets', message: T.marketRequired })
  } else if (new Set(req.markets).size !== req.markets.length) {
    issues.push({ path: 'markets', message: T.marketRequired })
  }

  // 基础市值区间不再由界面维护（已搬进条件列表，见 migrateLegacyMarketCap）；
  // 老条件文件里如果还带着，读入时就翻译成条件了，这里不用管。

  issues.push(...validateGroup(req.rule, 'rule', 1, days, { count: 0 }))
  return issues
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
  // AND 组里多条「股票代码 / 名称」按「或」显示 —— 后端编译期也是这么合并的
  // （一只股票只有一个代码，AND 起来永远为空）。显示与执行必须一致，否则横幅在说谎。
  const mergeIdentity = node.operator === 'AND' && node.children.filter(isIdentityNode).length > 1
  const parts: string[] = []
  let identityDone = false
  for (const child of node.children) {
    if (mergeIdentity && isIdentityNode(child)) {
      if (identityDone) continue
      identityDone = true
      parts.push(`( ${node.children.filter(isIdentityNode).map(c => formatNode(c)).join(' OR ')} )`)
      continue
    }
    parts.push(formatNode(child))
  }
  const joiner = node.operator === 'AND' ? ' AND ' : ' OR '
  const inner = parts.join(joiner)
  if (isRoot || node.children.length < 2) return inner
  return `( ${inner} )`
}

function isIdentityNode(node: RuleNode): boolean {
  return node.type === 'condition' && IDENTITY_CONDITIONS.has(node.name)
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
  const asof = typeof state.asof === 'string' ? state.asof.trim() : ''
  return {
    trading_days: Number(state.trading_days),
    markets: [...state.markets],
    include_st: Boolean(state.include_st),
    // market_cap 不再提交：市值是条件列表里的一条条件（老请求仍被后端兼容）
    rule: stripGroup(state.rule),
    // 空串按 null 传：后端 `asof` 是可选日期，null / 缺省都表示「最新交易日」
    asof: asof === '' ? null : asof,
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

  // 其余条件（量价与第二批）按**默认值表**通用归一：数字字段转 Number（非有限值
  // 回落到默认值，避免把空框的 NaN 提交上去），字符串字段原样保留。
  // 后端是 ``extra="forbid"``，多一个少一个键都是 400，所以这里必须逐键对齐 defaults。
  const fallback = (CONDITION_DEFS_ZH[name]?.defaults ?? {}) as Record<string, unknown>
  const current = (params ?? {}) as Record<string, unknown>
  if (Object.keys(fallback).length === 0) return {} as ConditionParamsMap[K]
  const out: Record<string, unknown> = {}
  for (const [key, defaultValue] of Object.entries(fallback)) {
    const raw = current[key]
    if (typeof defaultValue === 'number') {
      const value = Number(raw)
      out[key] = Number.isFinite(value) ? value : defaultValue
    } else if (typeof defaultValue === 'string') {
      out[key] = raw === undefined || raw === null ? defaultValue : String(raw)
    } else {
      out[key] = raw === undefined ? defaultValue : raw
    }
  }
  return out as ConditionParamsMap[K]
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
