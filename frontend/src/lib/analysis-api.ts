/**
 * 数据分析接口（条件在历史上的准确率）。
 *
 * 后端：``/api/stocks/analysis/*``（``src/modules/market/api/fork_analysis.py``）。
 * 一个任务 = 一个已保存条件 × 一段日期，逐日跑条件选股，再算 d0 之后 30 个交易日
 * 的涨幅，最后给「这个条件有没有用」的统计。
 */
import { fetchAPI, getToken } from '@panwatch/api'
import type { ScreenMarket } from '@/lib/screen-rule'

export const ANALYSIS_POLL_MS = 2000

export type AnalysisStatus = 'pending' | 'running' | 'interrupted' | 'done' | 'stopped' | 'failed'

export interface AnalysisRunMeta {
  run_id: string
  preset: string
  created_at: string
  status: AnalysisStatus
  start_date: string
  end_date: string
  /** 结束日上限：再往后就没有足够的验证行情（后端算好的最后一个可验证交易日） */
  max_end_date?: string | null
  /** 验证天数（向前看几个交易日） */
  validate_days?: number
  /** 统计周期（验证天数决定，12 → 5、10） */
  horizons?: number[]
  markets: ScreenMarket[]
  include_st: boolean
  sample_size: number
  trading_days: number
  days_total: number
  days_done: number
  hits: number
  control: number
  failures: number
  error?: string | null
  finished_at?: string | null
  elapsed_s?: number
  running?: boolean
  excel_ready?: boolean
  counts?: { signals: number; hits: number; control: number; days: number }
  recent_days?: { d0: string; hits: number; control: number; elapsed_ms: number }[]
  progress?: {
    days_total: number
    days_done: number
    hits: number
    control: number
    avg_ms: number
    elapsed_s: number
    eta_s: number | null
    current_d0: string | null
    recent_days?: { d0: string; hits: number; control: number; elapsed_ms: number }[]
  }
}

export interface AnalysisHorizonMetrics {
  horizon: number
  n: number
  wins: number
  win_rate: number | null
  ci_low: number | null
  ci_high: number | null
  touch_rate: number | null
  avg_return: number | null
  avg_win: number | null
  avg_loss: number | null
  payoff: number | null
}

export interface AnalysisSummaryRow {
  horizon: number
  signal: AnalysisHorizonMetrics
  control: AnalysisHorizonMetrics
  excess_pp: number | null
  z: number
}

export interface AnalysisVerdict {
  usable: boolean
  reason: 'usable' | 'not_significant' | 'no_edge' | 'worse' | 'insufficient'
  best_horizon: number | null
  best_excess_pp: number | null
  best_win_rate?: number | null
  baseline_win_rate?: number | null
  best_avg_return?: number | null
  best_payoff?: number | null
  sample?: number
  z?: number
  significant?: boolean
  /** 按日聚合的诚实结论（比合并 z 保守） */
  honest?: AnalysisHonestVerdict
  honest_verdict?: string
  /** reason='worse' 时给出「显著跑输」的那个周期 */
  worst_horizon?: number
  worst_excess_pp?: number | null
  worst_win_rate?: number | null
  worst_baseline?: number | null
}

export interface AnalysisStockRow {
  code: string
  name: string
  board: string
  n: number
  win: Record<string, number | null>
  avg: Record<string, number | null>
  excess: Record<string, number | null>
  sufficient: boolean
}

export interface AnalysisBreakdownRow {
  key: string
  signal: Record<string, AnalysisHorizonMetrics> | null
  control: Record<string, AnalysisHorizonMetrics> | null
  excess: Record<string, number | null>
}

export interface AnalysisGroupCell {
  n: number
  win_rate: number | null
  ci_low: number | null
  ci_high: number | null
  avg_return: number | null
  edge_pp: number | null
}

export interface AnalysisGroupItem {
  key: string
  n: number
  sample_total: number
  win_rate: number | null
  edge_pp: number | null
  /** 相对同期随机买入的超额（负值 = 这一类也跑输随机） */
  excess_vs_random_pp?: number | null
  avg_return: number | null
  q: number
  z: number
  significant: boolean
  verdict: 'edge' | 'no_edge' | 'insufficient'
  horizons: Record<string, AnalysisGroupCell>
}

