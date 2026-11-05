/**
 * 历史任务 tab（用户 2026-11-02 第 2 / 3 / 4 条）。
 *
 * 取代原来的「简版历史记录 + 查看全部弹窗」两层结构：这里**直接列出全部历史任务**，
 * 分析与条件推理混排，新的在上。每行显示类型、条件、区间、两个评分、状态、命中、时间。
 *
 * 为什么单独一个文件而不是塞回弹窗
 * ------------------------------
 * 弹窗里已经有一整套「创建 → 进行中 → 结果」的状态机，再把列表状态（加载、删除、
 * 二次确认）混进去会变成一个 1300 行的组件。分出这个 tab 之后，弹窗只管创建，
 * 列表只管列表，两边都能单独测。
 *
 * 点行的分发**必须看 kind**：推理任务走推理面板（它有进度/结果接口），
 * 分析任务走任务详情。2026-11-02 的「r11020315 点开说任务不存在」就是这里漏了判断、
 * 把推理任务 id 丢给分析详情接口。
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { toLocalDateTimeInput } from '@panwatch/base-ui/datetime'
import { deleteAnalysisRun, listAnalysisHistory, type AnalysisRunMeta } from '@/lib/analysis-api'
import { deleteInferRun } from '@/lib/infer-api'

export const ANALYSIS_HISTORY_TAB_TEXTS_ZH = {
  title: '历史任务',
  hint: '分析与条件推理混在一起，新的在上。点一行看详情。',
  refresh: '刷新',
  empty: '还没有跑过任务。',
  loading: '正在读取历史任务…',
  loadFailed: (message: string) => `读取失败：${message}`,
  count: (n: number) => `共 ${n} 条`,
  columns: {
    kind: '类型',
    preset: '条件',
    range: '区间',
    train: '推理分',
    test: '测试分',
    score: '评分',
    scope: '有效范围',
    status: '状态',
    hits: '命中',
    created: '创建时间',
    actions: '',
  },
  kindAnalysis: '分析',
  kindInfer: '条件推理',
  row: (start: string, end: string) => `${start} ~ ${end}`,
  validateSuffix: (days: number) => ` · 验证 ${days} 日`,
  iterations: (done: number, total: number) => ` · ${done}/${total} 次`,
  status: {
    pending: '排队中',
    running: '进行中',
    interrupted: '已中断',
    done: '已完成',
    stopped: '已停止',
    failed: '失败',
  } as Record<string, string>,
  deleteTitle: '删除任务',
  deleteConfirm: (preset: string, created: string) =>
    `删除「${preset}」在 ${created} 的这次任务？明细、Excel 一起删掉，不可恢复。`,
  delete: '删除',
  cancel: '取消',
  deleteFailed: (message: string) => `删除失败：${message}`,
  pruned: '明细已清理',
}

function formatCreatedAt(instant?: string | null): string {
  if (!instant) return '—'
  return toLocalDateTimeInput(instant).slice(0, 16).replace('T', ' ')
}

function scoreText(value?: number | null): string {
  return value === null || value === undefined ? '—' : value.toFixed(1)
}

function rangeText(run: AnalysisRunMeta): string {
  if (run.kind === 'infer') {
    return `${run.train_start ?? ''} ~ ${run.valid_end ?? ''}`
  }
  return ANALYSIS_HISTORY_TAB_TEXTS_ZH.row(run.start_date, run.end_date)
}

/**
 * 历史任务 → 在新窗口打开任务详情（用户 2026-11-05）。
 *
 * kind 直接由列表给出，拼进 URL：推理任务去 /analysis/task/infer/<id>，
 * 分析任务去 /analysis/task/analysis/<id>。以前是在弹窗里内嵌一层详情对话框，
 * 现在改成独立窗口（无导航、无返回）。
 */
export function openTaskDetailWindow(run: Pick<AnalysisRunMeta, 'run_id' | 'kind'>): void {
  const kind = run.kind === 'infer' ? 'infer' : 'analysis'
  window.open(`/analysis/task/${kind}/${run.run_id}`, '_blank', 'noopener')
}

