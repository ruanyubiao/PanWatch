/**
 * 「深度分析2」接口（DSA 风格决策报告）。
 *
 * 后端：``/api/stocks/dsa/*``（``src/modules/market/api/fork_dsa.py``）。
 * 交互与 DSA 一致：``POST /analyze`` 只起任务、立刻返回 running，页面按
 * ``GET /report/{id}`` 轮询 —— 一次分析要调大模型，同步等会撞上网关超时。
 */
import { fetchAPI } from '@panwatch/api'

export type DsaStatus = 'none' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface DsaMeta {
  stock_code?: string
  stock_name?: string | null
  current_price?: number | null
  change_pct?: number | null
  asof?: string | null
  bar_asof?: string | null
  intraday?: boolean
  quote_time?: string | null
  created_at?: string
  market_phase?: string | null
  market_phase_label?: string | null
  model_used?: string | null
  report_type?: string
}

export interface DsaSummary {
  analysis_summary?: string | null
  operation_advice?: string | null
  action?: string | null
  action_label?: string | null
  trend_prediction?: string | null
  sentiment_score?: number | null
  sentiment_label?: string | null
  confidence_level?: string | null
  decision_type?: string | null
  guardrail_reason?: string | null
  key_points?: string | null
  risk_warning?: string | null
  one_sentence?: string | null
  signal_type?: string | null
  time_sensitivity?: string | null
  position_advice?: Record<string, string | null>
}

export interface DsaStrategy {
  ideal_buy?: string | null
  secondary_buy?: string | null
  stop_loss?: string | null
  take_profit?: string | null
  suggested_position?: string | null
  entry_plan?: string | null
  risk_control?: string | null
  action_checklist?: string[]
}

/** 数据源面板的一行：后端 ``sources.module_status`` 的原样结构。 */
export type DsaSourceStatus = 'ok' | 'empty' | 'unavailable' | 'unconfigured'

export interface DsaSource {
  key: string
  label: string
  source?: string | null
  requires_key?: boolean
  status: DsaSourceStatus
  note?: string | null
  /** status==='empty' 时的文案（例如「未上榜」），后端 MODULE_CATALOG 给。 */
  empty_label?: string | null
}

export interface DsaDetails {
  sectors?: string[]
  sector_view?: string | null
  latest_news?: string | null
  risk_alerts?: string[]
  positive_catalysts?: string[]
  sentiment_summary?: string | null
  limitations?: string[]
  data_sources?: string[]
  /** 数据源清单（含「未配置」的模块）。老报告没有这一项，页面要容忍缺失。 */
  sources?: DsaSource[]
  /**
   * 技术面快照 —— **与报告一起保存**的那一份。
   *
   * 用户口径：报告可能是 3 天前跑的，今天打开不能给今天的技术指标。所以页面
   * 只读这里存的值，绝不现取；`asof` 是日线基准日，`captured_at` 是报告生成时间。
   * 老报告（这一版之前跑的）没有这个字段。
   */
  technical?: DsaTechnical | null
  /** 模型预测快照（同样带自己的 trade_date）。老报告没有。 */
  prediction?: DsaPrediction | null
}

export interface DsaTechnical {
  available: boolean
  code?: string | null
  /** 日线基准日（已收盘的那根）—— 技术指标算到哪一天 */
  asof?: string | null
  /** 报告生成时间（≠ asof） */
  captured_at?: string | null
  bar_close?: number | null
  price?: number | null
  intraday?: boolean
  quote_time?: string | null
  /** 库里 tech_score 原值（未持仓口径评分，各项累加） */
  score?: number | null
  trend?: string | null
  macd?: string | null
  rsi?: string | null
  kdj?: string | null
  boll?: string | null
  volume?: string | null
  support?: number | null
  resistance?: number | null
  ma?: { ma5?: number | null; ma10?: number | null; ma20?: number | null; ma60?: number | null }
  volume_ratio?: number | null
  high_20?: number | null
  low_20?: number | null
  ret_5d?: number | null
  ret_20d?: number | null
  ret_60d?: number | null
  /** true = 旧报告没有存，按报告的基准日从行情库复原（仍是那一天的数） */
  reconstructed?: boolean
  reason?: string | null
}

export interface DsaPrediction {
  available: boolean
  code?: string | null
  /** 预测对应的交易日（一般是报告基准日当天收盘后算出来的那一批） */
  trade_date?: string | null
  rank_no?: number | null
  universe?: number | null
  /** 分位：100 = 当日第 1 名（越高越靠前） */
  pct?: number | null
  score?: number | null
  model_version?: string | null
  scored_at?: string | null
  captured_at?: string | null
  reason?: string | null
}

export interface DsaReport {
  meta: DsaMeta
  summary: DsaSummary
  strategy: DsaStrategy
  details: DsaDetails
}

export interface DsaReportRow {
  id: number | null
  symbol: string
  name?: string | null
  status: DsaStatus
  model_used?: string | null
  error?: string | null
  created_at?: string
  /** 真正开跑的时刻（排队期间为空）——「已用时间」以它为起点，刷新不归零。 */
  started_at?: string | null
  /** 队列位次：0 = 正在跑或下一个就是它，N = 前面还有 N 个。 */
  queue_position?: number
  updated_at?: string
  report?: DsaReport | null
}

