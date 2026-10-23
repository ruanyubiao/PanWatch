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
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import { toLocalDateTimeInput } from '@panwatch/base-ui/datetime'
import { SCREEN_MARKETS, type ScreenMarket } from '@/lib/screen-rule'
import type { ScreenPreset } from '@/lib/screen-presets'
import {
  ANALYSIS_POLL_MS,
  createAnalysis,
  downloadAnalysisExcel,
  formatDuration,
  getAnalysisMethods,
  getAnalysisReport,
  getAnalysisResult,
  getAnalysisRun,
  listAnalysisRuns,
  previewAnalysis,
  resumeAnalysisRun,
  stopAnalysisRun,
  type AnalysisMethodSpec,
  type AnalysisPreview,
  type AnalysisReport,
  type AnalysisRunMeta,
  type AnalysisResultEnvelope,
} from '@/lib/analysis-api'
import { AnalysisRunListDialog } from './analysis/AnalysisRunList'
import { AnalysisMethodResult } from './analysis/AnalysisMethodResult'
import { AnalysisStockTable } from './analysis/AnalysisStockTable'
import { AnalysisSummaryBody } from './analysis/AnalysisSummary'
import { AnalysisTaskDetailDialog } from './analysis/AnalysisTaskDetail'

export const ANALYSIS_DIALOG_TEXTS_ZH = {
  button: '数据分析',
  title: '数据分析',
  description: '用一个选股条件回测历史每一天，按选定的统计方法给出这个条件准不准。',
  createTitle: '创建数据分析任务',
  createHint: '选择条件、区间与股票范围，任务在后台跑，可以关掉页面。',
  preset: '选股条件',
  presetPlaceholder: '选择一个选股条件',
  presetEmpty: '还没有选股条件，先去「条件选股」保存一个',
  method: '统计方法',
  methodHint: (forwardDays: number) =>
    `该方法需要 ${forwardDays} 个交易日的前瞻行情，结束日会自动往前留出这段`,
  methodFixedDays: (days: number) => `该方法固定使用 ${days} 个交易日窗口`,
  methodShort: (id: string) => (id === 'stat_v2' ? '方法 2' : '方法 1'),
  methodFallback: '统计分析方法 1：持有期胜率与超额',
  start: '开始日期',
  end: '结束日期',
  endHint: (last: string) => `不能晚于 ${last}（再往后验证行情不够）`,
  validateDays: '验证天数',
  // 用户 2026-10-23：提示改成「向未来看几个交易日」，不再带 1–30（范围由控件自己限住）
  validateDaysHint: '向未来看几个交易日',
  validateDaysUnit: '个交易日',
  market: '股票范围',
  marketAll: '全部',
  marketSh: '上证',
  marketSz: '深证',
  marketCyb: '创业',
  marketKcb: '科创',
  includeSt: '包含 ST / *ST',
  estimate: (days: number, hours: string) => `区间内 ${days} 个交易日，预计约 ${hours}`,
  estimatePending: '正在估算交易日数…',
  sampleNote: '创建后会在后台逐日回放这个条件，可以关掉页面。',
  create: '创建任务',
  creating: '创建中…',
  running: '进行中',
  progressTitle: (done: number, total: number) => `已完成 ${done} / ${total} 个交易日`,
  progressHits: (hits: number) => `命中 ${hits} 条`,
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
  resultPending: '正在计算统计结果…',
  excel: '下载 Excel',
  excelPending: 'Excel 生成中',
  newTask: '新建任务',
  historyTitle: '历史任务',
  historyViewAll: '查看全部',
  historyEmpty: '这个条件还没有跑过',
  historyItem: (created: string, days: number, hits: number) => `${created} · ${days} 天 · ${hits} 条`,
  openTask: '打开任务详情',
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
  /** 统计分析方法 id */
  method: string
  startDate: string
  endDate: string
  /** 验证天数（向前看几个交易日），默认 30，最小 1 */
  validateDays: number
  marketAll: boolean
  markets: ScreenMarket[]
  includeSt: boolean
}

