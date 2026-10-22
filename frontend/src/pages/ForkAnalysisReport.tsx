/**
 * 数据分析完整报告（独立页面，弹窗右上角的「查看完整报告」在新标签页打开它）。
 *
 * 为什么单独一页：全市场的个股排行 + 五张图 + 六周期明细挤在弹窗里要横向滚动，
 * 而用户要的是「数据多、图大的时候开到新页面」。弹窗只留结论卡 + 排行前 10。
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Download, RefreshCw } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { downloadAnalysisExcel, formatDuration, getAnalysisReport, type AnalysisReport } from '@/lib/analysis-api'
import { AnalysisSummaryBody } from '@/components/fork/analysis/AnalysisSummary'
import { AnalysisStockTable } from '@/components/fork/analysis/AnalysisStockTable'

export const ANALYSIS_REPORT_PAGE_TEXTS_ZH = {
  title: '数据分析报告',
  loading: '正在读取报告…',
  loadFailed: (message: string) => `读取报告失败：${message}`,
  refresh: '刷新',
  excel: '下载 Excel',
  meta: (preset: string, start: string, end: string, days: number) =>
    `条件「${preset}」 · ${start} ~ ${end} · ${days} 个交易日`,
  counts: (hits: number, control: number, elapsed: string) =>
    `命中 ${hits} 条，对照 ${control} 条，耗时 ${elapsed}`,
  notFound: '报告不存在或任务还没跑完。',
  excelFailed: (message: string) => `下载失败：${message}`,
  stocksTitle: '全部个股',
}

export default function ForkAnalysisReportPage() {
  const T = ANALYSIS_REPORT_PAGE_TEXTS_ZH
  const { runId = '' } = useParams()
  const [report, setReport] = useState<AnalysisReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAnalysisReport(runId)
      setReport(data)
      setError(null)
    } catch (exc) {
      setReport(null)
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setLoading(false)
    }
  }, [runId])

  useEffect(() => {
    void load()
  }, [load])

  const handleDownload = async () => {
    if (!report) return
    try {
      await downloadAnalysisExcel(runId, `${report.run.preset}-${runId}.xlsx`)
    } catch (exc) {
      setError(T.excelFailed(exc instanceof Error ? exc.message : String(exc)))
    }
  }

  return (
    <div className="space-y-3" data-fork-analysis-report-page>
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-[15px] font-semibold">{T.title}</h1>
        {report && (
          <span className="text-[11px] text-muted-foreground">
            {T.meta(report.run.preset, report.run.start_date, report.run.end_date, report.run.days_done)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="secondary" className="h-7 px-2 text-[12px]" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {T.refresh}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 px-2 text-[12px]"
            disabled={!report?.run.excel_ready}
            onClick={() => void handleDownload()}
          >
            <Download className="h-3.5 w-3.5" />
            {T.excel}
          </Button>
        </div>
      </header>

      {loading && <p className="text-[12px] text-muted-foreground">{T.loading}</p>}
      {error && <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[12px]">{error}</p>}

      {report && (
        <>
          <p className="text-[11px] text-muted-foreground">
            {T.counts(report.counts.hits, report.counts.control, formatDuration(report.run.elapsed_s ?? null))}
          </p>
          <AnalysisSummaryBody report={report} />
          <AnalysisStockTable runId={runId} horizons={report.horizons} />
        </>
      )}
    </div>
  )
}
