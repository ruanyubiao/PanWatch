/**
 * 条件推理接口（在基础条件上自动搜索更优条件）。
 *
 * 后端：``/api/stocks/infer/*``（``src/modules/market/api/fork_infer.py``）。
 *
 * 和「数据分析」的区别：数据分析是「这一个条件好不好」，条件推理是
 * 「这个条件改哪里会更好」—— 一个任务 = 训练段（搜索）+ 验证段（验算）。
 */
import { fetchAPI } from '@panwatch/api'
import type { ScreenMarket } from '@/lib/screen-rule'

/** 进度轮询间隔（推理任务一次变体要十几秒，2 秒一次足够） */
export const INFER_POLL_MS = 2500

export type InferStatus = 'pending' | 'running' | 'paused' | 'interrupted' | 'done' | 'stopped' | 'failed'

export interface InferProgress {
  phase: string
  done_iterations: number
  iterations: number
  current: string
  best_score: number | null
  best_desc: string
  elite: number
  elapsed_s: number
  eta_s: number | null
  variants_evaluated: number
  load_progress: number
  load_label?: string
  current_score?: number | null
  current_signals?: number
  /** 成功 / 失败次数（失败的变体只在内存里计数，不落盘） */
  successes?: number
  failures?: number
  attempts?: number
  /** 搜索空间耗尽（提前结束的唯一合法原因） */
  exhausted?: boolean
  finalists?: number
  passed?: number
}

export interface InferRunMeta {
  run_id: string
  created_at: string
  status: InferStatus
  preset: string
  base_summary: string
  method: string
  method_name: string
  train_start: string
  train_end: string
  valid_start: string
  valid_end: string
  train_day_count: number
  valid_day_count: number
  search_days: number
  iterations: number
  done_iterations: number
  horizons: number[]
  markets: ScreenMarket[]
  include_st: boolean
  estimate_seconds: number
  elapsed_s?: number
  error?: string | null
  alive: boolean
  progress: InferProgress
  /** 历史记录用：任务类型与两个评分 */
  kind?: 'infer'
  score_train?: number | null
  score_test?: number | null
  score_grade?: string | null
  score_verdict?: { verdict?: string; text?: string; score?: number | null }
  /** 历史列表用：有效范围与个股最高分 */
  scope_label?: string
  stock_best_score?: number | null
  scores?: InferScores | null
  best_desc?: string | null
  successes?: number
  failures?: number
  exhausted?: boolean
  finished_at?: string | null
}

/** 推理段 / 测试段两个 0–100 分（用户 2026-10-24 第 9 条） */
export interface InferGrade {
  score?: number | null
  grade?: string
  grade_text?: string
  best_window?: number | null
  excess_pp?: number | null
  lower_pp?: number | null
  events?: number
  days?: number
  caps?: string[]
  components?: Record<string, number | null>
}

/** 有效范围（用户 2026-11-03 第 2/3/4 条）：通用 / 个股 / 通用+个股 */
export type InferScope = 'general' | 'stock'

/** 一只股票在某条条件下的成绩（个股名单用，id + 名字） */
export interface InferStockScore {
  code: string
  name: string
  train_score?: number | null
  test_score?: number | null
  best_score?: number | null
  train_signals?: number | null
  test_signals?: number | null
  window?: number | null
  train_win_rate?: number | null
  test_win_rate?: number | null
  train_excess_pp?: number | null
  test_excess_pp?: number | null
}

export interface InferScores {
  train?: InferGrade
  test?: InferGrade
  verdict?: { verdict?: string; score?: number | null; text?: string }
  desc?: string
  scope?: InferScope[]
  scope_label?: string
  stock_best_score?: number | null
  stock_qualified?: number
}

export interface InferHorizonRow {
  horizon: number
  /** 收盘口径（d0 收盘买）胜率 */
  close_rate: number | null
  close_base: number | null
  close_excess: number | null
  close_day_excess: number | null
  close_n: number
  /** 可执行口径（次日开盘买、扣 0.2%）胜率 */
  exec_rate: number | null
  exec_base: number | null
  exec_excess: number | null
  exec_day_excess: number | null
  exec_n: number
  /** 窗口内摸到 +5% 的比例 */
  touch_rate: number | null
  touch_base: number | null
  touch_excess: number | null
  touch_day_excess: number | null
  touch_n: number
  years: Record<string, number>
}

export interface InferVariantRow {
  index: number
  desc: string
  operator: string
  parent: number | null
  score: number | null
  best_horizon: number | null
  signals: number
  days_with_hits: number
  days: number
  seconds: number
  rows: InferHorizonRow[]
}

