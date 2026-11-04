/**
 * 「数据分析」弹窗（两个 tab：创建任务 / 历史任务）。
 *
 * 创建任务 tab 里是「上下两块」而不是互斥的两个页面（用户 2026-11-04）：
 *   上面：最近一次任务的面板（进行中 → 进度与停止；已结束 → 结果）
 *   下面：新建任务表单，常驻展开，随时可以再起一个任务
 * 所以不再有「新建任务」按钮：表单一直都在，没有页面需要切回去。
 *
 * 历史任务 tab：分析 + 条件推理两类任务混排。
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@panwatch/base-ui/components/ui/tabs'
import { SCREEN_MARKETS, type ScreenMarket } from '@/lib/screen-rule'
import type { ScreenPreset } from '@/lib/screen-presets'
import {
  ANALYSIS_POLL_MS,
  createAnalysis,
  downloadAnalysisExcel,
  formatDuration,
  getAnalysisReport,
  getAnalysisResult,
  getAnalysisRun,
  listAnalysisHistory,
  listAnalysisRuns,
  previewAnalysis,
  resumeAnalysisRun,
  stopAnalysisRun,
  type AnalysisPreview,
  type AnalysisReport,
  type AnalysisRunMeta,
  type AnalysisResultEnvelope,
} from '@/lib/analysis-api'
import { AnalysisHistoryTab } from './analysis/AnalysisHistoryTab'
import { AnalysisMethodResult } from './analysis/AnalysisMethodResult'
import { AnalysisStockTable } from './analysis/AnalysisStockTable'
import { AnalysisSummaryBody } from './analysis/AnalysisSummary'
import { AnalysisTaskDetailDialog } from './analysis/AnalysisTaskDetail'
import { AnalysisInferPanel } from './analysis/AnalysisInferPanel'
import { AnalysisScoreCard } from './analysis/AnalysisScoreCard'
import {
  createInfer,
  getInferResults,
  getInferRun,
  listInferRuns,
  pauseInfer,
  resumeInfer,
  saveInferVariant,
  stopInfer,
  type InferFinalist,
  type InferRunMeta,
} from '@/lib/infer-api'

export const ANALYSIS_DIALOG_TEXTS_ZH = {
  button: '数据分析',
  title: '数据分析',
  description: '用一个选股条件回测历史，给出一个评分（60 分 = 能和随机买入拉开差距、可以拿去用）。',
  createTitle: '创建数据分析任务',
  createHint: '选条件、区间和验证天数就能跑；市场由条件自己决定，任务在后台跑，可以关掉页面。',
  preset: '选股条件',
  presetPlaceholder: '选择一个选股条件',
  presetEmpty: '还没有选股条件，先去「条件选股」保存一个',
  method: '统计方法',
  methodHint: (forwardDays: number) =>
    `该方法需要 ${forwardDays} 个交易日的前瞻行情，结束日会自动往前留出这段`,
  methodFixedDays: (days: number) => `该方法固定使用 ${days} 个交易日窗口`,
  methodShort: (id: string) => {
    const matched = /^stat_v(\d+)$/.exec(id)
    return matched ? `方法 ${matched[1]}` : '方法 1'
  },
  methodFallback: '统计分析方法 1：持有期胜率与超额',
  start: '分析开始时间',
  end: '分析结束时间',
  // 用户 2026-11-04 第 1 条：不要测试段了（也就没有测试分），只留一段
  testStart: '测试开始时间',
  testEnd: '测试结束时间',
  // 结束日按「显示口径」收：可以填到最新交易日，实际只分析到「减去验证天数」的那一天
  endHint: (effective: string, days: number) => `实际分析到 ${effective}（留 ${days} 个交易日做验证）`,
  testEndHint: (effective: string, days: number) => `实际验证到 ${effective}（留 ${days} 个交易日）`,
  testOptionalHint: '测试段用于验证，不参与任何挑选',
  inferSplit: (trainEnd: string, validStart: string) =>
    `条件推理会自动切两段：搜索段 ~${trainEnd}，验算段 ${validStart}~（按交易日 7:3，验算段搜索不看）`,
  inferSplitPending: '还在估算区间，稍等一下再创建（条件推理需要被后端的切分点）',
  validateDays: '验证天数',
  // 用户 2026-10-23：提示改成「向未来看几个交易日」，不再带 1–30（范围由控件自己限住）
  validateDaysHint: '向未来看几个交易日，结束时间会自动往前留出这段',
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
  tabCreate: '创建任务',
  tabHistory: '历史任务',
  historyTitle: '历史记录',
  kindAnalysis: '分析',
  kindInfer: '条件推理',
  scoreShort: (train: number | null, test: number | null) =>
    `评分 ${train ?? '—'}${test != null ? ` / ${test}` : ''}`,
  inferTitle: '条件推理',
  inferEnable: '启用',
  inferIterations: '推演次数',
  inferIterationsUnit: '次',
  inferHint: '在基础条件上反复微调，每次调整都跑一轮完整评估；启用后任务会先搜索再验算',
  historyViewAll: '查看全部',
  historyEmpty: '这个条件还没有跑过',
  historyItem: (created: string, days: number, hits: number) => `${created} · ${days} 天 · ${hits} 条`,
  openTask: '打开任务详情',
  openFailed: (message: string) => `打开任务失败：${message}`,
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

const DEFAULT_START = '2024-01-01'
const DEFAULT_TRAIN_END = '2025-12-31'
const DEFAULT_ITERATIONS = 100

type Mode = 'create' | 'run' | 'infer'

interface FormState {
  preset: string
  /** 统计分析方法 id（只剩 stat_v3，保留字段是为了兼容后端） */
  method: string
  /** 分析段（用户 2026-11-04 第 1 条：不再有测试段，只有这一段） */
  startDate: string
  endDate: string
  /** 验证天数（向前看几个交易日），默认 30，最小 1 */
  validateDays: number
  /** 条件推理：在基础条件上反复微调（用户 2026-10-24 第 5 条） */
  inferEnabled: boolean
  inferIterations: number
}

