/**
 * 「数据分析」弹窗（三态：未开始 / 进行中 / 已完成）。
 *
 * 未开始：选一个已保存条件 + 日期区间 + 股票范围 → 创建任务
 * 进行中：进度条、已完成天数、命中数、预计剩余、停止按钮、最近完成的日期
 * 已完成（含已停止）：结论卡 + 六周期柱状图 + 前 10 名个股排行 + 完整报告 / Excel
 *
 * 任务在后端线程里跑（页面可以关）。重新打开弹窗时如果有任务在跑，直接进「进行中」，
 * 不用用户自己找 —— 否则关掉弹窗就再也看不到进度了。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Download, ExternalLink, Play, Square } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { toLocalDateTimeInput } from '@panwatch/base-ui/datetime'
import { SCREEN_MARKETS, type ScreenMarket } from '@/lib/screen-rule'
import type { ScreenPreset } from '@/lib/screen-presets'
import {
  ANALYSIS_POLL_MS,
  createAnalysis,
  downloadAnalysisExcel,
  formatDuration,
  getAnalysisReport,
  getAnalysisRun,
  listAnalysisRuns,
  previewAnalysis,
  resumeAnalysisRun,
  stopAnalysisRun,
  type AnalysisPreview,
  type AnalysisReport,
  type AnalysisRunMeta,
} from '@/lib/analysis-api'
import { AnalysisStockTable } from './analysis/AnalysisStockTable'
import { AnalysisSummaryBody } from './analysis/AnalysisSummary'

export const ANALYSIS_DIALOG_TEXTS_ZH = {
  button: '数据分析',
  title: '数据分析',
  description: '用一个已保存条件回测历史每一天：命中后 30 个交易日的涨幅与上涨概率。',
  createTitle: '创建数据分析任务',
  createHint: '选择条件、区间与股票范围，任务在后台跑，可以关掉页面。',
  preset: '已保存条件',
  presetPlaceholder: '选择一个已保存条件',
  presetEmpty: '还没有已保存的条件，先去「条件选股」保存一个',
  start: '开始日期',
  end: '结束日期',
  endHint: '留空 = 库里最新交易日',
  market: '股票范围',
  marketAll: '全部',
  marketSh: '上证',
  marketSz: '深证',
  marketCyb: '创业',
  marketKcb: '科创',
  includeSt: '包含 ST / *ST',
  estimate: (days: number, hours: string) => `区间内 ${days} 个交易日，预计约 ${hours}`,
  estimatePending: '正在估算交易日数…',
  sampleNote: '每天另外随机抽 200 只做对照（判断「是不是本来就会涨」）',
  create: '创建任务',
  creating: '创建中…',
  running: '进行中',
  progressTitle: (done: number, total: number) => `已完成 ${done} / ${total} 个交易日`,
  progressHits: (hits: number, control: number) => `命中 ${hits} 条，对照 ${control} 条`,
  progressEta: (eta: string) => `预计剩余 ${eta}`,
  progressCurrent: (day: string) => `正在跑 ${day}`,
  stop: '停止',
  stopping: '正在停止…',
  interrupted: '任务中断（进程重启过），可以继续跑。',
  resume: '继续跑',
  failed: '任务失败',
  stoppedNote: (done: number) => `已停止，结果只含前 ${done} 个交易日`,
  doneNote: (days: number, hits: number) => `已完成 ${days} 个交易日，命中 ${hits} 条`,
  recent: '最近完成的日期',
  recentDay: (day: string, hits: number) => `${day} · 命中 ${hits}`,
  resultTitle: '结果',
  fullReport: '查看完整报告（新标签页）',
  excel: '下载 Excel',
  excelPending: 'Excel 生成中',
  newTask: '新建任务',
  historyTitle: '历史任务',
  historyEmpty: '这个条件还没有跑过',
  historyItem: (created: string, days: number, hits: number) => `${created} · ${days} 天 · ${hits} 条`,
  statusPending: '排队中',
  statusRunning: '进行中',
  statusInterrupted: '已中断',
  statusDone: '已完成',
  statusStopped: '已停止',
  statusFailed: '失败',
  marketsSummary: (markets: string, st: string) => `${markets} · ${st}`,
  stIncluded: '含 ST',
  stExcluded: '不含 ST',
  loadFailed: (message: string) => `读取失败：${message}`,
  createFailed: (message: string) => `创建失败：${message}`,
  stopsFailed: (message: string) => `停止失败：${message}`,
  downloaded: (name: string) => `已开始下载 ${name}`,
}

const DEFAULT_START = '2020-01-01'

type Mode = 'create' | 'run'

interface FormState {
  preset: string
  startDate: string
  endDate: string
  marketAll: boolean
  markets: ScreenMarket[]
  includeSt: boolean
}

const MARKET_LABELS: Record<ScreenMarket, string> = {
  sh: ANALYSIS_DIALOG_TEXTS_ZH.marketSh,
  sz: ANALYSIS_DIALOG_TEXTS_ZH.marketSz,
  cyb: ANALYSIS_DIALOG_TEXTS_ZH.marketCyb,
  kcb: ANALYSIS_DIALOG_TEXTS_ZH.marketKcb,
}

function formatCreatedAt(instant: string): string {
  // 用共享的本地时间转换（不能用 slice + replace 直接裁 ISO：会丢掉时区偏移）
  return toLocalDateTimeInput(instant).slice(0, 16).replace('T', ' ')
}

function statusLabel(status: string): string {
  const T = ANALYSIS_DIALOG_TEXTS_ZH
  switch (status) {
    case 'pending':
      return T.statusPending
    case 'running':
      return T.statusRunning
    case 'interrupted':
      return T.statusInterrupted
    case 'done':
      return T.statusDone
    case 'stopped':
      return T.statusStopped
    case 'failed':
      return T.statusFailed
    default:
      return status
  }
}

export function AnalysisDialog({
  open,
  onOpenChange,
  presets,
  asof,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: ScreenPreset[]
  asof: string | null
}) {
  const T = ANALYSIS_DIALOG_TEXTS_ZH
  const [mode, setMode] = useState<Mode>('create')
  const [form, setForm] = useState<FormState>({
    preset: '',
    startDate: DEFAULT_START,
    endDate: '',
    marketAll: true,
    markets: [...SCREEN_MARKETS],
    includeSt: false,
  })
  const [preview, setPreview] = useState<AnalysisPreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [runs, setRuns] = useState<AnalysisRunMeta[]>([])
  const [run, setRun] = useState<AnalysisRunMeta | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setMode('create')
    setRun(null)
    setReport(null)
    setError(null)
    setPreview(null)
    setPreviewError(null)
    setStopping(false)
    setForm({
      preset: presets[0]?.name ?? '',
      startDate: DEFAULT_START,
      endDate: asof ?? '',
      marketAll: true,
      markets: [...SCREEN_MARKETS],
      includeSt: false,
    })
  }, [asof, presets])

  // 打开时：有任务在跑就直接进「进行中」，否则停在「未开始」
  useEffect(() => {
    if (!open) return
    reset()
    let cancelled = false
    void (async () => {
      try {
        const list = await listAnalysisRuns()
        if (cancelled) return
        setRuns(list)
        const active = list.find(item => item.status === 'running' || item.status === 'pending')
        if (active) {
          setRun(active)
          setMode('run')
        }
      } catch (exc) {
        if (!cancelled) setError(T.loadFailed(exc instanceof Error ? exc.message : String(exc)))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [T, open, reset])

  // 预估交易日数（条件 / 区间变了才问）
  useEffect(() => {
    if (!open || mode !== 'create' || !form.preset || !form.startDate) {
      setPreview(null)
      return
    }
    let cancelled = false
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const data = await previewAnalysis({
            preset: form.preset,
            start_date: form.startDate,
            end_date: form.endDate || null,
            markets: form.marketAll ? [...SCREEN_MARKETS] : form.markets,
            include_st: form.includeSt,
          })
          if (!cancelled) {
            setPreview(data)
            setPreviewError(null)
          }
        } catch (exc) {
          if (!cancelled) {
            setPreview(null)
            setPreviewError(exc instanceof Error ? exc.message : String(exc))
          }
        }
      })()
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [form.endDate, form.includeSt, form.marketAll, form.markets, form.preset, form.startDate, mode, open])

  // 进行中：轮询；到终态后拉统计
  useEffect(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    if (!open || mode !== 'run' || !run) return
    const active = run.status === 'running' || run.status === 'pending'
    if (!active) return
    timer.current = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getAnalysisRun(run.run_id)
          setRun(current => ({ ...(current ?? next), ...next }))
          if (next.status !== 'running' && next.status !== 'pending') {
            void listAnalysisRuns().then(setRuns).catch(() => undefined)
          }
        } catch {
          /* 轮询失败不打扰用户：下一轮再试 */
        }
      })()
    }, ANALYSIS_POLL_MS)
    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
        timer.current = null
      }
    }
  }, [mode, open, run])

  const loadReport = useCallback(
    async (runId: string) => {
      try {
        const data = await getAnalysisReport(runId)
        setReport(data)
        setError(null)
      } catch (exc) {
        setReport(null)
        setError(exc instanceof Error ? exc.message : String(exc))
      }
    },
    [],
  )

  const terminal = run ? ['done', 'stopped'].includes(run.status) : false

  useEffect(() => {
    if (mode !== 'run' || !run) return
    if (!['done', 'stopped'].includes(run.status)) return
    if (report && report.run.run_id === run.run_id) return
    void loadReport(run.run_id)
  }, [loadReport, mode, report, run])

  const handleCreate = async () => {
    if (!form.preset || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await createAnalysis({
        preset: form.preset,
        start_date: form.startDate,
        end_date: form.endDate || null,
        markets: form.marketAll ? [...SCREEN_MARKETS] : form.markets,
        include_st: form.includeSt,
      })
      setRun(created)
      setReport(null)
      setMode('run')
      setRuns(current => [created, ...current])
    } catch (exc) {
      setError(T.createFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setSubmitting(false)
    }
  }

  const handleStop = async () => {
    if (!run) return
    setStopping(true)
    try {
      const next = await stopAnalysisRun(run.run_id)
      setRun(current => ({ ...(current ?? next), ...next }))
    } catch (exc) {
      setError(T.stopsFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setStopping(false)
    }
  }

  const handleResume = async () => {
    if (!run) return
    try {
      const next = await resumeAnalysisRun(run.run_id)
      setRun(next)
      setReport(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    }
  }

  const handleDownload = async () => {
    if (!run) return
    try {
      const name = `${run.preset}-${run.run_id}.xlsx`
      await downloadAnalysisExcel(run.run_id, name)
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    }
  }

  const toggleMarket = (key: ScreenMarket) => {
    setForm(current => {
      if (current.marketAll) {
        return { ...current, marketAll: false, markets: [key] }
      }
      const next = current.markets.includes(key)
        ? current.markets.filter(item => item !== key)
        : [...current.markets, key]
      if (next.length === 0) return current
      if (next.length === SCREEN_MARKETS.length) return { ...current, marketAll: true, markets: next }
      return { ...current, markets: next }
    })
  }

  const progress = run?.progress
  const percent = useMemo(() => {
    if (!run) return 0
    const total = progress?.days_total ?? run.days_total ?? 0
    const done = progress?.days_done ?? run.days_done ?? 0
    if (!total) return 0
    return Math.min(100, Math.round((done / total) * 100))
  }, [progress, run])

  const presetRuns = useMemo(
    () => runs.filter(item => !form.preset || item.preset === form.preset).slice(0, 8),
    [form.preset, runs],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[968px]" data-fork-analysis-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            {T.title}
          </DialogTitle>
          <DialogDescription>{T.description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[72vh] overflow-y-auto scrollbar pr-1">
          {error && <p className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>}

          {mode === 'create' && (
            <div className="space-y-3" data-fork-analysis-create>
              <div className="rounded-lg border border-border/60 bg-accent/10 p-3">
                <p className="mb-2 text-[12px] font-medium">{T.createTitle}</p>
                <p className="mb-2 text-[10px] text-muted-foreground">{T.createHint}</p>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{T.preset}</span>
                    {presets.length === 0 ? (
                      <span className="text-[11px] text-amber-600">{T.presetEmpty}</span>
                    ) : (
                      <Select
                        value={form.preset}
                        onValueChange={value => setForm(current => ({ ...current, preset: value }))}
                      >
                        <SelectTrigger className="h-7 w-[220px] text-[12px]" data-fork-analysis-preset>
                          <SelectValue placeholder={T.presetPlaceholder} />
                        </SelectTrigger>
                        <SelectContent>
                          {presets.map(preset => (
                            <SelectItem key={preset.name} value={preset.name}>
                              {preset.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{T.start}</span>
                    <input
                      type="date"
                      value={form.startDate}
                      aria-label={T.start}
                      data-fork-analysis-start
                      onChange={event => setForm(current => ({ ...current, startDate: event.target.value }))}
                      className="h-7 rounded-md border border-input bg-background px-2 text-[12px]"
                    />
                    <span className="text-[11px] text-muted-foreground">{T.end}</span>
                    <input
                      type="date"
                      value={form.endDate}
                      aria-label={T.end}
                      data-fork-analysis-end
                      onChange={event => setForm(current => ({ ...current, endDate: event.target.value }))}
                      className="h-7 rounded-md border border-input bg-background px-2 text-[12px]"
                    />
                    <span className="text-[10px] text-muted-foreground">{T.endHint}</span>
                  </div>

                  {/* 市场：与条件选股同一套「全部 / 四个市场」radio 组（全部是独立状态） */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-20 shrink-0 text-[11px] text-muted-foreground">{T.market}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setForm(current => ({ ...current, marketAll: true, markets: [...SCREEN_MARKETS] }))
                      }
                      className={`h-7 rounded-md border px-2 text-[11px] ${
                        form.marketAll ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border/60'
                      }`}
                    >
                      {T.marketAll}
                    </button>
                    {SCREEN_MARKETS.map(key => (
                      <label
                        key={key}
                        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-primary"
                          checked={!form.marketAll && form.markets.includes(key)}
                          onChange={() => toggleMarket(key)}
                        />
                        {MARKET_LABELS[key]}
                      </label>
                    ))}
                    <label className="ml-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-primary"
                        checked={form.includeSt}
                        onChange={event => setForm(current => ({ ...current, includeSt: event.target.checked }))}
                      />
                      {T.includeSt}
                    </label>
                  </div>

                  <p className="text-[10px] text-muted-foreground" data-fork-analysis-estimate>
                    {preview
                      ? T.estimate(preview.days, formatDuration(preview.days * 4))
                      : previewError ?? T.estimatePending}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{T.sampleNote}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-7 px-3 text-[12px]"
                  disabled={!form.preset || submitting || presets.length === 0}
                  onClick={() => void handleCreate()}
                  data-fork-analysis-create-button
                >
                  <Play className="h-3.5 w-3.5" />
                  {submitting ? T.creating : T.create}
                </Button>
              </div>

              <section>
                <p className="mb-1 text-[11px] font-medium">{T.historyTitle}</p>
                {presetRuns.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">{T.historyEmpty}</p>
                ) : (
                  <ul className="space-y-0.5">
                    {presetRuns.map(item => (
                      <li key={item.run_id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between rounded border border-transparent px-1.5 py-1 text-[11px] hover:border-border/60 hover:bg-accent/20"
                          onClick={() => {
                            setRun(item)
                            setMode('run')
                            setReport(null)
                          }}
                        >
                          <span>
                            {T.historyItem(formatCreatedAt(item.created_at), item.days_total, item.hits)}
                          </span>
                          <span className="text-muted-foreground">{statusLabel(item.status)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}

          {mode === 'run' && run && (
            <div className="space-y-3" data-fork-analysis-run={run.status}>
              <div className="rounded-lg border border-border/60 bg-accent/10 p-3">
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="font-medium">
                    {run.preset} · {statusLabel(run.status)}
                  </span>
                  <span className="text-muted-foreground">
                    {T.marketsSummary(
                      run.markets.length === SCREEN_MARKETS.length
                        ? T.marketAll
                        : run.markets.map(key => MARKET_LABELS[key]).join(' / '),
                      run.include_st ? T.stIncluded : T.stExcluded,
                    )}
                  </span>
                </div>

                {(run.status === 'running' || run.status === 'pending') && (
                  <>
                    <div className="mb-1 h-1.5 w-full overflow-hidden rounded bg-border/60">
                      <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
                    </div>
                    <p className="text-[11px]">
                      {T.progressTitle(progress?.days_done ?? run.days_done, progress?.days_total ?? run.days_total)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {T.progressHits(progress?.hits ?? run.hits, progress?.control ?? run.control)}
                      {' · '}
                      {T.progressEta(formatDuration(progress?.eta_s ?? null))}
                      {progress?.current_d0 ? ` · ${T.progressCurrent(progress.current_d0)}` : ''}
                    </p>
                    <Button
                      size="sm"
                      variant="destructive"
                      className="mt-2 h-7 px-3 text-[12px]"
                      disabled={stopping}
                      onClick={() => void handleStop()}
                      data-fork-analysis-stop
                    >
                      <Square className="h-3.5 w-3.5" />
                      {stopping ? T.stopping : T.stop}
                    </Button>
                  </>
                )}

                {run.status === 'interrupted' && (
                  <>
                    <p className="text-[11px]">{T.interrupted}</p>
                    <Button size="sm" className="mt-2 h-7 px-3 text-[12px]" onClick={() => void handleResume()}>
                      <Play className="h-3.5 w-3.5" />
                      {T.resume}
                    </Button>
                  </>
                )}

                {run.status === 'failed' && (
                  <p className="text-[11px] text-destructive">
                    {T.failed}：{run.error ?? '—'}
                  </p>
                )}

                {run.status === 'stopped' && <p className="text-[11px]">{T.stoppedNote(run.days_done)}</p>}
                {run.status === 'done' && (
                  <p className="text-[11px]">{T.doneNote(run.days_done, run.hits)}</p>
                )}

                {run.recent_days && run.recent_days.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] text-muted-foreground">{T.recent}</summary>
                    <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
                      {run.recent_days.slice(0, 10).map(item => (
                        <li key={item.d0}>{T.recentDay(item.d0, item.hits)}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>

              {terminal && report && (
                <div className="space-y-3" data-fork-analysis-result>
                  {/* 结论卡由 AnalysisSummaryBody 内部渲染，这里不要再放一份（会重复） */}
                  <AnalysisSummaryBody report={report} compact />
                  <AnalysisStockTable runId={run.run_id} compact />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-3 text-[12px]"
                      onClick={() => window.open(`/analysis/report/${run.run_id}`, '_blank', 'noopener')}
                      data-fork-analysis-open-report
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {T.fullReport}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-3 text-[12px]"
                      disabled={!run.excel_ready}
                      onClick={() => void handleDownload()}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {run.excel_ready ? T.excel : T.excelPending}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-3 text-[12px]" onClick={reset}>
                      {T.newTask}
                    </Button>
                  </div>
                </div>
              )}

              {terminal && !report && (
                <p className="text-[11px] text-muted-foreground">{T.excelPending}</p>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