export interface AnalysisGroupBlock {
  dim: string
  label: string
  hint: string
  focus_horizon: number
  items: AnalysisGroupItem[]
}

export interface AnalysisArrival {
  buckets: { day: number; n: number }[]
  never_positive: number
  median_days: number | null
  total: number
  within: Record<string, number | null>
}

export interface AnalysisSignificanceRow {
  horizon: number
  caliber: 'exec' | 'close'
  period?: string
  mean_excess_pp: number | null
  ci_low_pp: number | null
  ci_high_pp: number | null
  t: number | null
  nw_t: number | null
  days: number
  n_eff: number
  pooled_excess_pp: number | null
  significant_up: boolean
  significant_down: boolean
  mean_return_excess_pp: number | null
  return_ci_low_pp: number | null
  return_ci_high_pp: number | null
}

export interface AnalysisHonestVerdict {
  verdict: 'usable' | 'worse' | 'mixed' | 'no_edge' | 'insufficient'
  primary_horizon: number
  primary_excess_pp: number | null
  primary_ci_low_pp?: number | null
  primary_ci_high_pp?: number | null
  up_count: number
  down_count: number
  days?: number | null
  n_eff?: number | null
}

export interface AnalysisQuality {
  days: number
  coverage_median: number | null
  coverage_threshold: number | null
  suspect_days: { d0: string; coverage: number; hits: number }[]
  suspect_days_count: number
  rows: number
  unverifiable: number
  unfillable: number
  stale_over_5d: number
  adj_missing_rows: number
  max_stale_days: number
  usable_rate: number | null
  caliber: string
  /** 数据体检（异常涨跌幅 / 停牌跳空 / 有价无量 / 日历缺口 + 健康分） */
  health?: AnalysisHealth
}

export interface AnalysisStability {
  split: string
  design: AnalysisSignificanceRow[]
  validate: AnalysisSignificanceRow[]
  design_excess_pp: Record<string, number | null>
  validate_excess_pp: Record<string, number | null>
  decay_pp: Record<string, number | null>
}

export interface AnalysisDataVersion {
  max_trade_date?: string | null
  symbols?: number
  recent_rows?: { d: string; n: number }[]
}

export interface AnalysisHealth {
  score: number
  level: 'good' | 'warn' | 'bad'
  polluted: boolean
  total_rows: number
  extreme_rows: number
  extreme_rate: number
  resume_jump_rows: number
  zero_amount_rows: number
  adj_missing_rows: number
  unverifiable: number
  unfillable: number
  suspect_days: number
  gaps: { from: string; to: string; days: number }[]
  gap_count: number
  samples: { d0: string; code: string; r1: number; stale_days: number; adj_missing: number }[]
  thresholds: { extreme_return: number; resume_stale_days: number; max_calendar_gap: number }
}

/** 「随机挑一笔交易」口径：按当天命中数加权 + 日聚类标准误 */
export interface AnalysisSignalWeightedRow {
  horizon: number
  caliber: 'exec' | 'close'
  mean_excess_pp: number | null
  mean_return_excess_pp: number | null
  se_pp: number | null
  ci_low_pp: number | null
  ci_high_pp: number | null
  t: number | null
  days: number
  n_signals: number
  significant_up: boolean
  significant_down: boolean
}

export interface AnalysisCostLevel {
  key: string
  label: string
  cost: number | null
  horizons: Record<string, number | null>
}

export interface AnalysisCostSensitivity {
  available: boolean
  levels: AnalysisCostLevel[]
  note?: string | null
}

export interface AnalysisEntryRow {
  base: string
  label: string
  executable: boolean
  available: boolean
  n?: number
  win_rate?: number | null
  excess_pp: number | null
  ci_low_pp?: number | null
  ci_high_pp?: number | null
  days?: number
}