export interface InferFinalist {
  rank: number
  desc: string
  operator: string
  trial_score: number | null
  train_score: number | null
  train_horizon: number | null
  train_signals: number
  train_days: number
  valid_score: number | null
  valid_horizon: number | null
  valid_signals: number
  valid_days: number
  passed: boolean
  train_rows: InferHorizonRow[]
  valid_rows: InferHorizonRow[]
  /** 0–100 分（新任务有；老任务没有） */
  train_grade?: InferGrade
  valid_grade?: InferGrade
  combined?: { verdict?: string; score?: number | null; text?: string }
  /** 有效范围 + 个股名单（用户 2026-11-03 第 2/4/5 条） */
  kept?: boolean
  scope?: InferScope[]
  scope_label?: string
  stock_best_score?: number | null
  stock_qualified?: number
  stock_universe?: number
  stock_list?: InferStockScore[]
}

export interface InferResults {
  run_id: string
  evaluated: number
  ranked: number
  rows: InferVariantRow[]
  finalists: InferFinalist[]
}

export interface InferHistoryItem {
  run_id: string
  status: InferStatus
  preset: string
  created_at: string
  score_train?: number | null
  score_test?: number | null
}

export interface InferPreview {
  method: string
  method_name: string
  train_days: number
  valid_days: number
  train_first: string
  train_last: string
  valid_first: string
  valid_last: string
  search_days: number
  iterations: number
  max_verifiable: string
  latest_trade_date: string
  base_summary: string
  base_trading_days: number
  base_bars: number
  estimate_seconds: number
  horizons: number[]
}

export interface InferCreateBody {
  preset: string
  method: string
  train_start: string
  train_end: string
  valid_start: string
  valid_end: string | null
  iterations: number
  /** 省略 = 用条件自己存的市场（用户 2026-11-04 第 1 条：表单不再选股票范围） */
  markets?: ScreenMarket[] | null
  include_st?: boolean | null
  seed?: number
}

export function previewInfer(body: InferCreateBody): Promise<InferPreview> {
  return fetchAPI<InferPreview>('/stocks/infer/preview', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 20000,
  })
}

export async function createInfer(body: InferCreateBody): Promise<InferRunMeta> {
  const data = await fetchAPI<{ item: InferRunMeta }>('/stocks/infer/runs', {
    method: 'POST',
    body: JSON.stringify(body),
    timeoutMs: 30000,
  })
  return data.item
}

export async function listInferRuns(limit = 20): Promise<InferRunMeta[]> {
  const data = await fetchAPI<{ items: InferRunMeta[] }>(`/stocks/infer/runs?limit=${limit}`, {
    timeoutMs: 15000,
  })
  return data.items ?? []
}

export async function getInferRun(runId: string): Promise<InferRunMeta> {
  const data = await fetchAPI<{ item: InferRunMeta }>(`/stocks/infer/runs/${runId}`, {
    timeoutMs: 15000,
  })
  return data.item
}

async function control(runId: string, action: 'pause' | 'resume' | 'stop'): Promise<InferRunMeta> {
  const data = await fetchAPI<{ item: InferRunMeta }>(
    `/stocks/infer/runs/${runId}/${action}`,
    { method: 'POST', timeoutMs: 15000 },
  )
  return data.item
}

export function pauseInfer(runId: string): Promise<InferRunMeta> {
  return control(runId, 'pause')
}

export function resumeInfer(runId: string): Promise<InferRunMeta> {
  return control(runId, 'resume')
}

export function stopInfer(runId: string): Promise<InferRunMeta> {
  return control(runId, 'stop')
}

export function getInferResults(runId: string, limit = 30): Promise<InferResults> {
  return fetchAPI<InferResults>(`/stocks/infer/runs/${runId}/results?limit=${limit}`, {
    timeoutMs: 30000,
  })
}

export async function saveInferVariant(
  runId: string,
  index: number,
  name?: string,
): Promise<{ name: string }> {
  const query = name ? `&name=${encodeURIComponent(name)}` : ''
  return fetchAPI<{ name: string }>(`/stocks/infer/runs/${runId}/save?index=${index}${query}`, {
    method: 'POST',
    timeoutMs: 20000,
  })
}

export async function deleteInferRun(runId: string): Promise<void> {
  await fetchAPI(`/stocks/infer/runs/${runId}`, { method: 'DELETE', timeoutMs: 15000 })
}

/** 秒 → 「1 小时 5 分」 */
export function formatInferDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--'
  }
  const total = Math.round(seconds)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}
