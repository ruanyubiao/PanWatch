/**
 * 「条件推理」弹窗：在基础条件上自动搜索更优条件（训练段搜索 + 验证段验算）。
 *
 * 三态（与「数据分析」一致，用户不用学两套交互）：
 *   未开始：选股条件 / 分析方法 / 训练起止 / 验证起止 / 优化次数 → 创建
 *   进行中：进度、当前在试的条件、预计剩余、暂停 / 继续 / 停止
 *   已完成：最终验算通过的条件（训练段 + 验证段双栏数字）+ 保存条件按钮 + 排行榜
 *
 * 文案全部收在 INFER_TEXTS_ZH（check:i18n 的规矩），组件里不出现中文字面量。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, Play, Save, Square } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import type { ScreenPreset } from '@/lib/screen-presets'
import { getAnalysisMethods, type AnalysisMethodSpec } from '@/lib/analysis-api'
import {
  INFER_POLL_MS,
  createInfer,
  formatInferDuration,
  getInferResults,
  getInferRun,
  listInferRuns,
  pauseInfer,
  previewInfer,
  resumeInfer,
  saveInferVariant,
  stopInfer,
  type InferHorizonRow,
  type InferPreview,
  type InferResults,
  type InferRunMeta,
} from '@/lib/infer-api'

export const INFER_TEXTS_ZH = {
  button: '条件推理',
  title: '条件推理（自动搜索更优条件）',
  description: '在基础条件之上反复调整并各跑一轮历史验证，训练段找条件、验证段验真假。',
  preset: '选股条件',
  method: '分析方法',
  trainStart: '训练起始',
  trainEnd: '训练截止',
  validStart: '验证起始',
  validEnd: '验证截止',
  iterations: '优化次数',
  iterationsHint: '每调整一次就跑一轮验证；默认 100 次',
  baseSummary: '基础条件',
  trainDays: (days: number) => `训练段 ${days} 个交易日`,
  validDays: (days: number) => `验证段 ${days} 个交易日`,
  searchDays: (days: number) => `搜索时每个变体抽 ${days} 天`,
  estimate: (text: string) => `预计约 ${text}`,
  maxVerifiable: (day: string) => `可验证的最后一天 ${day}`,
  create: '开始推理',
  cancel: '取消',
  creating: '创建中…',
  previewFailed: (message: string) => `预估失败：${message}`,
  loadFailed: (message: string) => `加载失败：${message}`,
  statusPending: '待开始',
  statusRunning: '进行中',
  statusPaused: '已暂停',
  statusDone: '已完成',
  statusStopped: '已停止',
  statusFailed: '失败',
  phaseLoading: '正在读入行情…',
  phaseSearching: '正在搜索条件…',
  phaseVerifying: '正在做最终验算…',
  phasePaused: '已暂停',
  phaseFinished: '已完成',
  progress: (done: number, total: number) => `${done} / ${total} 次`,
  current: '当前',
  bestScore: (score: string) => `当前最优 +${score}pp`,
  bestNone: '还没有达标的条件',
  signals: (count: number) => `${count} 条信号`,
  eta: (text: string) => `预计剩余 ${text}`,
  elapsed: (text: string) => `已用 ${text}`,
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  stopping: '停止中…',
  finalTitle: '最终验算结果',
  finalHint: '训练段是搜索看过的数据，验证段没看过；两段都是正超额才算通过。',
  finalEmpty: '这次没有找到达标的条件（可以加大优化次数或换个基础条件）',
  rank: '排名',
  condition: '条件',
  trainCol: '训练段',
  validCol: '验证段',
  passed: '双段通过',
  notPassed: '未通过',
  save: '保存条件',
  saved: (name: string) => `已保存为「${name}」`,
  saveFailed: (message: string) => `保存失败：${message}`,
  leaderboard: '搜索过程排行榜',
  leaderboardHint: '分数 = 该口径下最好的持有期超额（百分点），只列样本足够的变体。',
  score: '分数',
  horizon: '持有期',
  winRate: '盈利概率',
  baseline: '随机基准',
  excess: '超额',
  variantSignals: '信号数',
  operation: '方式',
  operatorBase: '基础条件',
  operatorAdd: '补条件',
  operatorTune: '调参数',
  operatorTree: '调基础参数',
  operatorRemove: '去条件',
  noRuns: '还没有推理任务',
  failed: (message: string) => `任务失败：${message}`,
  horizonUnit: (days: number) => `${days} 日`,
  percent: (value: number | null) => (value === null ? '--' : `${value.toFixed(2)}%`),
  pp: (value: number | null) => (value === null ? '--' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}pp`),
}

const DEFAULT_TRAIN_START = '2024-01-01'
const DEFAULT_TRAIN_END = '2025-12-31'
const DEFAULT_VALID_START = '2026-01-01'
const MAX_ITERATIONS = 5000
const inputClass = 'h-7 rounded-md border border-input bg-background px-2 text-[12px]'

type Mode = 'create' | 'run' | 'done'

interface FormState {
  preset: string
  method: string
  trainStart: string
  trainEnd: string
  validStart: string
  validEnd: string
  iterations: number
}

function statusText(status: string): string {
  const T = INFER_TEXTS_ZH
  if (status === 'running') return T.statusRunning
  if (status === 'paused') return T.statusPaused
  if (status === 'done') return T.statusDone
  if (status === 'stopped') return T.statusStopped
  if (status === 'failed') return T.statusFailed
  return T.statusPending
}

function phaseText(phase: string): string {
  const T = INFER_TEXTS_ZH
  if (phase === 'loading') return T.phaseLoading
  if (phase === 'searching') return T.phaseSearching
  if (phase === 'verifying') return T.phaseVerifying
  if (phase === 'paused') return T.phasePaused
  if (phase === 'finished') return T.phaseFinished
  return ''
}

function operatorText(operator: string): string {
  const T = INFER_TEXTS_ZH
  if (operator === 'base') return T.operatorBase
  if (operator === 'add') return T.operatorAdd
  if (operator === 'tune') return T.operatorTune
  if (operator === 'remove') return T.operatorRemove
  return T.operatorTree
}

export function InferDialog({
  open,
  onOpenChange,
  presets,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: ScreenPreset[]
}) {
  const T = INFER_TEXTS_ZH
  const [mode, setMode] = useState<Mode>('create')
  const [methods, setMethods] = useState<AnalysisMethodSpec[]>([])
  const [runs, setRuns] = useState<InferRunMeta[]>([])
  const [run, setRun] = useState<InferRunMeta | null>(null)
  const [results, setResults] = useState<InferResults | null>(null)
  const [preview, setPreview] = useState<InferPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({
    preset: '',
    method: 'stat_v3',
    trainStart: DEFAULT_TRAIN_START,
    trainEnd: DEFAULT_TRAIN_END,
    validStart: DEFAULT_VALID_START,
    validEnd: '',
    iterations: 100,
  })
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setMode('create')
    setRun(null)
    setResults(null)
    setPreview(null)
    setError(null)
    setSavedName(null)
    setForm(current => ({
      ...current,
      preset: presets[0]?.name ?? '',
      trainStart: DEFAULT_TRAIN_START,
      trainEnd: DEFAULT_TRAIN_END,
      validStart: DEFAULT_VALID_START,
      validEnd: '',
      iterations: 100,
    }))
  }, [presets])

  useEffect(() => {
    if (!open) return
    reset()
    let cancelled = false
    void (async () => {
      try {
        const list = await listInferRuns()
        if (cancelled) return
        setRuns(list)
        // 有在跑的（或暂停的）就进那个任务；没有就进最近一次的结果 —— 否则关掉
        // 弹窗再打开，上一次辛苦跑出来的条件就找不回来了
        const active = list.find(item => ['running', 'pending', 'paused'].includes(item.status))
          ?? list[0]
        if (active) {
          setRun(active)
          setMode('run')
        }
      } catch (exc) {
        if (!cancelled) setError(T.loadFailed(exc instanceof Error ? exc.message : String(exc)))
      }
    })()
    void getAnalysisMethods()
      .then(items => {
        if (cancelled) return
        setMethods(items)
        setForm(current => ({ ...current, method: current.method || items[0]?.id || 'stat_v3' }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [T, open, reset])

  // 预估（改表单才问一次，300ms 防抖）
  useEffect(() => {
    if (!open || mode !== 'create' || !form.preset || !form.trainStart || !form.trainEnd) {
      setPreview(null)
      return
    }
    let cancelled = false
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const data = await previewInfer({
            preset: form.preset,
            method: form.method,
            train_start: form.trainStart,
            train_end: form.trainEnd,
            valid_start: form.validStart,
            valid_end: form.validEnd || null,
            iterations: form.iterations,
            markets: null,
            include_st: null,
          })
          if (!cancelled) {
            setPreview(data)
            setError(null)
          }
        } catch (exc) {
          if (!cancelled) {
            setPreview(null)
            setError(exc instanceof Error ? exc.message : String(exc))
          }
        }
      })()
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [form, mode, open])

  // 轮询进度
  useEffect(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    if (!open || mode !== 'run' || !run) return
    // 进来时任务已经结束（历史任务 / 刚跑完）：立刻读结果，不用等下一次轮询
    if (['done', 'stopped', 'failed'].includes(run.status)) {
      const runId = run.run_id
      void (async () => {
        try {
          setResults(await getInferResults(runId))
          setMode('done')
        } catch (exc) {
          setError(exc instanceof Error ? exc.message : String(exc))
        }
      })()
      return
    }
    timer.current = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getInferRun(run.run_id)
          setRun(next)
          if (['done', 'stopped', 'failed'].includes(next.status)) {
            const data = await getInferResults(next.run_id)
            setResults(data)
            setMode('done')
            void listInferRuns().then(setRuns).catch(() => undefined)
          }
        } catch {
          /* 单次轮询失败不打扰用户 */
        }
      })()
    }, INFER_POLL_MS)
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }
  }, [mode, open, run])

  const handleCreate = async () => {
    if (!form.preset || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await createInfer({
        preset: form.preset,
        method: form.method,
        train_start: form.trainStart,
        train_end: form.trainEnd,
        valid_start: form.validStart,
        valid_end: form.validEnd || null,
        iterations: form.iterations,
        markets: null,
        include_st: null,
      })
      setRun(created)
      setResults(null)
      setMode('run')
      setRuns(current => [created, ...current])
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePause = async () => {
    if (!run) return
    try {
      setRun(await pauseInfer(run.run_id))
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    }
  }

  const handleResume = async () => {
    if (!run) return
    try {
      setRun(await resumeInfer(run.run_id))
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    }
  }

  const handleStop = async () => {
    if (!run) return
    try {
      setRun(await stopInfer(run.run_id))
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    }
  }

  const handleSave = async (index: number) => {
    if (!run) return
    try {
      const record = await saveInferVariant(run.run_id, index)
      setSavedName(String(record?.name ?? ''))
    } catch (exc) {
      setError(T.saveFailed(exc instanceof Error ? exc.message : String(exc)))
    }
  }

  const closed = () => onOpenChange(false)
  const progress = run?.progress
  const done = progress?.done_iterations ?? 0
  const total = progress?.iterations ?? form.iterations
  const ratio = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl" data-fork-infer-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <Brain className="h-4 w-4" />
            {T.title}
          </DialogTitle>
          <DialogDescription className="text-[11px]">{T.description}</DialogDescription>
        </DialogHeader>

        {mode === 'create' && (
          <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.preset}</span>
              <Select
                value={form.preset}
                onValueChange={value => setForm(current => ({ ...current, preset: value }))}
              >
                <SelectTrigger className="h-7 w-[280px] text-[12px]" data-fork-infer-preset>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {presets.map(item => (
                    <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {preview && (
                <span className="text-[10px] text-muted-foreground">
                  {T.baseSummary}：{preview.base_summary}
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.method}</span>
              <Select
                value={form.method}
                onValueChange={value => setForm(current => ({ ...current, method: value }))}
              >
                <SelectTrigger className="h-7 w-[280px] text-[12px]" data-fork-infer-method>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(methods.length > 0 ? methods : [{ id: 'stat_v3', name: 'stat_v3' }]).map(item => (
                    <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.trainStart}</span>
              <input
                type="date"
                className={inputClass}
                aria-label={T.trainStart}
                data-fork-infer-train-start
                value={form.trainStart}
                onChange={event => setForm(current => ({ ...current, trainStart: event.target.value }))}
              />
              <span className="text-[11px] text-muted-foreground">{T.trainEnd}</span>
              <input
                type="date"
                className={inputClass}
                aria-label={T.trainEnd}
                data-fork-infer-train-end
                value={form.trainEnd}
                onChange={event => setForm(current => ({ ...current, trainEnd: event.target.value }))}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.validStart}</span>
              <input
                type="date"
                className={inputClass}
                aria-label={T.validStart}
                data-fork-infer-valid-start
                value={form.validStart}
                onChange={event => setForm(current => ({ ...current, validStart: event.target.value }))}
              />
              <span className="text-[11px] text-muted-foreground">{T.validEnd}</span>
              <input
                type="date"
                className={inputClass}
                aria-label={T.validEnd}
                data-fork-infer-valid-end
                max={preview?.max_verifiable ?? undefined}
                value={form.validEnd}
                onChange={event => {
                  const value = event.target.value
                  const cap = preview?.max_verifiable
                  setForm(current => ({ ...current, validEnd: cap && value > cap ? cap : value }))
                }}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.iterations}</span>
              <input
                type="number"
                min={1}
                max={MAX_ITERATIONS}
                step={1}
                className={inputClass}
                aria-label={T.iterations}
                data-fork-infer-iterations
                value={form.iterations}
                onChange={event => {
                  const parsed = Math.trunc(Number(event.target.value))
                  setForm(current => ({
                    ...current,
                    iterations: Number.isFinite(parsed)
                      ? Math.min(MAX_ITERATIONS, Math.max(1, parsed))
                      : 1,
                  }))
                }}
              />
              <span className="text-[10px] text-muted-foreground">{T.iterationsHint}</span>
            </div>

            {preview && (
              <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-[11px] text-muted-foreground">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span>{T.trainDays(preview.train_days)}</span>
                  <span>{T.validDays(preview.valid_days)}</span>
                  <span>{T.searchDays(preview.search_days)}</span>
                  <span>{T.estimate(formatInferDuration(preview.estimate_seconds))}</span>
                  <span>{T.maxVerifiable(preview.max_verifiable)}</span>
                </div>
              </div>
            )}

            {error && <div className="text-[11px] text-destructive">{error}</div>}

            <div className="flex items-center justify-between pt-1">
              <span className="text-[10px] text-muted-foreground">
                {runs.length > 0
                  ? `${T.leaderboard}：${runs[0].run_id}（${statusText(runs[0].status)}）`
                  : T.noRuns}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={closed}>
                  {T.cancel}
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-[12px]"
                  data-fork-infer-create
                  disabled={!form.preset || submitting}
                  onClick={() => void handleCreate()}
                >
                  <Play className="h-3.5 w-3.5" />
                  {submitting ? T.creating : T.create}
                </Button>
              </div>
            </div>
          </div>
        )}

        {mode !== 'create' && run && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded border border-border px-1.5 py-0.5" data-fork-infer-status>
                {statusText(run.status)}
              </span>
              <span className="text-muted-foreground">{run.base_summary}</span>
              <span className="text-muted-foreground">
                {T.trainDays(run.train_day_count)} / {T.validDays(run.valid_day_count)}
              </span>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span data-fork-infer-phase>{phaseText(progress?.phase ?? '')}</span>
                <span>{T.progress(done, total)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.max(run.status === 'running' ? 2 : 0, ratio)}%` }}
                  data-fork-infer-progress
                />
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                <span>{T.elapsed(formatInferDuration(progress?.elapsed_s))}</span>
                <span>{T.eta(formatInferDuration(progress?.eta_s))}</span>
                <span>
                  {progress?.best_score === null || progress?.best_score === undefined
                    ? T.bestNone
                    : T.bestScore(String(progress.best_score))}
                </span>
                {progress?.current ? <span className="truncate">{T.current}：{progress.current}</span> : null}
              </div>
            </div>

            {error && <div className="text-[11px] text-destructive">{error}</div>}
            {run.status === 'failed' && run.error && (
              <div className="text-[11px] text-destructive">{T.failed(run.error)}</div>
            )}

            <div className="flex items-center gap-2">
              {run.status === 'paused' ? (
                <Button size="sm" className="h-7 text-[12px]" data-fork-infer-resume
                        onClick={() => void handleResume()}>
                  <Play className="h-3.5 w-3.5" />
                  {T.resume}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-[12px]"
                  data-fork-infer-pause
                  disabled={!['running', 'pending'].includes(run.status)}
                  onClick={() => void handlePause()}
                >
                  {T.pause}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                className="h-7 text-[12px]"
                data-fork-infer-stop
                disabled={!['running', 'pending', 'paused'].includes(run.status)}
                onClick={() => void handleStop()}
              >
                <Square className="h-3.5 w-3.5" />
                {T.stop}
              </Button>
            </div>

            {mode === 'done' && results && (
              <div className="space-y-2">
                <div className="text-[12px] font-medium">{T.finalTitle}</div>
                <div className="text-[10px] text-muted-foreground">{T.finalHint}</div>
                {savedName && <div className="text-[11px] text-primary">{T.saved(savedName)}</div>}
                {results.finalists.length === 0 && (
                  <div className="text-[11px] text-muted-foreground">{T.finalEmpty}</div>
                )}
                {results.finalists.map(item => (
                  <div key={item.rank} className="rounded-md border border-border/60 p-2"
                       data-fork-infer-finalist>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-[12px]">
                        <span className="mr-1.5 text-muted-foreground">#{item.rank}</span>
                        {item.desc}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                          item.passed
                            ? 'border border-primary/60 bg-primary/10 text-primary'
                            : 'border border-border text-muted-foreground'
                        }`}>
                          {item.passed ? T.passed : T.notPassed}
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          className="h-6 text-[11px]"
                          data-fork-infer-save
                          onClick={() => void handleSave(item.rank)}
                        >
                          <Save className="h-3 w-3" />
                          {T.save}
                        </Button>
                      </div>
                    </div>
                    <HorizonTable
                      train={item.train_rows}
                      valid={item.valid_rows}
                      trainSignals={item.train_signals}
                      validSignals={item.valid_signals}
                    />
                  </div>
                ))}

                {results.rows.length > 0 && (
                  <div className="space-y-1 pt-1">
                    <div className="text-[12px] font-medium">{T.leaderboard}</div>
                    <div className="text-[10px] text-muted-foreground">{T.leaderboardHint}</div>
                    <div className="max-h-56 overflow-auto scrollbar rounded border border-border/60">
                      <table className="w-full text-[11px]">
                        <thead className="sticky top-0 bg-muted/40 text-muted-foreground">
                          <tr>
                            <th className="px-2 py-1 text-left">{T.rank}</th>
                            <th className="px-2 py-1 text-left">{T.condition}</th>
                            <th className="px-2 py-1 text-right">{T.score}</th>
                            <th className="px-2 py-1 text-right">{T.horizon}</th>
                            <th className="px-2 py-1 text-left">{T.operation}</th>
                            <th className="px-2 py-1 text-right">{T.variantSignals}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {results.rows.slice(0, 20).map((row, position) => (
                            <tr key={row.index} className="border-t border-border/40">
                              <td className="px-2 py-1 text-muted-foreground">{position + 1}</td>
                              <td className="px-2 py-1">{row.desc}</td>
                              <td className="px-2 py-1 text-right font-mono">
                                {row.score === null ? '--' : T.pp(row.score)}
                              </td>
                              <td className="px-2 py-1 text-right">
                                {row.best_horizon === null ? '--' : T.horizonUnit(row.best_horizon)}
                              </td>
                              <td className="px-2 py-1 text-muted-foreground">
                                {operatorText(row.operator)}
                              </td>
                              <td className="px-2 py-1 text-right">{row.signals}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 训练段 / 验证段并列的五档持有期表（每格：概率 vs 基准 → 超额）。 */
function HorizonTable({
  train,
  valid,
  trainSignals,
  validSignals,
}: {
  train: InferHorizonRow[]
  valid: InferHorizonRow[]
  trainSignals: number
  validSignals: number
}) {
  const T = INFER_TEXTS_ZH
  const cell = (row: InferHorizonRow | undefined) => {
    if (!row) return '--'
    return `${T.percent(row.exec_rate)} / ${T.percent(row.exec_base)} ${T.pp(row.exec_excess)}`
  }
  return (
    <div className="mt-1 overflow-x-auto scrollbar">
      <table className="w-full text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-1 py-0.5 text-left">{T.trainCol}（{trainSignals}）</th>
            <th className="px-1 py-0.5 text-left">{T.horizon}</th>
            <th className="px-1 py-0.5 text-right">{T.winRate} / {T.baseline}</th>
            <th className="px-1 py-0.5 text-left">{T.validCol}（{validSignals}）</th>
            <th className="px-1 py-0.5 text-right">{T.winRate} / {T.baseline}</th>
          </tr>
        </thead>
        <tbody>
          {train.map((row, index) => (
            <tr key={row.horizon} className="border-t border-border/40">
              <td className="px-1 py-0.5" />
              <td className="px-1 py-0.5">{T.horizonUnit(row.horizon)}</td>
              <td className="px-1 py-0.5 text-right font-mono">{cell(row)}</td>
              <td className="px-1 py-0.5" />
              <td className="px-1 py-0.5 text-right font-mono">{cell(valid[index])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