export interface AnalysisPortfolioSide {
  equity: { d0: string; value: number }[]
  metrics: {
    days?: number
    total_return_pct?: number
    annualised_pct?: number | null
    max_drawdown_pct?: number
    sharpe?: number | null
    daily_win_rate?: number | null
    avg_positions?: number
    idle_days?: number
    capital_use_pct?: number
    final_value?: number
  }
}

export interface AnalysisPortfolio {
  config?: { top_k: number; hold_days: number; caliber: string; cost: number | string }
  signal?: AnalysisPortfolioSide
  control?: AnalysisPortfolioSide
  annualised_excess_pp?: number | null
  traded?: number
  skipped?: number
}

export interface AnalysisAttribution {
  horizon?: number
  n?: number
  signals?: number
  controls?: number
  base_win_rate?: number
  hit_win_rate?: number
  raw_excess_pp?: number | null
  adjusted_excess_pp?: number | null
  explained_pct?: number | null
  signal_coef?: number | null
  signal_or?: number | null
  signal_z?: number | null
  signal_p?: number | null
  features?: { name: string; coef: number; or: number; pp: number; z: number | null; p: number | null }[]
  years?: { year: string; pp: number; z: number | null }[]
  note?: string | null
}

export interface AnalysisHeterogeneity {
  horizon: number
  rows: {
    year: string
    effect_pp: number
    se_pp: number
    days: number
    significant_up: boolean
    significant_down: boolean
  }[]
  q?: number | null
  df?: number
  p?: number | null
  i2?: number | null
  pooled_pp?: number | null
  consistent?: boolean | null
  years?: number
}

export interface AnalysisAblationVariant {
  key: string
  label: string
  kind: 'base' | 'drop' | 'param'
  n: number
  days: number
  win_rate: number | null
  excess_pp: number | null
  ci_low_pp: number | null
  ci_high_pp: number | null
  delta_pp: number | null
  delta_ci_low_pp: number | null
  delta_ci_high_pp: number | null
  advice?: 'baseline' | 'drop' | 'keep' | 'neutral' | 'unknown'
}

export interface AnalysisAblation {
  status: 'absent' | 'running' | 'done' | 'failed' | 'interrupted'
  progress?: { done: number; total: number; current: string | null }
  variants: AnalysisAblationVariant[]
  config?: { sample_days: number; horizon: number; caliber?: string }
  error?: string | null
  running?: boolean
  baseline_win_rate?: number | null
}

export interface AnalysisLeaderboardItem {
  rank: number
  run_id: string
  preset: string
  start_date?: string
  end_date?: string
  days: number
  hits: number
  horizon: number
  caliber: 'exec' | 'close'
  excess_pp: number | null
  ci_low_pp: number | null
  ci_high_pp: number | null
  weighted_excess_pp: number | null
  nw_t: number | null
  n_eff: number | null
  significant_up: boolean
  significant_down: boolean
  unverifiable_rate: number | null
  status: string
}

export interface AnalysisLeaderboard {
  items: AnalysisLeaderboardItem[]
  count: number
  expected_max_pp: number | null
  note: string | null
  calibers: string[]
  /** 列表里混了收盘口径（老任务）：不能直接比大小 */
  mixed?: boolean
}

