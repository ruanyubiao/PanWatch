/**
 * 全部历史任务列表（用户 2026-10-22 第 4 条：数据分析界面只放近期几条，
 * 边上那颗小字按钮点开这里看完整列表）。
 *
 * 一行一个任务：条件名、区间、验证天数、状态、命中数、创建时间。
 * 点击 = 打开任务详情；右侧垃圾桶 = 删除（带二次确认，删掉不可恢复）。
 */
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { toLocalDateTimeInput } from '@panwatch/base-ui/datetime'
import { deleteAnalysisRun, listAnalysisRuns, type AnalysisRunMeta } from '@/lib/analysis-api'

export const ANALYSIS_RUN_LIST_TEXTS_ZH = {
  title: '全部历史任务',
  description: '所有条件跑过的数据分析，新的在上。点一行看详情。',
  empty: '还没有跑过任何数据分析任务。',
  loading: '正在读取任务列表…',
  loadFailed: (message: string) => `读取失败：${message}`,
  columns: { preset: '条件', range: '区间', status: '状态', hits: '命中', created: '创建时间', actions: '' },
  row: (start: string, end: string) => `${start} ~ ${end}`,
  validateSuffix: (days: number) => ` · 验证 ${days} 日`,
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
  deleted: (preset: string) => `已删除「${preset}」的这次任务`,
  deleteFailed: (message: string) => `删除失败：${message}`,
  close: '关闭',
}

function formatCreatedAt(instant?: string | null): string {
  if (!instant) return '—'
  return toLocalDateTimeInput(instant).slice(0, 16).replace('T', ' ')
}

export function AnalysisRunListDialog({
  open,
  onOpenChange,
  onOpenRun,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenRun: (run: AnalysisRunMeta) => void
}) {
  const T = ANALYSIS_RUN_LIST_TEXTS_ZH
  const [runs, setRuns] = useState<AnalysisRunMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<AnalysisRunMeta | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRuns(await listAnalysisRuns())
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
  }, [load, open])

  const handleDelete = async () => {
    if (!pending) return
    try {
      await deleteAnalysisRun(pending.run_id)
      setRuns(current => current.filter(item => item.run_id !== pending.run_id))
      setError(null)
    } catch (exc) {
      setError(T.deleteFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setPending(null)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[820px]" data-fork-analysis-run-list>
          <DialogHeader>
            <DialogTitle>{T.title}</DialogTitle>
            <DialogDescription>{T.description}</DialogDescription>
          </DialogHeader>

          {error && (
            <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>
          )}
          {loading && <p className="text-[11px] text-muted-foreground">{T.loading}</p>}
          {!loading && runs.length === 0 && (
            <p className="text-[11px] text-muted-foreground">{T.empty}</p>
          )}

          {runs.length > 0 && (
            <div className="max-h-[60vh] overflow-y-auto scrollbar" data-fork-analysis-run-list-body>
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border/60 text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">{T.columns.preset}</th>
                    <th className="px-2 py-1 text-left font-medium">{T.columns.range}</th>
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
                      onClick={() => onOpenRun(run)}
                    >
                      <td className="px-2 py-1">{run.preset}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {T.row(run.start_date, run.end_date)}
                        {run.validate_days ? T.validateSuffix(run.validate_days) : ''}
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
        </DialogContent>
      </Dialog>

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
            <Button size="sm" variant="destructive" onClick={() => void handleDelete()}>
              {T.delete}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
