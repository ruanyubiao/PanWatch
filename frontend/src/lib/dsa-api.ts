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

export function getDsaHistory(symbol: string, limit = 10) {
  return fetchAPI<{ symbol: string; items: DsaReportRow[] }>(
    `/stocks/dsa/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
  )
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
 * 页面自己会拉最新报告 / 起任务，所以这里只带代码和名称，不带 state。
 */
export function dsa2Path(symbol: string, name?: string | null) {
  return `/dsa2/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}`
}

/** 新窗口打开「深度分析2」：不发请求、不阻塞当前页（一次分析要调大模型）。 */
export function openDsa2Window(symbol: string, name?: string | null) {
  window.open(dsa2Path(symbol, name), '_blank', 'noopener,noreferrer')
}