export interface AnalysisReport {
  run: AnalysisRunMeta
  counts: { signals: number; hits: number; control: number; days: number }
  summary: AnalysisSummaryRow[]
  verdict: AnalysisVerdict
  /** 诚实显著性（按日聚合 + 重叠修正），2026-10-23 起 */
  significance?: AnalysisSignificanceRow[]
  /** 按笔交易加权口径（同一天命中越多权重越大） */
  signal_weighted?: AnalysisSignalWeightedRow[]
  /** 成本敏感性（0.2% / 逐行真实 / 0.4% / 0.8%） */
  cost_sensitivity?: AnalysisCostSensitivity
  /** 入场假设敏感性（信号日收盘 / 次日开盘 / 次日收盘 / 次日典型价） */
  entry?: AnalysisEntryRow[]
  /** 组合容量模拟（每日前 K 只、等权、持有 H 天） */
  portfolio?: AnalysisPortfolio
  /** 因子归因（控制市值/行业/年份后还剩多少） */
  attribution?: AnalysisAttribution
  /** 逐年超额 + Cochran's Q */
  heterogeneity?: AnalysisHeterogeneity
  /** 功效：这个样本能检出多大的超额 */
  power?: { mde_pp: number | null; n_eff?: number; days_for_2pp: number | null; effect_pp?: number }
  /** 主周期（成本/入场/组合/归因都用它） */
  primary_horizon?: number
  /** 主要结论（诚实口径） */
  conclusion?: {
    verdict: string
    best_horizon: number | null
    best_excess_pp: number | null
    worst_horizon?: number | null
    worst_excess_pp?: number | null
    up_horizons?: number[]
    down_horizons?: number[]
  }
  /** 'exec' = 次日开盘买入（默认）；'close' = 老任务/无开盘价 */
  caliber?: 'exec' | 'close'
  cost?: number
  stability?: AnalysisStability
  quality?: AnalysisQuality
  data_version?: AnalysisDataVersion
  groups: AnalysisGroupBlock[]
  arrival: AnalysisArrival
  by_board: AnalysisBreakdownRow[]
  by_year: AnalysisBreakdownRow[]
  histograms: {
    edges: number[]
    series: { horizon: number; counts: number[]; below: number; above: number }[]
  }
  density: { d0: string; hits: number }[]
  horizons: number[]
  validate_days: number
  control_hidden: boolean
}

export interface AnalysisDetail {
  run: AnalysisRunMeta
  condition: { name: string; saved_at?: string | null; request?: unknown; missing?: string }
  verdict: AnalysisVerdict | null
  horizons: number[]
}

export interface AnalysisPreview {
  days: number
  first_day: string
  last_day: string
  latest_trade_date: string
  max_end_date: string
  validate_days: number
  horizons: number[]
  trading_days: number
  markets: ScreenMarket[]
  include_st: boolean
  sample_size: number
}

export interface AnalysisCreateBody {
  preset: string
  start_date: string
  end_date?: string | null
  validate_days?: number
  markets?: ScreenMarket[]
  include_st?: boolean
  sample_size?: number
}

export function previewAnalysis(body: AnalysisCreateBody): Promise<AnalysisPreview> {
  return fetchAPI<AnalysisPreview>('/stocks/analysis/preview', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 20000,
  })
}

export async function createAnalysis(body: AnalysisCreateBody): Promise<AnalysisRunMeta> {
  const data = await fetchAPI<{ item: AnalysisRunMeta }>('/stocks/analysis/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 30000,
  })
  return data.item
}

export async function listAnalysisRuns(preset?: string): Promise<AnalysisRunMeta[]> {
  const query = preset ? `?preset=${encodeURIComponent(preset)}` : ''
  const data = await fetchAPI<{ items: AnalysisRunMeta[] }>(`/stocks/analysis/runs${query}`)
  return data?.items ?? []
}

export async function getAnalysisRun(runId: string): Promise<AnalysisRunMeta> {
  const data = await fetchAPI<{ item: AnalysisRunMeta }>(`/stocks/analysis/runs/${runId}`)
  return data.item
}

export async function stopAnalysisRun(runId: string): Promise<AnalysisRunMeta> {
  const data = await fetchAPI<{ item: AnalysisRunMeta }>(`/stocks/analysis/runs/${runId}/stop`, {
    method: 'POST',
  })
  return data.item
}

export async function resumeAnalysisRun(runId: string): Promise<AnalysisRunMeta> {
  const data = await fetchAPI<{ item: AnalysisRunMeta }>(`/stocks/analysis/runs/${runId}/resume`, {
    method: 'POST',
  })
  return data.item
}

export function getAnalysisReport(runId: string): Promise<AnalysisReport> {
  // 首次读报告要把成本敏感性/入场/组合/归因/体检全算一遍（大任务约 60 秒），
  // 之后走 signals.db 里的 report_cache，0.2 秒返回。超时给足，否则第一次必红。
  return fetchAPI<AnalysisReport>(`/stocks/analysis/runs/${runId}/report`, { timeoutMs: 180000 })
}