/** 验证天数上限：signals.db 只有 r1..r30 列（再多就要改表结构） */
const MAX_VALIDATE_DAYS = 30

const MARKET_LABELS: Record<ScreenMarket, string> = {
  sh: ANALYSIS_DIALOG_TEXTS_ZH.marketSh,
  sz: ANALYSIS_DIALOG_TEXTS_ZH.marketSz,
  cyb: ANALYSIS_DIALOG_TEXTS_ZH.marketCyb,
  kcb: ANALYSIS_DIALOG_TEXTS_ZH.marketKcb,
}

/** 从统一信封里取两个评分（后端 data_quality.scores） */
function scoresOf(envelope: AnalysisResultEnvelope): {
  train: number | null
  test: number | null
  trainGrade: string | null
  verdict: { verdict?: string; text?: string; score?: number | null } | null
} {
  const scores = (envelope.result?.data_quality as { scores?: Record<string, { score?: number | null; grade?: string }> } | undefined)?.scores
  const verdict = (envelope.result?.data_quality as { score_verdict?: { verdict?: string; text?: string; score?: number | null } } | undefined)?.score_verdict
  return {
    train: scores?.train?.score ?? null,
    test: scores?.test?.score ?? null,
    trainGrade: scores?.train?.grade ?? null,
    verdict: verdict ?? null,
  }
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
    method: 'stat_v3',
    startDate: DEFAULT_START,
    endDate: '',
    validateDays: 30,
    inferEnabled: false,
    inferIterations: DEFAULT_ITERATIONS,
  })
  // 用户手选过结束日就不再自动跟随验证天数（否则改天数会把他选的日期盖掉）
  const endTouchedRef = useRef(false)
  const [preview, setPreview] = useState<AnalysisPreview | null>(null)
  // 验证天数的输入框文本单独存：数字输入框清空时若立刻夹回 1，用户打字会变成「1x」
  const [daysText, setDaysText] = useState('30')
  // 推演次数的输入框文本（和验证天数一样：清空时不要立刻夹回 1，否则打字会变成 1xxx）
  const [iterText, setIterText] = useState(String(DEFAULT_ITERATIONS))
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [run, setRun] = useState<AnalysisRunMeta | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  // 方法 2（以及以后的新方法）走统一信封
  const [standard, setStandard] = useState<AnalysisResultEnvelope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [stopping, setStopping] = useState(false)
  // 历史任务点开的是「任务详情」窗口；「查看全部」是完整列表
  const [detailRunId, setDetailRunId] = useState<string | null>(null)
  // 两个 tab：创建任务 / 历史任务（用户 2026-11-02 第 4 条）
  const [tab, setTab] = useState<'create' | 'history'>('create')
  // 条件推理（从本弹窗创建，取代主界面原来的「条件推理」按钮）
  const [inferRun, setInferRun] = useState<InferRunMeta | null>(null)
  const [inferFinalists, setInferFinalists] = useState<InferFinalist[]>([])
  const [inferSaved, setInferSaved] = useState<Record<number, string>>({})
  const [inferBusy, setInferBusy] = useState(false)
  // 历史 tab 的刷新键：任务跑完 / 删除后让它重新拉一次
  const [historyReload, setHistoryReload] = useState(0)
  const timer = useRef<number | null>(null)

  const reset = useCallback(() => {
    setMode('create')
    setTab('create')
    setRun(null)
    setReport(null)
    setStandard(null)
    setError(null)
    setPreview(null)
    setPreviewError(null)
    setStopping(false)
    setDaysText('30')
    setIterText(String(DEFAULT_ITERATIONS))
    endTouchedRef.current = false
    setForm({
      preset: presets[0]?.name ?? '',
      // 方法列表是异步来的；用 ref 读默认方法，避免把它写进 reset 的依赖
      // （否则列表一回来 reset 就重跑，把用户刚填的表单清掉）
      method: 'stat_v3',
      startDate: DEFAULT_START,
      // 预估回来之前先给一个合理的默认，回来后由 max_end_date 覆盖（用户没手选时）
      endDate: asof ?? DEFAULT_TRAIN_END,
      validateDays: 30,
      inferEnabled: false,
      inferIterations: DEFAULT_ITERATIONS,
    })
  }, [asof, presets])

  // 打开时：拉方法列表 + 有任务在跑就直接进「进行中」，否则停在「未开始」
  useEffect(() => {
    if (!open) return
    reset()
    let cancelled = false
    void (async () => {
      try {
        // 分析任务 + 推理任务都要看：任一在跑就直接进它的进度页
        const [list, merged] = await Promise.all([
          listAnalysisRuns(),
          listAnalysisHistory(50).catch(() => [] as AnalysisRunMeta[]),
        ])
        if (cancelled) return
        const active = merged.find(item => item.status === 'running' || item.status === 'pending')
          ?? list.find(item => item.status === 'running' || item.status === 'pending')
        if (active) {
          // 推理任务没有「天」，days_done 是空的：直接进推理面板，
          // 否则界面会显示「已完成 undefined / N 个交易日」
          // （用户 2026-11-03 第 6 条报的就是这个）。
          if (active.kind === 'infer') {
            try {
              const next = await getInferRun(active.run_id)
              if (cancelled) return
              setInferRun(next)
              setMode('infer')
            } catch {
              if (!cancelled) {
                setRun(active)
                setMode('run')
              }
            }
          } else {
            setRun(active)
            setMode('run')
          }
        }
      } catch (exc) {
        if (!cancelled) setError(T.loadFailed(exc instanceof Error ? exc.message : String(exc)))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [T, open, reset])

  // 预估交易日数（条件 / 区间变了才问）。
  // 表单常驻在「创建任务」tab 里，所以判断条件从 mode 改成 tab：
  // 用 mode 的话，任务一进入进行中就再也拿不到新的预估了（用户 2026-11-04）。
  useEffect(() => {
    if (!open || tab !== 'create' || !form.preset || !form.startDate) {
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
          })
          if (!cancelled) {
            setPreview(data)
            setPreviewError(null)
            // 结束时间默认 = 最新交易日（显示口径）；用户手选过就不动
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
  }, [form.endDate, form.method, form.preset, form.startDate, form.validateDays, open, tab])

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
            setHistoryReload(current => current + 1)
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
      if (form.inferEnabled) {
        // 条件推理：搜索段 + 验算段由后端按交易日 7:3 给出（表单里不再有测试日期）。
        // 没拿到切分点就不提交：退回「整段搜索、整段验算」等于没有样本外校验。
        const split = preview?.infer_split ?? null
        if (!split) {
          setError(T.inferSplitPending)
          return
        }
        const created = await createInfer({
          preset: form.preset,
          method: 'stat_v3',
          train_start: form.startDate,
          train_end: split.train_end,
          valid_start: split.valid_start,
          valid_end: form.endDate || null,
          iterations: form.inferIterations,
        })
        setInferRun(created)
        setInferFinalists([])
        setInferSaved({})
        setMode('infer')
        return
      }
      const created = await createAnalysis({
        preset: form.preset,
        method: form.method,
        start_date: form.startDate,
        end_date: form.endDate || null,
        validate_days: form.validateDays,
      })
      setRun(created)
      setReport(null)
      setStandard(null)
      setMode('run')

    } catch (exc) {
      setError(T.createFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setSubmitting(false)
    }
  }

  // ---- 条件推理：轮询 + 终态拉结果
  // 不绑在 mode 上：面板切到上面的分析任务时，推理还在后台跑，进度也得继续更新
  useEffect(() => {
    if (!open || !inferRun) return
    const active = ['pending', 'running', 'paused'].includes(inferRun.status) && inferRun.alive !== false
    if (!active) return
    const handle = window.setInterval(() => {
      void (async () => {
        try {
          const next = await getInferRun(inferRun.run_id)
          setInferRun(next)
          if (!['pending', 'running', 'paused'].includes(next.status)) {
            void getInferResults(next.run_id)
              .then(data => setInferFinalists(data.finalists ?? []))
              .catch(() => undefined)
          }
        } catch {
          /* 轮询失败下一轮再试 */
        }
      })()
    }, 2500)
    return () => window.clearInterval(handle)
  }, [inferRun, mode, open])

  // 打开弹窗时如果最近有推理任务在跑，直接进推理界面
  useEffect(() => {
    if (!open || mode !== 'create') return
    if (inferRun) return
    void listInferRuns(1)
      .then(items => {
        const active = items[0]
        if (active && ['pending', 'running', 'paused'].includes(active.status) && active.alive !== false) {
          setInferRun(active)
          setMode('infer')
        }
      })
      .catch(() => undefined)
  }, [inferRun, mode, open])

  const handleInferControl = async (action: 'pause' | 'resume' | 'stop') => {
    if (!inferRun) return
    setInferBusy(true)
    try {
      const next = action === 'pause'
        ? await pauseInfer(inferRun.run_id)
        : action === 'resume'
          ? await resumeInfer(inferRun.run_id)
          : await stopInfer(inferRun.run_id)
      setInferRun(next)
      if (action === 'stop' || next.status === 'done') {
        const data = await getInferResults(inferRun.run_id).catch(() => null)
        if (data) setInferFinalists(data.finalists ?? [])
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setInferBusy(false)
    }
  }

  const handleSaveInfer = async (item: InferFinalist) => {
    if (!inferRun || inferSaved[item.rank]) return
    setInferBusy(true)
    try {
      const saved = await saveInferVariant(inferRun.run_id, item.rank)
      setInferSaved(current => ({ ...current, [item.rank]: saved.name }))
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setInferBusy(false)
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

  // 历史行 → 对应详情。**必须按 kind 分发**：推理任务有自己的接口，
  // 丢给分析详情会报「分析任务 xxx 不存在」（2026-11-02 第 3 条）。
  const openHistoryRun = useCallback(
    (item: AnalysisRunMeta) => {
      if (item.kind === 'infer') {
        void getInferRun(item.run_id)
          .then(next => {
            setInferRun(next)
            setMode('infer')
            setTab('create')
            if (!['pending', 'running', 'paused'].includes(next.status)) {
              void getInferResults(next.run_id)
                .then(data => setInferFinalists(data.finalists ?? []))
                .catch(() => undefined)
            }
          })
          .catch(exc => setError(T.openFailed(exc instanceof Error ? exc.message : String(exc))))
        return
      }
      setDetailRunId(item.run_id)
    },
    [T],
  )

  const progress = run?.progress
  const percent = useMemo(() => {
    if (!run) return 0
    const total = progress?.days_total ?? run.days_total ?? 0
    const done = progress?.days_done ?? run.days_done ?? 0
    if (!total) return 0
    return Math.min(100, Math.round((done / total) * 100))
  }, [progress, run])

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

        <Tabs value={tab} onValueChange={value => setTab(value === 'history' ? 'history' : 'create')}>
          <TabsList className="mb-1">
            <TabsTrigger value="create" data-fork-analysis-tab="create">{T.tabCreate}</TabsTrigger>
            <TabsTrigger value="history" data-fork-analysis-tab="history">{T.tabHistory}</TabsTrigger>
          </TabsList>

          <TabsContent value="create">
        {/* 视觉顺序 = 上面的任务面板 → 下面的新建表单（用户 2026-11-04）。
            表单在 DOM 里靠前，用 order 提到下面，避免搬动近 190 行 JSX 引入无谓风险。 */}
        <div className="flex max-h-[68vh] flex-col gap-3 overflow-y-auto scrollbar pr-1">
          {error && <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>}

          {/* 新建任务表单常驻展开：任务在跑也照样能再起一个（用户 2026-11-04） */}
          <div className="order-2 space-y-3" data-fork-analysis-create>
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

                  {/* 推理段（用户 2026-10-24：开始/结束改名为「推理开始/结束时间」） */}
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
                        setForm(current => ({
                          ...current,
                          endDate: cap && value > cap ? cap : value,
                        }))
                      }}
                      className="h-7 rounded-md border border-input bg-background px-2 text-[12px]"
                    />
                    <span className="text-[10px] text-muted-foreground" data-fork-analysis-end-hint>
                      {preview?.effective_end_date
                        ? T.endHint(preview.effective_end_date, preview.forward_days ?? 30)
                        : ''}
                    </span>
                  </div>

                  {/* 验证天数 */}
                  <div className="flex flex-wrap items-center gap-2" data-fork-analysis-validate-row="edit">
                    <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.validateDays}</span>
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
                    <span className="text-[10px] text-muted-foreground" data-fork-analysis-validate-hint>
                      {T.validateDaysHint}
                    </span>
                  </div>

                  {/* 条件推理（用户第 5 条）：股票范围下面一行，勾选后才可填次数 */}
                  <div className="mt-1 border-t border-border/40 pt-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.inferTitle}</span>
                      <label className="flex items-center gap-1.5 text-[11px]">
                        <input
                          type="checkbox"
                          checked={form.inferEnabled}
                          aria-label={T.inferEnable}
                          data-fork-analysis-infer-enabled
                          onChange={event =>
                            setForm(current => ({ ...current, inferEnabled: event.target.checked }))
                          }
                          className="h-3.5 w-3.5 accent-primary"
                        />
                        {T.inferEnable}
                      </label>
                      <span className="text-[10px] text-muted-foreground">{T.inferHint}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.inferIterations}</span>
                      <input
                        type="number"
                        min={1}
                        max={5000}
                        step={1}
                        value={iterText}
                        disabled={!form.inferEnabled}
                        aria-label={T.inferIterations}
                        data-fork-analysis-infer-iterations
                        onChange={event => {
                          const raw = event.target.value
                          setIterText(raw)
                          const parsed = Math.trunc(Number(raw))
                          if (!Number.isFinite(parsed) || raw === '') return
                          setForm(current => ({
                            ...current,
                            inferIterations: Math.min(5000, Math.max(1, parsed)),
                          }))
                        }}
                        onBlur={() => {
                          const parsed = Math.trunc(Number(iterText))
                          const next = Number.isFinite(parsed) && iterText !== ''
                            ? Math.min(5000, Math.max(1, parsed))
                            : DEFAULT_ITERATIONS
                          setIterText(String(next))
                          setForm(current => ({ ...current, inferIterations: next }))
                        }}
                        className={`${inputClass} ${form.inferEnabled ? '' : 'cursor-not-allowed opacity-60'}`}
                      />
                      <span className="text-[10px] text-muted-foreground">{T.inferIterationsUnit}</span>
                    </div>
                    {form.inferEnabled && preview?.infer_split && (
                      <p className="mt-1 text-[10px] text-muted-foreground" data-fork-analysis-infer-split>
                        {T.inferSplit(preview.infer_split.train_end, preview.infer_split.valid_start)}
                      </p>
                    )}
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
                  // 条件推理要先拿到后端给的 7:3 切分点（预览接口），否则会退回
                  // 「整段搜索、整段验算」——那等于没有样本外校验，分数必然虚高。
                  disabled={!form.preset || submitting || presets.length === 0
                    || (form.inferEnabled && !preview?.infer_split)}
                  onClick={() => void handleCreate()}
                  data-fork-analysis-create-button
                >
                  <Play className="h-3.5 w-3.5" />
                  {submitting ? T.creating : T.create}
                </Button>
              </div>
          </div>

          {mode === 'infer' && inferRun && (
            <div className="order-1 space-y-3" data-fork-analysis-infer>
              <AnalysisInferPanel
                run={inferRun}
                finalists={inferFinalists}
                savedIndex={inferSaved}
                busy={inferBusy}
                onPause={() => void handleInferControl('pause')}
                onResume={() => void handleInferControl('resume')}
                onStop={() => void handleInferControl('stop')}
                onSave={item => void handleSaveInfer(item)}
              />
            </div>
          )}

          {mode === 'run' && run && (
            <div className="order-1 space-y-3" data-fork-analysis-run={run.status}>
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
                      {T.progressTitle(
                        progress?.days_done ?? run.days_done ?? 0,
                        progress?.days_total ?? run.days_total ?? 0,
                      )}
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

                {run.status === 'stopped' && (
                  <p className="text-[11px]">{T.stoppedNote(run.days_done ?? 0)}</p>
                )}
                {run.status === 'done' && (
                  <p className="text-[11px]">{T.doneNote(run.days_done ?? 0, run.hits ?? 0)}</p>
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
                  </div>
                </div>
              )}

              {terminal && runMethod !== 'stat_v1' && standard && (
                <div className="space-y-3" data-fork-analysis-result>
                  <AnalysisScoreCard
                    train={scoresOf(standard).train}
                    test={scoresOf(standard).test}
                    trainGrade={scoresOf(standard).trainGrade}
                    verdict={run.score_verdict ?? scoresOf(standard).verdict}
                  />
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
          </TabsContent>

          <TabsContent value="history">
            <AnalysisHistoryTab onOpen={openHistoryRun} reloadKey={historyReload} />
          </TabsContent>
        </Tabs>
      </DialogContent>

      <AnalysisTaskDetailDialog
        runId={detailRunId}
        open={detailRunId !== null}
        onOpenChange={next => !next && setDetailRunId(null)}
      />
    </Dialog>
  )
}
