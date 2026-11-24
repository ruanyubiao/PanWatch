/**
 * 「模型预测」接口（个股预测模型的每日结果）。
 *
 * 后端：``/api/stocks/predict/*``（``src/modules/market/api/fork_predict.py``）。
 * 数据全部来自 MySQL 的 ``stock_predict_daily`` —— 预测由 A 股管道在每日同步后写入，
 * 本站只读。**没有数据的正常状态**是 ``available=false``（不是报错）：每天 17:00
 * 同步之前、或某个交易日还没跑推理时，页面显示「尚未生成」。
 */
import { fetchAPI } from '@panwatch/api'

export interface PredictDateItem {
  trade_date: string
  count: number
  model_version?: string | null
  scored_at?: string | null
}

export interface PredictModelInfo {
  version?: string | null
  trained_at?: string | null
  best_iter?: number | null
  n_features?: number | null
  label_def?: string | null
  metrics?: string | null
}

export interface PredictDatesResponse {
  available: boolean
  dates: PredictDateItem[]
  latest: string | null
  model?: PredictModelInfo | null
}

export interface PredictRow {
  rank_no: number
  symbol?: string | null
  code: string
  name: string
  score?: number | null
  pct?: number | null
  amt_med20?: number | null
}

export interface PredictDailyResponse {
  available: boolean
  trade_date: string | null
  total: number
  offset?: number
  model_version?: string | null
  scored_at?: string | null
  items: PredictRow[]
}

export interface PredictScoresResponse {
  available: boolean
  trade_date: string | null
  scores: Record<string, { rank_no: number; pct: number | null }>
}

export interface PredictHistoryPoint {
  trade_date: string
  rank_no: number
  pct: number | null
}

export interface PredictStockResponse {
  code: string
  name: string
  exchange?: string | null
  trade_date: string
  rank_no: number
  universe: number
  score?: number | null
  pct?: number | null
  amt_med20?: number | null
  model_version?: string | null
  scored_at?: string | null
  history: PredictHistoryPoint[]
  model?: PredictModelInfo | null
}

export function getPredictDates(limit = 60) {
  return fetchAPI<PredictDatesResponse>(`/stocks/predict/dates?limit=${limit}`)
}

export function getPredictDaily(date?: string | null, limit = 200, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (date) params.set('date', date)
  return fetchAPI<PredictDailyResponse>(`/stocks/predict/daily?${params.toString()}`)
}

/** 全市场「代码 → 名次/分位」—— 分析页表格那一列用它，一次取完。 */
export function getPredictScores(date?: string | null) {
  const suffix = date ? `?date=${encodeURIComponent(date)}` : ''
  return fetchAPI<PredictScoresResponse>(`/stocks/predict/scores${suffix}`)
}

export function getPredictStock(code: string, days = 60) {
  return fetchAPI<PredictStockResponse>(
    `/stocks/predict/stock/${encodeURIComponent(code)}?days=${days}`,
  )
}

/**
 * 预测列表页地址（``/predict``，可带 ``?date=``）。
 * 没有返回导航 —— 和 /dsa2 一样是新窗口里的独立页（用户口径）。
 */
export function predictPath(date?: string | null) {
  return date ? `/predict?date=${encodeURIComponent(date)}` : '/predict'
}

/** 个股预测详情页地址（``/predict/000975``）。 */
export function predictStockPath(code: string) {
  return `/predict/${encodeURIComponent(code)}`
}

/** 新窗口打开预测列表（不发请求、不阻塞当前页）。 */
export function openPredictWindow() {
  window.open(predictPath(), '_blank', 'noopener,noreferrer')
}

/** 新窗口打开个股预测详情。 */
export function openPredictStockWindow(code: string) {
  window.open(predictStockPath(code), '_blank', 'noopener,noreferrer')
}
