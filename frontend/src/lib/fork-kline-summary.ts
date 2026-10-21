/**
 * fork 专用：全市场行情表的行 → 上游徽章要吃的 KlineSummary。
 *
 * 为什么需要这一层
 * ---------------
 * 上游的「技术面徽章」（买入/回避/…）吃的是 ``POST /api/klines/summary/batch``
 * 的返回值，那条路**要打外网**，全市场每页 100 只必然被限流（实测被屏蔽）。
 * fork 的数据管道在日终已经把同一套算法的结果写进了 MySQL（列 ``tech_*``，
 * 口径见技能 panwatch-dev-env / references/kline-technical-scoring.md），
 * 所以这里把库里的状态字符串「翻译」回上游徽章认识的形状，前端一个外网请求都不发。
 *
 * 库里没有 macd_hist
 * ------------------
 * 打分表里有一项 ``macd_hist > 0 / < 0`` 的 ±1，而管道只落了 ``tech_score`` 与
 * 状态字符串。复原是确定性的：
 *   1. 先用状态字符串跑一次 ``buildKlineSuggestion``（``macd_hist`` 留空）得 S0；
 *   2. ``macd_hist = tech_score − S0`` —— 该差值必然落在 {−1, 0, +1}；
 *   3. 把差值喂回去重算，徽章的分数就与库里的 ``tech_score`` 逐行相等。
 * 差值为 ±2 说明库里的分数与状态字符串**不同源**（有别的加减项），这时只告警，
 * 不硬塞 —— 硬塞会把一个看不见的口径错误掩盖掉。
 *
 * 动作按持仓状态现算：本页全部按「未持仓」算（hasPosition=false），与
 * `SuggestionBadge` 的入参保持一致，否则徽章与弹窗会显示不同的动作。
 */
import { buildKlineSuggestion, type KlineTranslate } from '@/lib/kline-scorer'
import type { KlineSummary } from '@panwatch/biz-ui/components/suggestion-badge'

export interface MarketRowTech {
  score: number
  trend: string | null
  macd: string | null
  rsi: string | null
  kdj: string | null
  boll: string | null
  volume: string | null
  support: number | null
  resistance: number | null
}

export interface MarketRowMa {
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma60: number | null
}

/** 后端 ``GET /api/stocks/market-table`` 的一行（数值为王复权还原到不复权空间后的值。） */
export interface MarketRow {
  code: string
  symbol: string
  exchange: string
  name: string
  board: string
  trade_date: string | null
  pre_close: number | null
  close: number | null
  high: number | null
  low: number | null
  change_pct: number | null
  /** 成交量（股） */
  volume: number | null
  /** 成交额（元） */
  amount: number | null
  /** 换手率（百分数：1.38 就是 1.38%），管道已按流通股本算好 */
  turnover_rate: number | null
  total_market_cap: number | null
  source: string | null
  /**
   * 交易日状态（`market-table` 与 `stocks/screen` 都会带）。
   *
   * `status_code` 是行情库 `stock_status_daily` 当日**最严重**的那条
   * （NORMAL / SUSPENDED / ST / STAR_ST / DELISTING / NEW_LISTING …），
   * `status_label` 是 2–3 个字的短标签（正常 / 停牌 / ST / *ST / 退市 / 新股），
   * `status_group` 是库里的分组（suspension / risk_warning / delisting / listing）。
   * 老接口没有这三个字段时按「正常」处理（见 market-filters 的 tradeStatusKeyOf）。
   */
  status_code?: string | null
  status_label?: string | null
  status_group?: string | null
  ma: MarketRowMa
  tech: MarketRowTech | null
}

export interface MarketBoardCounts {
  all: number
  sh: number
  sz: number
  kcb: number
  cyb: number
  st: number
}

/**
 * 后端 ``GET /api/stocks/market-table`` 的**原始**行。
 *
 * 字段名被压到 1–2 个字母（用户要求「返回字段瘦身、变量名能一个字母就一个字母」）：
 * 全市场一次要传 5500 余行，字段名占的字节和字段值是一个量级。对照表见后端
 * ``fork_market.map_row`` 的 docstring：``c`` 代码 / ``n`` 名称 / ``cl`` 收盘 /
 * ``mc`` 总市值 / ``m`` 均线 / ``t`` 技术面 …
 *
 * 前端只在**取数的那一处**（``parseMarketRow``）把短名翻译回可读名，其余组件
 * 一律用 ``MarketRow`` —— 否则这张表 5000 行逻辑全要改成单字母，读不下去。
 */
export interface MarketRowRaw {
  c: string
  s: string
  e: string
  n: string
  b: string
  d: string | null
  pc: number | null
  cl: number | null
  h: number | null
  l: number | null
  cp: number | null
  mc: number | null
  v?: number | null
  am?: number | null
  tr?: number | null
  so: string | null
  sc?: string | null
  sl?: string | null
  sg?: string | null
  m?: Partial<Record<'5' | '10' | '20' | '60', number | null>> | null
  t?: {
    s: number
    t: string | null
    m: string | null
    r: string | null
    k: string | null
    b: string | null
    v: string | null
    su: number | null
    re: number | null
  } | null
}

/** 接口响应：``a`` = asof（交易日），``i`` = 行数组。别的键都不再返回。 */
export interface MarketTablePayload {
  a: string | null
  i: MarketRowRaw[]
}

/** 解析后的响应（组件用的形状）。 */
export interface MarketTableResponse {
  asof: string | null
  items: MarketRow[]
}

