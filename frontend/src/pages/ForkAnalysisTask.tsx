/**
 * 任务详情独立页（历史任务里点一行，在新窗口打开）。
 *
 * 用户 2026-11-05：历史任务点击查看详情时，详情在新窗口弹出；新窗口没有导航栏、
 * 没有返回按钮。所以这里沿用「完整报告」那套无导航布局（App.tsx 里 bareReport），
 * 页面本身不渲染返回/关闭按钮。
 *
 * 一个路由吃两类任务：/analysis/task/:kind/:runId，kind = analysis | infer。
 * kind 由历史列表直接给出，不去猜 —— 猜的代价是推理任务会去问分析详情接口，
 * 报「分析任务 xxx 不存在」。
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  getInferResults,
  getInferRun,
  saveInferVariant,
  type InferFinalist,
  type InferRunMeta,
} from '@/lib/infer-api'
import { AnalysisTaskDetailView } from '@/components/fork/analysis/AnalysisTaskDetail'
import { AnalysisInferPanel } from '@/components/fork/analysis/AnalysisInferPanel'

export const ANALYSIS_TASK_PAGE_TEXTS_ZH = {
  loading: '正在读取任务…',
  loadFailed: (message: string) => `读取任务失败：${message}`,
  notFound: '任务不存在，可能已被清理。',
  inferTitle: '条件推理详情',
  analysisTitle: '分析任务详情',
}

const T = ANALYSIS_TASK_PAGE_TEXTS_ZH

export default function ForkAnalysisTaskPage() {
  const { kind = 'analysis', runId = '' } = useParams()
  const isInfer = kind === 'infer'
  const [inferRun, setInferRun] = useState<InferRunMeta | null>(null)
  const [finalists, setFinalists] = useState<InferFinalist[]>([])
  const [saved, setSaved] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(isInfer)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const run = await getInferRun(id)
      setInferRun(run)
      if (!['pending', 'running', 'paused'].includes(run.status)) {
        try {
          const data = await getInferResults(id)
          setFinalists(data.finalists ?? [])
        } catch {
          setFinalists([])
        }
      }
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isInfer || !runId) return
    void load(runId)
  }, [isInfer, load, runId])

  const handleSave = async (item: InferFinalist) => {
    if (!inferRun || saved[item.rank]) return
    setBusy(true)
    try {
      const result = await saveInferVariant(inferRun.run_id, item.rank)
      setSaved(current => ({ ...current, [item.rank]: result.name }))
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6" data-fork-analysis-task-page={kind}>
        <header className="mb-3">
          <h1 className="text-[16px] font-semibold">{isInfer ? T.inferTitle : T.analysisTitle}</h1>
          <p className="text-[11px] text-muted-foreground">{runId}</p>
        </header>

        {error && (
          <p className="mb-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>
        )}

        {isInfer ? (
          loading ? (
            <p className="text-[11px] text-muted-foreground">{T.loading}</p>
          ) : inferRun ? (
            <AnalysisInferPanel
              run={inferRun}
              finalists={finalists}
              savedIndex={saved}
              busy={busy}
              onSave={item => void handleSave(item)}
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">{T.notFound}</p>
          )
        ) : (
          <AnalysisTaskDetailView runId={runId} />
        )}
      </div>
    </div>
  )
}