export function AnalysisHistoryTab({
  reloadKey = 0,
}: {
  reloadKey?: number
}) {
  const T = ANALYSIS_HISTORY_TAB_TEXTS_ZH
  const [runs, setRuns] = useState<AnalysisRunMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<AnalysisRunMeta | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // 500 是后端上限；历史记录现在永久保留，一屏装不下时靠滚动看
      setRuns(await listAnalysisHistory(500))
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const handleDelete = async () => {
    if (!pending || deleting) return
    setDeleting(true)
    try {
      if (pending.kind === 'infer') {
        await deleteInferRun(pending.run_id)
      } else {
        await deleteAnalysisRun(pending.run_id)
      }
      setRuns(current => current.filter(item => item.run_id !== pending.run_id))
      setError(null)
    } catch (exc) {
      setError(T.deleteFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setDeleting(false)
      setPending(null)
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-2" data-fork-analysis-history-tab>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <p className="text-[12px] font-medium">{T.title}</p>
          <span className="text-[10px] text-muted-foreground">{T.count(runs.length)}</span>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => void load()}
          data-fork-history-refresh
        >
          <RefreshCw className="h-3 w-3" />
          {T.refresh}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">{T.hint}</p>

      {error && (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>
      )}

      {runs.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{loading ? T.loading : T.empty}</p>
      ) : (
        <div className="min-h-0 max-h-[calc(85vh-13rem)] overflow-y-auto scrollbar" data-fork-history-body>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b border-border/60 text-muted-foreground">
                <th className="px-2 py-1 text-left font-medium">{T.columns.kind}</th>
                <th className="px-2 py-1 text-left font-medium">{T.columns.preset}</th>
                <th className="px-2 py-1 text-left font-medium">{T.columns.range}</th>
                <th className="px-2 py-1 text-right font-medium">{T.columns.score}</th>
                <th className="px-2 py-1 text-left font-medium">{T.columns.scope}</th>
                <th className="px-2 py-1 text-left font-medium">{T.columns.status}</th>
                <th className="px-2 py-1 text-right font-medium">{T.columns.hits}</th>
                <th className="px-2 py-1 text-left font-medium">{T.columns.created}</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr
                  key={run.run_id}
                  className="cursor-pointer border-b border-border/30 hover:bg-accent/20"
                  onClick={() => openTaskDetailWindow(run)}
                  data-fork-history-row={run.kind ?? 'analysis'}
                >
                  <td className="px-2 py-1 text-muted-foreground">
                    {run.kind === 'infer' ? T.kindInfer : T.kindAnalysis}
                  </td>
                  <td className="px-2 py-1">
                    <span className="truncate">{run.preset}</span>
                    {run.kind === 'infer' && run.iterations ? (
                      <span className="text-muted-foreground">
                        {T.iterations(run.done_iterations ?? 0, run.iterations)}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {rangeText(run)}
                    {run.validate_days ? T.validateSuffix(run.validate_days) : ''}
                  </td>
                  {/* 分析任务只有一段 → 一个分；条件推理仍有两段 → 显示「搜索 / 验算」 */}
                  <td className="px-2 py-1 text-right tabular-nums" data-fork-history-score>
                    {run.kind === 'infer' && run.score_test != null
                      ? `${scoreText(run.score_train)} / ${scoreText(run.score_test)}`
                      : scoreText(run.score_train)}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap text-[10px] text-muted-foreground"
                      data-fork-history-scope={run.scope_label ?? '—'}>
                    {run.scope_label ?? '—'}
                    {run.stock_best_score != null && run.stock_best_score >= 80 ? (
                      <span className="ml-1 text-emerald-600">{`个股 ${Math.round(run.stock_best_score)}`}</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1">
                    <span className={run.status === 'failed' ? 'text-destructive' : ''}>
                      {T.status[run.status] ?? run.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{run.hits}</td>
                  <td className="px-2 py-1 text-muted-foreground">{formatCreatedAt(run.created_at)}</td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      aria-label={T.delete}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={event => {
                        event.stopPropagation()
                        setPending(run)
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={pending !== null} onOpenChange={next => !next && setPending(null)}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{T.deleteTitle}</DialogTitle>
            <DialogDescription>
              {pending ? T.deleteConfirm(pending.preset, formatCreatedAt(pending.created_at)) : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              {T.cancel}
            </Button>
            <Button size="sm" variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
              {T.delete}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
