/**
 * 个股准确率排行（服务端排序 + 分页）。
 *
 * 默认按「10 日胜率」降序，但排行本身会骗人（命中 3 次全胜排第一），所以每行都
 * 带信号数，并且「样本不足 30 次」的标灰 —— 筛选器可以只看样本足够的。
 * 点一行展开该股在这个条件下的全部信号明细。
 */
import { useCallback, useEffect, useState } from 'react'
import { getAnalysisSignals, getAnalysisStocks, type AnalysisSignalRow, type AnalysisStockRow } from '@/lib/analysis-api'
import { excessColor } from './AnalysisCharts'

export const STOCK_TABLE_TEXTS_ZH = {
  title: '个股准确率排行',
  hint: '点一行看这只股票的全部信号。宽口径条件（每天命中几百只）的单股命中次数往往不多，所以默认只看命中 ≥10 次的；<30 次的当趋势看，别当结论。',
  empty: '暂无命中',
  code: '代码',
  name: '名称',
  board: '市场',
  signals: '命中次数',
  win: (n: number) => `${n}日胜率`,
  excess: (days: number) => `${days}日超额`,
  excessValue: (value: string) => `${value}pp`,
  search: '搜索代码 / 名称',
  boardAll: '全部市场',
  minSamplesAll: '全部',
  minSamplesTen: '≥10 次',
  minSamplesThirty: '≥30 次',
  minSamplesHint: '样本下限',
  paging: (from: number, to: number, total: number) => `第 ${from}–${to} 条 / 共 ${total} 条`,
  prev: '上一页',
  next: '下一页',
  detailTitle: (code: string, name: string) => `${code} ${name} 的信号明细`,
  detailD0: '信号日',
  detailPrice: '信号日收盘价',
  detailAvail: '实际可取天数',
  detailEmpty: '这只股票还没有数据',
  boardLabels: { sh: '沪市', sz: '深市', cyb: '创业板', kcb: '科创板', other: '其他' } as Record<string, string>,
  loadFailed: (message: string) => `读取排行失败：${message}`,
  details: ['第5天', '第10天', '第20天', '第30天'],
}