/** 历史列表的一行：后端 ``/dsa/history`` 只回列表要用的字段，不含报告正文。 */
export interface DsaHistoryItem {
  id: number
  symbol: string
  status: DsaStatus
  created_at?: string | null
  started_at?: string | null
  model_used?: string | null
  price?: number | null
  change_pct?: number | null
  asof?: string | null
  advice?: string | null
  trend?: string | null
  sentiment_score?: number | null
}

export interface DsaHistoryResponse {
  symbol: string
  /** 行情库里的股票名（地址里不再带 ?name=，页面靠它显示「山金国际」）。 */
  name?: string | null
  count?: number
  items: DsaHistoryItem[]
}

/** 队列快照：``running`` 只可能有一个（单消费者），其余是等待中的。 */
export interface DsaQueueSnapshot {
  items: DsaReportRow[]
  running: DsaReportRow | null
  pending: number
}

export const DSA_POLL_MS = 2500
export const DSA_QUEUE_POLL_MS = 3000

export function analyzeDsa(symbol: string, name?: string | null, modelId?: number | null) {
  return fetchAPI<DsaReportRow>('/stocks/dsa/analyze', {
    method: 'POST',
    body: JSON.stringify({ symbol, name: name || null, model_id: modelId ?? null }),
  })
}

export function getDsaReport(id: number) {
  return fetchAPI<DsaReportRow>(`/stocks/dsa/report/${id}`)
}

export function getDsaLatest(symbol: string) {
  return fetchAPI<DsaReportRow>(`/stocks/dsa/latest?symbol=${encodeURIComponent(symbol)}`)
}

export function getDsaHistory(symbol: string, limit = 20) {
  return fetchAPI<DsaHistoryResponse>(
    `/stocks/dsa/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  )
}

/**
 * 按「报告基准日」复原技术面 —— 只给**旧报告**用（payload 里没有 technical 块）。
 *
 * 后端会只读到 ``asof`` 那一天为止的日线并关掉实时快照，所以拿到的不是今天的数。
 * 新报告不走这条路：直接读 payload 里存的那一份。
 */
export function getDsaTechnical(symbol: string, asof?: string | null) {
  const suffix = asof ? `&asof=${encodeURIComponent(asof)}` : ''
  return fetchAPI<DsaTechnical>(`/stocks/dsa/technical?symbol=${encodeURIComponent(symbol)}${suffix}`)
}

/** 队列快照（页面「队列」按钮读这个）。 */
export function getDsaQueue() {
  return fetchAPI<DsaQueueSnapshot>('/stocks/dsa/queue')
}

/** 删除队列项：排队中直接删；运行中标 cancelled（结果丢弃，让位给下一个）。 */
export function deleteDsaQueueItem(id: number) {
  return fetchAPI<{ id: number; outcome: 'deleted' | 'cancelled' }>(`/stocks/dsa/queue/${id}`, {
    method: 'DELETE',
  })
}

/**
 * 「已用秒数」——以 ``started_at``（真正开跑的时刻）为起点。
 *
 * 为什么不是从前端 mount 开始算：用户刷新一次就从 0 开始，看着像任务重启了。
 * 起点存在库里，任何一次刷新、换窗口、换浏览器都算出同一个数。
 */
export function dsaElapsedSeconds(
  row: Pick<DsaReportRow, 'started_at' | 'created_at'> | null | undefined,
  nowMs: number = Date.now(),
): number {
  const start = row?.started_at || row?.created_at
  if (!start) return 0
  const started = new Date(start).getTime()
  if (Number.isNaN(started)) return 0
  return Math.max(0, Math.floor((nowMs - started) / 1000))
}

/** 2026/11/11 11:46:55 —— 带秒的本地时间（「任务开始时间」用）。 */
export function formatDsaInstant(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 「深度分析2」页面的地址（新窗口打开用）。
 *
 * 只带股票代码，**不再带 ``?name=``** —— 代码本身已经唯一确定标的，名称由页面
 * 从报告 / 行情库里取（``analyze`` 的 ``name`` 为空时后端也会用库里的名字）。
 * 带中文名会让地址变成一长串百分号编码，分享、粘贴都难读（用户口径）。
 */
export function dsa2Path(symbol: string) {
  return `/dsa2/${encodeURIComponent(symbol)}`
}

/** 历史里某一份报告的地址（``/dsa2/000975?id=22``）；不带 id 就是取最新一份。 */
export function dsa2ReportPath(symbol: string, id?: number | null) {
  const base = dsa2Path(symbol)
  return typeof id === 'number' && Number.isFinite(id) ? `${base}?id=${id}` : base
}

/**
 * 北交所标的（bj 前缀 / 4xx / 8xx / 920xxx）不在股票池内（用户口径）。
 *
 * 与后端 ``fork_dsa._normalize_symbol``、``data.py`` 的判定保持一致：宁可少画一颗
 * 按钮，也不要在弹窗里给一个 400。前缀 ``sh/sz/bj`` 与小写、``.BJ`` 后缀都吃掉。
 */
export function isBeijingCode(symbol?: string | null): boolean {
  const raw = (symbol || '').trim().toLowerCase()
  if (!raw) return false
  if (raw.startsWith('bj') || raw.includes('.bj')) return true
  const digits = raw.replace(/^(?:sh|sz)/, '').replace(/\.(?:sh|sz)$/, '')
  return /^[489]/.test(digits)
}

/** 新窗口打开「深度分析2」：不发请求、不阻塞当前页（一次分析要调大模型）。 */
export function openDsa2Window(symbol: string) {
  window.open(dsa2Path(symbol), '_blank', 'noopener,noreferrer')
}
