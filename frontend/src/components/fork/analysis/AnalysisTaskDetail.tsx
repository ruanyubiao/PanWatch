/**
 * 任务详情弹窗（历史任务点进来 / 已完成状态点进来）。
 *
 * 用户 2026-10-22 第 5 条：这个窗口不能再是「数据分析」那个三态界面，而要显示
 *   1. 这次任务用的**条件原文**（基础筛选 + 条件条数 + 保存时间）
 *   2. 这个条件的**评价**（能不能用、哪个周期最好、样本够不够）
 *   3. 符合条件的数据（命中条数 + 个股排行）
 *   4. 两个按钮：查看完整报告 / 下载 Excel —— 不放「新建任务」
 *
 * 跑着的任务照样能进来看（进度 + 停止在数据分析弹窗里），这里只给一句状态说明。
 */
import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { toLocalDateTimeInput } from '@panwatch/base-ui/datetime'
import { countConditions, summarizeBase, type ScreenRequest } from '@/lib/screen-rule'
import {
  downloadAnalysisExcel,
  formatDuration,
  getAnalysisDetail,
  getAnalysisReport,
  type AnalysisDetail,
  type AnalysisReport,
} from '@/lib/analysis-api'
import { AnalysisHorizonTable, AnalysisVerdictCard } from './AnalysisSummary'
import { AnalysisStockTable } from './AnalysisStockTable'

export const ANALYSIS_TASK_TEXTS_ZH = {
  title: '任务详情',
  description: '这次任务用的条件、评价与命中数据。',
  conditionTitle: '条件详情',
  conditionName: '条件名称',
  conditionSavedAt: '保存时间',
  conditionBase: '基础筛选',
  conditionCount: (count: number) => `${count} 个条件`,
  conditionMissing: '原条件文件已删除，只能看这次跑出来的结果。',
  rangeTitle: '任务范围',
  rangeLine: (start: string, end: string, days: number) => `${start} ~ ${end} · ${days} 个交易日`,
  validateLine: (days: number) => `验证天数 ${days} 个交易日`,
  sampleLine: (hits: number) => `命中 ${hits} 条`,
  evaluationTitle: '条件评价',
  evaluationPending: '结果还在跑，跑完这里会给出评价。',
  evaluationFailed: '这次任务没有可用的统计（0 条命中或数据不足）。',
  dataTitle: '符合要求的数据',
  dataHint: '按命中次数排序，点「查看完整报告」看全部个股与分组统计。',
  report: '查看完整报告',
  excel: '下载 Excel',
  excelPending: 'Excel 生成中',
  close: '关闭',
  loading: '正在读取任务…',
  loadFailed: (message: string) => `读取任务失败：${message}`,
  elapsed: (text: string) => `耗时 ${text}`,
  statusPrefix: '状态',
  statuses: {
    pending: '排队中',
    running: '进行中',
    interrupted: '已中断',
    done: '已完成',
    stopped: '已停止',
    failed: '失败',
  } as Record<string, string>,
  marketAll: '全部市场',
  stIncluded: '含 ST',
  stExcluded: '不含 ST',
  running: '正在跑',
}

function formatCreatedAt(instant?: string | null): string {
  if (!instant) return '—'
  return toLocalDateTimeInput(instant).slice(0, 16).replace('T', ' ')
}

export function AnalysisTaskDetailDialog({
  runId,
  open,
  onOpenChange,
}: {
  runId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const T = ANALYSIS_TASK_TEXTS_ZH
  const [detail, setDetail] = useState<AnalysisDetail | null>(null)
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const load = useCallback(async (id: string) => {
    setLoading(true)
    setError(null)
    try {
      const data = await getAnalysisDetail(id)
      setDetail(data)
      if (['done', 'stopped'].includes(data.run.status)) {
        try {
          setReport(await getAnalysisReport(id))
        } catch {
          // 0 条命中的任务没有报告：不是错误，界面给一句说明
          setReport(null)
        }
      } else {
        setReport(null)
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
      setDetail(null)
      setReport(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open || !runId) return
    void load(runId)
  }, [load, open, runId])

  const handleDownload = async () => {
    if (!detail) return
    setDownloading(true)
    try {
      await downloadAnalysisExcel(detail.run.run_id, `${detail.run.preset}-${detail.run.run_id}.xlsx`)
      setError(null)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setDownloading(false)
    }
  }

  const request = (detail?.condition.request ?? null) as ScreenRequest | null
  const conditionCount = request?.rule ? countConditions(request.rule) : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[900px]" data-fork-analysis-task-detail>
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>{T.description}</DialogDescription>
        </DialogHeader>

        <div className="max-h-[72vh] space-y-3 overflow-y-auto scrollbar pr-1">
          {error && (
            <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>
          )}
          {loading && <p className="text-[11px] text-muted-foreground">{T.loading}</p>}

          {detail && (
            <>
              <section className="rounded-lg border border-border/60 bg-accent/10 p-3 text-[11px]">
                <p className="mb-1 text-[12px] font-medium">{T.conditionTitle}</p>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="text-[12px] font-semibold">{detail.condition.name}</span>
                  <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {T.statusPrefix}：{T.statuses[detail.run.status] ?? detail.run.status}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {T.rangeLine(detail.run.start_date, detail.run.end_date, detail.run.days_done)}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {T.validateLine(detail.run.validate_days ?? 30)}
                  </span>
                </div>
                {request ? (
                  <p className="text-muted-foreground">
                    {summarizeBase(request)} · {T.conditionCount(conditionCount)}
                  </p>
                ) : (
                  <p className="text-amber-600">{T.conditionMissing}</p>
                )}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {T.conditionSavedAt} {formatCreatedAt(detail.condition.saved_at)} ·{' '}
                  {T.sampleLine(detail.run.hits)}
                  {detail.run.elapsed_s ? ` · ${T.elapsed(formatDuration(detail.run.elapsed_s))}` : ''}
                </p>
              </section>

              <section>
                <h4 className="mb-1 text-[12px] font-medium">{T.evaluationTitle}</h4>
                {report ? (
                  <div className="space-y-2">
                    <AnalysisVerdictCard report={report} />
                    <AnalysisHorizonTable report={report} />
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    {['done', 'stopped'].includes(detail.run.status)
                      ? T.evaluationFailed
                      : T.evaluationPending}
                  </p>
                )}
              </section>

              {report && (
                <section>
                  <h4 className="mb-1 text-[12px] font-medium">{T.dataTitle}</h4>
                  <p className="mb-1 text-[10px] text-muted-foreground">{T.dataHint}</p>
                  <AnalysisStockTable runId={detail.run.run_id} compact horizons={report.horizons} />
                </section>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-3 text-[12px]"
                  disabled={!report}
                  onClick={() =>
                    window.open(`/analysis/report/${detail.run.run_id}`, '_blank', 'noopener')
                  }
                  data-fork-analysis-detail-report
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {T.report}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-3 text-[12px]"
                  disabled={!detail.run.excel_ready || downloading}
                  onClick={() => void handleDownload()}
                  data-fork-analysis-detail-excel
                >
                  <Download className="h-3.5 w-3.5" />
                  {detail.run.excel_ready ? T.excel : T.excelPending}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 px-3 text-[12px]"
                  onClick={() => onOpenChange(false)}
                >
                  {T.close}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
