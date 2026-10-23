/**
 * 统一结果渲染器：读后端 ``StandardReport``（所有统计方法同构）。
 *
 * 为什么只写一个渲染器
 * -------------------
 * 用户 2026-10-23 第 6 条要求「不同统计分析方法的输入输出 API 与输出文档统一」。
 * 后端把结论卡、表格、产物、数据质量都收进同一个信封，这里按信封渲染 —— 新增方法
 * 只要后端给表，界面不用改代码。列的含义由 ``column.kind`` 决定，组件不猜字段名。
 */
import { useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  downloadAnalysisArtifact,
  type AnalysisStandardReport,
  type AnalysisTable,
  type AnalysisTableColumn,
} from '@/lib/analysis-api'

export const ANALYSIS_METHOD_TEXTS_ZH = {
  method: (name: string, version: string) => `分析方法：${name}（${version}）`,
  verdict: {
    usable: '可用',
    worse: '比随机差',
    mixed: '结论不一致',
    no_edge: '没有优势',
    insufficient: '样本不足',
    unrated: '未评级',
  } as Record<string, string>,
  keyMetrics: '关键数字',
  artifactsTitle: '产物下载',
  download: '下载',
  downloading: '下载中…',
  tablesTitle: '统计结果',
  rowsNote: (shown: number, total: number) => `显示前 ${shown} 行，共 ${total} 行；完整数据请下载 CSV`,
  empty: '这个方法没有产出表格。',
  notesTitle: '口径与局限',
  qualityTitle: '数据质量',
  qualityEvents: (valid: number, total: number) => `有效事件 ${valid} / ${total}`,
  qualityDays: (days: number) => `${days} 个交易日`,
  qualityDuplicates: (count: number) => `重复 ${count} 条（已去重）`,
  qualityProblems: (count: number) => `口径自检异常 ${count} 处`,
  downloadFailed: (message: string) => `下载失败：${message}`,
  boolYes: '是',
  boolNo: '否',
  kb: ' KB',
}

const VERDICT_STYLE: Record<string, string> = {
  usable: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600',
  worse: 'border-destructive/40 bg-destructive/10 text-destructive',
  mixed: 'border-amber-500/40 bg-amber-500/10 text-amber-600',
  no_edge: 'border-border bg-accent/30 text-muted-foreground',
  insufficient: 'border-border bg-accent/30 text-muted-foreground',
  unrated: 'border-border bg-accent/30 text-muted-foreground',
}

function formatCell(value: unknown, column: AnalysisTableColumn): string {
  if (value === null || value === undefined || value === '') return '—'
  if (column.kind === 'percent') {
    const number = Number(value)
    return Number.isFinite(number) ? `${number.toFixed(2)}%` : String(value)
  }
  if (column.kind === 'pp') {
    const number = Number(value)
    if (!Number.isFinite(number)) return String(value)
    return `${number > 0 ? '+' : ''}${number.toFixed(2)}pp`
  }
  if (column.kind === 'int') {
    const number = Number(value)
    return Number.isFinite(number) ? number.toLocaleString('zh-CN') : String(value)
  }
  if (column.kind === 'number') {
    const number = Number(value)
    return Number.isFinite(number) ? number.toFixed(2) : String(value)
  }
  if (column.kind === 'bool') return value ? ANALYSIS_METHOD_TEXTS_ZH.boolYes : ANALYSIS_METHOD_TEXTS_ZH.boolNo
  return String(value)
}

function ArtifactRow({ runId, report }: { runId: string; report: AnalysisStandardReport }) {
  const T = ANALYSIS_METHOD_TEXTS_ZH
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!report.artifacts.length) return null

  const handle = async (name: string) => {
    setBusy(name)
    try {
      await downloadAnalysisArtifact(runId, name)
      setError(null)
    } catch (exc) {
      setError(T.downloadFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-1" data-fork-analysis-artifacts>
      <p className="text-[11px] font-medium">{T.artifactsTitle}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {report.artifacts.map(artifact => (
          <Button
            key={artifact.name}
            size="sm"
            variant="secondary"
            className="h-6 gap-1 px-2 text-[11px]"
            disabled={busy !== null}
            onClick={() => void handle(artifact.name)}
            data-fork-analysis-artifact={artifact.name}
          >
            {artifact.kind === 'md' ? <FileText className="h-3 w-3" /> : <Download className="h-3 w-3" />}
            {artifact.name}
            {artifact.size > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {(artifact.size / 1024).toFixed(0)}
                {ANALYSIS_METHOD_TEXTS_ZH.kb}
              </span>
            )}
          </Button>
        ))}
      </div>
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </section>
  )
}