export function getAnalysisDetail(runId: string): Promise<AnalysisDetail> {
  return fetchAPI<AnalysisDetail>(`/stocks/analysis/runs/${runId}/detail`, { timeoutMs: 20000 })
}

export async function deleteAnalysisRun(runId: string): Promise<void> {
  await fetchAPI(`/stocks/analysis/runs/${runId}`, { method: 'DELETE' })
}

export async function recomputeAnalysisRun(runId: string): Promise<AnalysisRunMeta> {
  const data = await fetchAPI<{ run: AnalysisRunMeta }>(`/stocks/analysis/runs/${runId}/recompute`, {
    method: 'POST',
    timeoutMs: 120000,
  })
  return data.run
}

export interface StockQuery {
  offset?: number
  limit?: number
  sort?: string
  order?: 'asc' | 'desc'
  board?: string
  minSamples?: number
  q?: string
  sufficientOnly?: boolean
}

export async function getAnalysisStocks(
  runId: string,
  query: StockQuery = {},
): Promise<{ total: number; items: AnalysisStockRow[] }> {
  const params = new URLSearchParams()
  params.set('offset', String(query.offset ?? 0))
  params.set('limit', String(query.limit ?? 50))
  params.set('sort', query.sort ?? 'win10')
  params.set('order', query.order ?? 'desc')
  if (query.board) params.set('board', query.board)
  if (query.minSamples) params.set('min_samples', String(query.minSamples))
  if (query.q) params.set('q', query.q)
  if (query.sufficientOnly) params.set('sufficient_only', 'true')
  const data = await fetchAPI<{ total: number; items: AnalysisStockRow[] }>(
    `/stocks/analysis/runs/${runId}/stocks?${params.toString()}`,
  )
  return { total: data.total ?? 0, items: data.items ?? [] }
}

export interface AnalysisSignalRow {
  d0: string
  d0_close: number | null
  avail: number
  returns: (number | null)[]
}

export function getAnalysisSignals(runId: string, code: string): Promise<AnalysisSignalRow[]> {
  return fetchAPI<{ items: AnalysisSignalRow[] }>(
    `/stocks/analysis/runs/${runId}/signals?code=${encodeURIComponent(code)}`,
  ).then(data => data.items ?? [])
}

/**
 * 下载 Excel。不能用 ``fetchAPI``（它按 JSON 解析），所以自己带 Bearer 取 blob。
 * 鉴权走应用登录的 token，不靠 cookie。
 */
export async function downloadAnalysisExcel(runId: string, filename: string): Promise<void> {
  const token = getToken()
  const response = await fetch(`/api/stocks/analysis/runs/${runId}/excel`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—'
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分`
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`
  return `${rest} 秒`
}

/** 消融 / 参数扰动（后台跑，前端轮询） */
export function getAnalysisAblation(runId: string): Promise<AnalysisAblation> {
  return fetchAPI<AnalysisAblation>(`/stocks/analysis/runs/${runId}/ablation`, { timeoutMs: 15000 })
}

export function startAnalysisAblation(
  runId: string,
  options?: { sampleDays?: number; horizon?: number },
): Promise<AnalysisAblation> {
  const params = new URLSearchParams()
  if (options?.sampleDays) params.set('sample_days', String(options.sampleDays))
  if (options?.horizon) params.set('horizon', String(options.horizon))
  const query = params.size > 0 ? `?${params.toString()}` : ''
  return fetchAPI<AnalysisAblation>(`/stocks/analysis/runs/${runId}/ablation${query}`, {
    method: 'POST',
    timeoutMs: 20000,
  })
}

/** 跨条件排行榜（同一口径，含选择偏差提示） */
export function getAnalysisLeaderboard(limit = 40): Promise<AnalysisLeaderboard> {
  return fetchAPI<AnalysisLeaderboard>(`/stocks/analysis/leaderboard?limit=${limit}`, { timeoutMs: 30000 })
}