/** 验证天数上限：signals.db 只有 r1..r30 列（再多就要改表结构） */
const MAX_VALIDATE_DAYS = 30

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
  const [methods, setMethods] = useState<AnalysisMethodSpec[]>([])
  // ref 供 reset 读默认方法（避免 methods 进 reset 依赖导致表单被重置）
  const methodsRef = useRef<AnalysisMethodSpec[]>([])
  const [form, setForm] = useState<FormState>({
    preset: '',
    method: 'stat_v1',
    startDate: DEFAULT_START,
    endDate: '',
    validateDays: 30,
    marketAll: true,
    markets: [...SCREEN_MARKETS],
    includeSt: false,
  })
  // 用户手选过结束日就不再自动跟随验证天数（否则改天数会把他选的日期盖掉）
  const endTouchedRef = useRef(false)
  const [preview, setPreview] = useState<AnalysisPreview | null>(null)
  // 验证天数的输入框文本单独存：数字输入框清空时若立刻夹回 1，用户打字会变成「1x」
  const [daysText, setDaysText] = useState('30')
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [runs, setRuns] = useState<AnalysisRunMeta[]>([])
  const [run, setRun] = useState<AnalysisRunMeta | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  // 方法 2（以及以后的新方法）走统一信封
  const [standard, setStandard] = useState<AnalysisResultEnvelope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [stopping, setStopping] = useState(false)
  // 历史任务点开的是「任务详情」窗口；「查看全部」是完整列表
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setMode('create')
    setRun(null)
    setReport(null)
    setStandard(null)
    setError(null)
    setPreview(null)
    setPreviewError(null)
    setStopping(false)
    setDaysText('30')
    endTouchedRef.current = false
    setForm({
      preset: presets[0]?.name ?? '',
      // 方法列表是异步来的；用 ref 读默认方法，避免把它写进 reset 的依赖
      // （否则列表一回来 reset 就重跑，把用户刚填的表单清掉）
      method: methodsRef.current[0]?.id ?? 'stat_v1',
      startDate: DEFAULT_START,
      // 预估回来之前先给条件选股的日期，回来后由 max_end_date 覆盖（用户没手选时）
      endDate: asof ?? '',
      validateDays: 30,
      marketAll: true,
      markets: [...SCREEN_MARKETS],
      includeSt: false,
    })
  }, [asof, presets])

  // 打开时：拉方法列表 + 有任务在跑就直接进「进行中」，否则停在「未开始」
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
    void getAnalysisMethods()
      .then(items => {
        if (cancelled) return
        methodsRef.current = items
        setMethods(items)
        // 列表回来时表单还是初始方法（用户没改过）→ 用后端标记的默认方法
        setForm(current => ({
          ...current,
          method: current.method || items[0]?.id || 'stat_v1',
        }))
      })
      .catch(() => undefined)
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
            method: form.method,
            start_date: form.startDate,
            end_date: form.endDate || null,
            validate_days: form.validateDays,
            markets: form.marketAll ? [...SCREEN_MARKETS] : form.markets,
            include_st: form.includeSt,
          })
          if (!cancelled) {
            setPreview(data)
            setPreviewError(null)
            // 结束日默认 = 最后一个「验证得完」的交易日；用户手选过就不动
            if (!endTouchedRef.current && data.max_end_date) {
              setForm(current => ({ ...current, endDate: data.max_end_date }))
            }
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
  }, [form.endDate, form.includeSt, form.marketAll, form.markets, form.method, form.preset,
      form.startDate, form.validateDays, mode, open])

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

  const loadStandard = useCallback(
    async (runId: string) => {
      try {
        setStandard(await getAnalysisResult(runId))
        setError(null)
      } catch (exc) {
        setStandard(null)
        setError(exc instanceof Error ? exc.message : String(exc))
      }
    },
    [],
  )

  const terminal = run ? ['done', 'stopped'].includes(run.status) : false
  const runMethod = run?.method ?? 'stat_v1'

  useEffect(() => {
    if (mode !== 'run' || !run) return
    if (!['done', 'stopped'].includes(run.status)) return
    if (runMethod !== 'stat_v1') {
      if (standard && standard.run.run_id === run.run_id) return
      void loadStandard(run.run_id)
      return
    }
    if (report && report.run.run_id === run.run_id) return
    void loadReport(run.run_id)
  }, [loadReport, loadStandard, mode, report, run, runMethod, standard])

  const handleCreate = async () => {
    if (!form.preset || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const created = await createAnalysis({
        preset: form.preset,
        method: form.method,
        start_date: form.startDate,
        end_date: form.endDate || null,
        validate_days: form.validateDays,
        markets: form.marketAll ? [...SCREEN_MARKETS] : form.markets,
        include_st: form.includeSt,
      })
      setRun(created)
      setReport(null)
      setStandard(null)
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
      setStandard(null)
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
    () => runs.filter(item => !form.preset || item.preset === form.preset).slice(0, 10),
    [form.preset, runs],
  )

  const selectedMethod = useMemo(
    () => methods.find(item => item.id === form.method) ?? null,
    [form.method, methods],
  )
  // 方法是否自己声明了「验证天数」参数（方法 1 有；方法 2 的窗口是固定的）
  const daysEditable = !selectedMethod || selectedMethod.params.some(item => item.key === 'validate_days')
  // 固定窗口取方法最长窗口（方法 2 = 35），没有 windows 就退回 forward_days
  const fixedWindow = selectedMethod
    ? (selectedMethod.windows[selectedMethod.windows.length - 1] ?? selectedMethod.forward_days)
    : 35
  // 固定模式只是「同一行里的输入框不可编辑」——两种模式共用一套控件与尺寸，
  // 切换方法时行高/列位置不变（用户 2026-10-23：原来换成一行纯文本，UI 会跳动）
  const inputClass = 'h-7 w-[80px] rounded-md border border-input bg-background px-2 text-[12px]'

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
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.preset}</span>
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

                  {/* 统计方法（用户第 5 条：放在「选股条件」下面） */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.method}</span>
                    <Select
                      value={form.method}
                      onValueChange={value =>
                        setForm(current => ({ ...current, method: value }))
                      }
                    >
                      <SelectTrigger className="h-7 w-[280px] text-[12px]" data-fork-analysis-method>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(methods.length > 0
                          ? methods
                          : [{ id: 'stat_v1', name: T.methodFallback }]
                        ).map(item => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {selectedMethod && (
                      <span className="text-[10px] text-muted-foreground">
                        {T.methodHint(selectedMethod.forward_days)}
                      </span>
                    )}
                  </div>

                  {/* 三行竖排（用户第 2 条）：开始日期 / 结束日期 / 验证天数 */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.start}</span>
                    <input
                      type="date"
                      value={form.startDate}
                      aria-label={T.start}
                      data-fork-analysis-start
                      onChange={event => setForm(current => ({ ...current, startDate: event.target.value }))}
                      className="h-7 rounded-md border border-input bg-background px-2 text-[12px]"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.end}</span>
                    <input
                      type="date"
                      value={form.endDate}
                      aria-label={T.end}
                      data-fork-analysis-end
                      max={preview?.max_end_date ?? undefined}
                      onChange={event => {
                        const value = event.target.value
                        const cap = preview?.max_end_date
                        endTouchedRef.current = true
                        // 用户手选也不能晚于可验证的最后一天（第 2 条）
                        setForm(current => ({
                          ...current,
                          endDate: cap && value > cap ? cap : value,
                        }))
                      }}
                      className="h-7 rounded-md border border-input bg-background px-2 text-[12px]"
                    />
                    <span className="text-[10px] text-muted-foreground">
                      {preview ? T.endHint(preview.max_end_date) : ''}
                    </span>
                  </div>

                  {/* 验证天数：两种统计方法共用这一行同一套控件（方法 2 = 同一个输入框但不可编辑） */}
                  <div
                    className="flex flex-wrap items-center gap-2"
                    data-fork-analysis-validate-row={daysEditable ? 'edit' : 'fixed'}
                  >
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.validateDays}</span>
                    {daysEditable ? (
                      <input
                        type="number"
                        min={1}
                        max={MAX_VALIDATE_DAYS}
                        step={1}
                        value={daysText}
                        aria-label={T.validateDays}
                        data-fork-analysis-validate-days
                        onChange={event => {
                          const raw = event.target.value
                          setDaysText(raw)
                          const parsed = Math.trunc(Number(raw))
                          if (!Number.isFinite(parsed) || raw === '') return
                          const next = Math.min(MAX_VALIDATE_DAYS, Math.max(1, parsed))
                          endTouchedRef.current = false  // 改天数 → 结束日跟着上限走
                          setForm(current => ({ ...current, validateDays: next }))
                        }}
                        onBlur={() => {
                          const parsed = Math.trunc(Number(daysText))
                          const next = Number.isFinite(parsed) && daysText !== ''
                            ? Math.min(MAX_VALIDATE_DAYS, Math.max(1, parsed))
                            : 30
                          setDaysText(String(next))
                          setForm(current => ({ ...current, validateDays: next }))
                        }}
                        className={inputClass}
                      />
                    ) : (
                      <input
                        type="number"
                        value={fixedWindow}
                        readOnly
                        disabled
                        aria-label={T.validateDays}
                        data-fork-analysis-validate-days
                        data-fork-analysis-fixed-window
                        className={`${inputClass} cursor-not-allowed opacity-70`}
                      />
                    )}
                    <span className="text-[10px] text-muted-foreground" data-fork-analysis-validate-hint>
                      {daysEditable ? T.validateDaysHint : T.methodFixedDays(fixedWindow)}
                    </span>
                  </div>

                  {/* 市场：与条件选股界面完全同一套样式（带 ✓ 的 pill 组 + ST 开关） */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.market}</span>
                    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={T.market}>
                      <button
                        type="button"
                        aria-pressed={form.marketAll ? true : form.markets.length === 0 ? false : 'mixed'}
                        aria-label={T.marketAll}
                        data-fork-analysis-market-all
                        onClick={() =>
                          setForm(current => ({ ...current, marketAll: true, markets: [...SCREEN_MARKETS] }))
                        }
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                          form.marketAll
                            ? 'border-primary/60 bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground hover:text-foreground'
                        }`}
                      >
                        <span
                          className="flex h-2.5 w-2.5 items-center justify-center rounded-[2px] border border-current/60 text-[8px] leading-none"
                          aria-hidden
                        >
                          {form.marketAll ? '✓' : form.markets.length === 0 ? '' : '–'}
                        </span>
                        {T.marketAll}
                      </button>
                      {/* 「全部」选中时其余四个显示为未选中（radio 组语义，与条件选股一致） */}
                      {SCREEN_MARKETS.map(key => {
                        const selected = !form.marketAll && form.markets.includes(key)
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={selected}
                            aria-label={MARKET_LABELS[key]}
                            data-fork-analysis-market={key}
                            onClick={() => toggleMarket(key)}
                            className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                              selected
                                ? 'border-primary/60 bg-primary/10 text-primary'
                                : 'border-border text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <span
                              className="flex h-2.5 w-2.5 items-center justify-center rounded-[2px] border border-current/60 text-[8px] leading-none"
                              aria-hidden
                            >
                              {selected ? '✓' : ''}
                            </span>
                            {MARKET_LABELS[key]}
                          </button>
                        )
                      })}
                    </div>
                    {/* 含 ST：与条件选股同一个 Switch 组件，跟在市场按钮后面 */}
                    <div className="ml-3 flex items-center gap-1.5">
                      <Switch
                        checked={form.includeSt}
                        aria-label={T.includeSt}
                        data-fork-analysis-include-st
                        onCheckedChange={checked =>
                          setForm(current => ({ ...current, includeSt: checked }))
                        }
                      />
                      <span className="text-[11px] text-muted-foreground">{T.includeSt}</span>
                    </div>
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

              {/* 历史任务：标题加粗放大到和「创建数据分析任务」同级，和创建按钮留出间距 */}
              <section className="mt-4">
                <div className="mb-1.5 flex items-center gap-2">
                  <p className="text-[12px] font-medium">{T.historyTitle}</p>
                  <button
                    type="button"
                    className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => setListOpen(true)}
                    data-fork-analysis-view-all
                  >
                    {T.historyViewAll}
                  </button>
                </div>
                {presetRuns.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">{T.historyEmpty}</p>
                ) : (
                  <ul className="space-y-0.5">
                    {presetRuns.map(item => (
                      <li key={item.run_id}>
                        <button
                          type="button"
                          className="flex w-full items-center justify-between rounded border border-transparent px-1.5 py-1 text-[11px] hover:border-border/60 hover:bg-accent/20"
                          aria-label={T.openTask}
                          onClick={() => {
                            // 历史任务 → 任务详情窗口（用户第 5 条），不再进数据分析界面
                            setDetailRunId(item.run_id)
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
                    {run.method ? ` · ${T.methodShort(run.method)}` : ''}
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
                      {T.progressHits(progress?.hits ?? run.hits)}
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

              {terminal && runMethod === 'stat_v1' && report && (
                <div className="space-y-3" data-fork-analysis-result>
                  {/* 结论卡由 AnalysisSummaryBody 内部渲染，这里不要再放一份（会重复） */}
                  <AnalysisSummaryBody report={report} compact />
                  <AnalysisStockTable runId={run.run_id} compact horizons={report.horizons} />
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
                      onClick={() => void handleDownload()}
                      data-fork-analysis-excel
                    >
                      <Download className="h-3.5 w-3.5" />
                      {T.excel}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-3 text-[12px]" onClick={reset}>
                      {T.newTask}
                    </Button>
                  </div>
                </div>
              )}

              {terminal && runMethod !== 'stat_v1' && standard && (
                <div className="space-y-3" data-fork-analysis-result>
                  <AnalysisMethodResult runId={run.run_id} report={standard.result} compact />
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
                    <Button size="sm" variant="ghost" className="h-7 px-3 text-[12px]" onClick={reset}>
                      {T.newTask}
                    </Button>
                  </div>
                </div>
              )}

              {terminal && (
                (runMethod === 'stat_v1' && !report) || (runMethod !== 'stat_v1' && !standard)
              ) && (
                <p className="text-[11px] text-muted-foreground">{T.resultPending}</p>
              )}
            </div>
          )}
        </div>
      </DialogContent>

      <AnalysisTaskDetailDialog
        runId={detailRunId}
        open={detailRunId !== null}
        onOpenChange={next => !next && setDetailRunId(null)}
      />
      <AnalysisRunListDialog
        open={listOpen}
        onOpenChange={setListOpen}
        onOpenRun={item => {
          setListOpen(false)
          setDetailRunId(item.run_id)
        }}
      />
    </Dialog>
  )
}