function TableBlock({ table, compact }: { table: AnalysisTable; compact: boolean }) {
  const T = ANALYSIS_METHOD_TEXTS_ZH
  const limit = compact ? 8 : 300
  const rows = table.rows.slice(0, limit)
  return (
    <section className="space-y-1" data-fork-analysis-table={table.key}>
      <div className="flex flex-wrap items-baseline gap-2">
        <p className="text-[11px] font-medium">{table.title}</p>
        {table.total_rows > rows.length && (
          <span className="text-[10px] text-muted-foreground">
            {T.rowsNote(rows.length, table.total_rows)}
          </span>
        )}
      </div>
      {table.hint && <p className="text-[10px] text-muted-foreground">{table.hint}</p>}
      <div className="overflow-x-auto rounded border border-border/60 scrollbar">
        <table className="w-full text-[11px]">
          <thead className="bg-accent/20 text-muted-foreground">
            <tr>
              {table.columns.map(column => (
                <th key={column.key} className="whitespace-nowrap px-2 py-1 text-left font-normal">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index} className="border-t border-border/40">
                {table.columns.map(column => (
                  <td key={column.key} className="whitespace-nowrap px-2 py-0.5">
                    {formatCell(row[column.key], column)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-2 py-2 text-muted-foreground" colSpan={table.columns.length}>
                  {ANALYSIS_METHOD_TEXTS_ZH.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function AnalysisMethodResult({
  runId,
  report,
  compact = false,
}: {
  runId: string
  report: AnalysisStandardReport
  compact?: boolean
}) {
  const T = ANALYSIS_METHOD_TEXTS_ZH
  const headline = report.headline
  const verdictLabel = T.verdict[headline.verdict] ?? headline.verdict
  const style = VERDICT_STYLE[headline.verdict] ?? VERDICT_STYLE.no_edge
  const quality = (report.data_quality || {}) as Record<string, unknown>
  const tables = compact
    ? report.tables.filter(table => ['window_summary', 'baseline'].includes(table.key)).slice(0, 2)
    : report.tables

  return (
    <div className="space-y-3" data-fork-analysis-standard={report.method.id}>
      <section className="rounded-lg border border-border/60 bg-accent/10 p-3" data-fork-analysis-headline>
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${style}`} data-fork-analysis-verdict={headline.verdict}>
            {verdictLabel}
          </span>
          <span className="text-[12px] font-medium" data-fork-analysis-verdict-text>{headline.title}</span>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {T.method(report.method.name, report.method.version)}
          </span>
        </div>
        {headline.detail && <p className="text-[11px] text-muted-foreground">{headline.detail}</p>}
        {headline.metrics.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {headline.metrics.map(item => (
              <div key={item.key} className="text-[11px]">
                <span className="text-muted-foreground">{item.label} </span>
                <span className="font-medium">
                  {item.value === null || item.value === undefined ? '—' : String(item.value)}
                </span>
                {item.unit && <span className="text-[10px] text-muted-foreground">{item.unit}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <ArtifactRow runId={runId} report={report} />

      {tables.map(table => (
        <TableBlock key={table.key} table={table} compact={compact} />
      ))}

      {!compact && (
        <>
          {(quality.events !== undefined || quality.days !== undefined || quality.duplicates) && (
            <section className="space-y-1" data-fork-analysis-quality>
              <p className="text-[11px] font-medium">{T.qualityTitle}</p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {quality.events !== undefined && (
                  <span>{T.qualityEvents(Number(quality.valid_events ?? 0), Number(quality.events))}</span>
                )}
                {quality.days !== undefined && <span>{T.qualityDays(Number(quality.days))}</span>}
                {Number(quality.duplicates ?? 0) > 0 && (
                  <span>{T.qualityDuplicates(Number(quality.duplicates))}</span>
                )}
                {(quality.invariant_problems as string[] | undefined)?.length ? (
                  <span className="text-amber-600">
                    {T.qualityProblems((quality.invariant_problems as string[]).length)}
                  </span>
                ) : null}
              </div>
            </section>
          )}
          {report.notes.length > 0 && (
            <section className="space-y-1" data-fork-analysis-notes>
              <p className="text-[11px] font-medium">{T.notesTitle}</p>
              <ul className="list-disc space-y-0.5 pl-4 text-[10px] text-muted-foreground">
                {report.notes.map(note => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}