/** 原始行 → ``MarketRow``（短名翻译成可读名，只做一次）。 */
export function parseMarketRow(raw: MarketRowRaw): MarketRow {
  const tech = raw.t
  return {
    code: raw.c,
    symbol: raw.s,
    exchange: raw.e,
    name: raw.n,
    board: raw.b,
    trade_date: raw.d ?? null,
    pre_close: raw.pc ?? null,
    close: raw.cl ?? null,
    high: raw.h ?? null,
    low: raw.l ?? null,
    change_pct: raw.cp ?? null,
    volume: raw.v ?? null,
    amount: raw.am ?? null,
    turnover_rate: raw.tr ?? null,
    total_market_cap: raw.mc ?? null,
    source: raw.so ?? null,
    status_code: raw.sc ?? null,
    status_label: raw.sl ?? null,
    status_group: raw.sg ?? null,
    ma: {
      ma5: raw.m?.['5'] ?? null,
      ma10: raw.m?.['10'] ?? null,
      ma20: raw.m?.['20'] ?? null,
      ma60: raw.m?.['60'] ?? null,
    },
    tech: tech
      ? {
          score: tech.s,
          trend: tech.t,
          macd: tech.m,
          rsi: tech.r,
          kdj: tech.k,
          boll: tech.b,
          volume: tech.v,
          support: tech.su,
          resistance: tech.re,
        }
      : null,
  }
}

/** 原始响应 → 组件用的形状（``items`` 逐行翻译）。 */
export function parseMarketTablePayload(payload: MarketTablePayload | null | undefined): MarketTableResponse {
  return {
    asof: payload?.a ?? null,
    items: (payload?.i ?? []).map(parseMarketRow),
  }
}

const MACD_CROSS_DAYS = /\((\d+)日\)/
const MACD_CROSS = /(金叉|死叉)/

/** ``金叉(5日)`` → ``{status, cross:'金叉', crossDays:5}``。 */
export function parseMacdStatus(raw: string | null | undefined): {
  status: string | null
  cross: string | null
  crossDays: number | null
} {
  const text = String(raw ?? '')
  if (!text) return { status: null, cross: null, crossDays: null }
  const days = text.match(MACD_CROSS_DAYS)
  const cross = text.match(MACD_CROSS)
  return {
    status: text,
    cross: cross ? cross[1] : null,
    crossDays: days ? Number(days[1]) : null,
  }
}

/**
 * 行 → KlineSummary；``tech`` 为空（新股 / 历史不足 120 根）时返回 null，
 * 界面显示「数据不足」而不是喂 0 —— 0 分会被算成「观望」，看着像一个已给出的结论。
 */
export function buildSummaryFromMarketRow(row: MarketRow, tr: KlineTranslate): KlineSummary | null {
  const tech = row.tech
  if (!tech) return null

  const macd = parseMacdStatus(tech.macd)
  const base = {
    asof: row.trade_date ?? undefined,
    last_close: row.close,
    trend: tech.trend ?? undefined,
    macd_status: macd.status ?? undefined,
    macd_cross: macd.cross,
    macd_cross_days: macd.crossDays,
    rsi_status: tech.rsi ?? undefined,
    kdj_status: tech.kdj ?? undefined,
    boll_status: tech.boll ?? undefined,
    volume_trend: tech.volume ?? undefined,
    ma5: row.ma?.ma5 ?? null,
    ma10: row.ma?.ma10 ?? null,
    ma20: row.ma?.ma20 ?? null,
    ma60: row.ma?.ma60 ?? null,
    support: tech.support,
    resistance: tech.resistance,
    // 库里的 tech_* 没有这几列：
    //   recent_5_up  —— 徽章/弹窗都不渲染它，填 0 只为满足类型
    //   change_5d / change_20d —— 弹窗会渲染，但库里没有对应的 N 日涨跌幅，
    //                             留 null（弹窗会跳过这两个 chip），不编数字
    recent_5_up: 0,
    change_5d: null,
    change_20d: null,
  } as KlineSummary

  // 未持仓口径（与 SuggestionBadge 的 hasPosition={false} 一致）
  const withoutHist = buildKlineSuggestion(base as never, false, tr)
  const diff = tech.score - withoutHist.score
  if (diff < -1 || diff > 1) {
    console.warn(
      `[fork] ${row.code} 库里 tech_score=${tech.score} 与状态字符串算出的 ${withoutHist.score} 不同源（差 ${diff}）`,
    )
    return base
  }
  return { ...base, macd_hist: diff } as KlineSummary
}

/** 徽章用的分数（与库里 tech_score 相等；tech 为空时返回 null）。 */
export function marketRowScore(row: MarketRow, tr: KlineTranslate): number | null {
  const summary = buildSummaryFromMarketRow(row, tr)
  if (!summary) return null
  return buildKlineSuggestion(summary as never, false, tr).score
}

/**
 * 状态列那颗**技术面**徽章的动作（buy / avoid / watch）—— 分析页的「状态」筛选
 * 就按它分组，保证「筛出来的集合」与「徽章显示的动作」必然是同一批。
 *
 * 走的是与徽章完全相同的路径（``buildSummaryFromMarketRow`` → ``buildKlineSuggestion``，
 * holding=false），不是另写一套阈值 —— 阈值改在上游 kline-scorer 里时这里自动跟随。
 * 库里没有 tech_*（新股）时返回 null，只出现在「状态：全部」里。
 */
export function marketRowAction(row: MarketRow, tr: KlineTranslate): string | null {
  const summary = buildSummaryFromMarketRow(row, tr)
  if (!summary) return null
  return buildKlineSuggestion(summary as never, false, tr).action
}