const PAGE_SIZE = 20
const COMPACT_SIZE = 10

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function signed(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

export function AnalysisStockTable({
  runId,
  compact = false,
  horizons = [5, 10, 15, 20, 25, 30],
}: {
  runId: string
  compact?: boolean
  /** 任务的统计周期（验证天数决定，12 → [5, 10]） */
  horizons?: number[]
}) {
  const T = STOCK_TABLE_TEXTS_ZH
  const horizonKeys = horizons.length > 0 ? horizons : [5, 10, 15, 20, 25, 30]
  const focus = horizonKeys[horizonKeys.length - 1]
  const [rows, setRows] = useState<AnalysisStockRow[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState(`win${focus}`)
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [board, setBoard] = useState('')
  const [query, setQuery] = useState('')
  const [minSamples, setMinSamples] = useState(10)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [signals, setSignals] = useState<AnalysisSignalRow[]>([])
  const limit = compact ? COMPACT_SIZE : PAGE_SIZE

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAnalysisStocks(runId, {
        offset,
        limit,
        sort,
        order,
        board: board || undefined,
        q: query.trim() || undefined,
        minSamples,
      })
      setRows(data.items)
      setTotal(data.total)
      setError(null)
    } catch (exc) {
      setError(T.loadFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setLoading(false)
    }
  }, [T, board, limit, minSamples, offset, order, query, runId, sort])

  useEffect(() => {
    void load()
  }, [load])

  const toggleSort = (key: string) => {
    if (sort === key) {
      setOrder(order === 'desc' ? 'asc' : 'desc')
    } else {
      setSort(key)
      setOrder('desc')
    }
    setOffset(0)
  }

  const openDetail = async (row: AnalysisStockRow) => {
    if (expanded === row.code) {
      setExpanded(null)
      return
    }
    setExpanded(row.code)
    setSignals([])
    try {
      const data = await getAnalysisSignals(runId, row.code)
      setSignals(data)
    } catch {
      setSignals([])
    }
  }

  const header = (key: string, label: string, align: 'left' | 'right' = 'right') => (
    <th
      className={`cursor-pointer px-2 py-1 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
      onClick={() => toggleSort(key)}
      title={`${label}${sort === key ? (order === 'desc' ? ' ↓' : ' ↑') : ''}`}
    >
      {label}
      {sort === key ? (order === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  )

  return (
    <section data-fork-analysis-stocks className="space-y-1.5">
      <header className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-[12px] font-medium">{T.title}</h4>
        <span className="text-[10px] text-muted-foreground">{T.hint}</span>
      </header>

      {!compact && (
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setOffset(0)
            }}
            placeholder={T.search}
            aria-label={T.search}
            data-fork-analysis-search
            className="h-7 w-[180px] rounded-md border border-input bg-background px-2 text-[11px]"
          />
          {['', 'sh', 'sz', 'cyb', 'kcb'].map(key => (
            <button
              key={key || 'all'}
              type="button"
              onClick={() => {
                setBoard(key)
                setOffset(0)
              }}
              className={`h-7 rounded-md border px-2 text-[11px] ${
                board === key ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border/60 text-muted-foreground'
              }`}
            >
              {key ? T.boardLabels[key] : T.boardAll}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground">{T.minSamplesHint}</span>
          {[
            { value: 0, label: T.minSamplesAll },
            { value: 10, label: T.minSamplesTen },
            { value: 30, label: T.minSamplesThirty },
          ].map(option => (
            <button
              key={option.value}
              type="button"
              data-fork-analysis-min-samples={option.value}
              onClick={() => {
                setMinSamples(option.value)
                setOffset(0)
              }}
              className={`h-7 rounded-md border px-2 text-[11px] ${
                minSamples === option.value
                  ? 'border-primary/60 bg-primary/10 text-primary'
                  : 'border-border/60 text-muted-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="overflow-x-auto scrollbar">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="border-b border-border/60 text-muted-foreground">
              {header('code', T.code, 'left')}
              {header('name', T.name, 'left')}
              <th className="px-2 py-1 text-left font-medium">{T.board}</th>
              {header('n', T.signals)}
              {horizonKeys.map(horizon => header(`win${horizon}`, T.win(horizon)))}
              {header(`excess${focus}`, T.excess(focus))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={row.code}
                onClick={() => void openDetail(row)}
                data-fork-analysis-stock-row={row.code}
                className={`cursor-pointer border-b border-border/30 hover:bg-accent/30 ${
                  row.sufficient ? '' : 'text-muted-foreground'
                } ${expanded === row.code ? 'bg-accent/30' : ''}`}
              >
                <td className="px-2 py-1 font-mono">{row.code}</td>
                <td className="px-2 py-1 truncate">{row.name}</td>
                <td className="px-2 py-1">{T.boardLabels[row.board] ?? row.board}</td>
                <td className="px-2 py-1 text-right tabular-nums">{row.n}</td>
                {horizonKeys.map(horizon => (
                  <td key={horizon} className="px-2 py-1 text-right tabular-nums">
                    {pct(row.win[String(horizon)])}
                  </td>
                ))}
                <td
                  className="px-2 py-1 text-right tabular-nums"
                  style={{ color: excessColor(row.excess[String(focus)]) }}
                >
                  {T.excessValue(signed(row.excess[String(focus)]))}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="px-2 py-3 text-center text-muted-foreground">
                  {T.empty}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {expanded && (
        <div className="rounded-md border border-border/60 bg-accent/10 p-2" data-fork-analysis-signals>
          <p className="mb-1 text-[11px] font-medium">
            {T.detailTitle(expanded, rows.find(row => row.code === expanded)?.name ?? '')}
          </p>
          {signals.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{T.detailEmpty}</p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto scrollbar">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="px-1 py-0.5 text-left font-medium">{T.detailD0}</th>
                    <th className="px-1 py-0.5 text-right font-medium">{T.detailPrice}</th>
                    {[5, 10, 20, 30].map(horizon => (
                      <th key={horizon} className="px-1 py-0.5 text-right font-medium">
                        {T.win(horizon)}
                      </th>
                    ))}
                    <th className="px-1 py-0.5 text-right font-medium">{T.detailAvail}</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map(row => (
                    <tr key={row.d0} className="border-t border-border/20">
                      <td className="px-1 py-0.5">{row.d0}</td>
                      <td className="px-1 py-0.5 text-right tabular-nums">{fmt(row.d0_close, 2)}</td>
                      {[5, 10, 20, 30].map(horizon => (
                        <td
                          key={horizon}
                          className="px-1 py-0.5 text-right tabular-nums"
                          style={{ color: excessColor((row.returns[horizon - 1] ?? 0) * 100) }}
                        >
                          {row.returns[horizon - 1] === null
                            ? '—'
                            : `${signed((row.returns[horizon - 1] as number) * 100, 2)}%`}
                        </td>
                      ))}
                      <td className="px-1 py-0.5 text-right tabular-nums text-muted-foreground">{row.avail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!compact && total > limit && (
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <button
            type="button"
            className="h-6 rounded border border-border/60 px-2 disabled:opacity-40"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
          >
            {T.prev}
          </button>
          <span>{T.paging(offset + 1, Math.min(total, offset + limit), total)}</span>
          <button
            type="button"
            className="h-6 rounded border border-border/60 px-2 disabled:opacity-40"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
          >
            {T.next}
          </button>
        </div>
      )}
    </section>
  )
}
