/**
 * 报告主体：结论卡 + 六周期指标表 + 三张统计图（弹窗与独立报告页共用）。
 *
 * 「结论卡」是这一页的核心：用户要的是「这个条件准不准、几天内概率最高」，
 * 所以先把话说清楚（能不能用、最佳持有期、超额多少、样本多少），再给明细。
 */
import { BarPairChart, DensityChart, Heatmap, HistogramChart, LineChart, excessColor } from './AnalysisCharts'
import type { AnalysisReport } from '@/lib/analysis-api'

export const ANALYSIS_SUMMARY_TEXTS_ZH = {
  verdictTitle: '结论',
  usable: (horizon: number, rate: string, base: string, excess: string, sample: number) =>
    `这个条件有用：最佳持有 ${horizon} 个交易日，胜率 ${rate}%（随机买入 ${base}%，超额 ${excess}pp），样本 ${sample} 条。`,
  noEdge: (horizon: number, excess: string, base: string) =>
    `没有优势：最好的周期（${horizon} 日）只比随机买入高 ${excess}pp（随机 ${base}%），建议重新设计条件。`,
  worse: (horizon: number, excess: string, rate: string, base: string) =>
    `比随机买入还差：${horizon} 日胜率 ${rate}%，随机买入 ${base}%（低 ${Math.abs(Number(excess)).toFixed(1)}pp，统计显著）。这个条件要重新设计。`,
  notSignificant: (z: string) => `差异不显著（z=${z}）：看着高一点，但统计上不能确认，不能据此下结论。`,
  insufficient: '样本不足 100 条，无法判断条件好坏。把日期区间放长再跑一次。',
  detailLine: (avg: string, payoff: string, touch: string) =>
    `平均涨幅 ${avg}%，盈亏比 ${payoff}，最高价曾上涨过的比例 ${touch}%`,
  horizonsTitle: '按持有周期看',
  horizonsHint: '超额 = 条件胜率 − 同期随机买入胜率；|超额| < 2pp 涂灰（等于没用）',
  tableHorizon: '周期',
  tableSignal: '条件胜率',
  tableControl: '随机胜率',
  tableExcess: '超额',
  tableTouch: '触及率',
  tableAvg: '平均涨幅',
  tablePayoff: '盈亏比',
  tableSample: '样本',
  boardTitle: '分市场',
  boardHint: '同一市场里条件 vs 随机买入，每格是超额胜率（百分点）',
  yearTitle: '分年度',
  yearHint: '条件组与随机组两条线贴在一起 = 这个条件近年被市场消化了',
  histTitle: '涨幅分布',
  histHint: '0 线右侧是上涨；右尾越长说明命中后的弹性越大',
  densityTitle: '每日命中数',
  densityHint: '逐年变少说明条件在被市场消化',
  boardLabels: { sh: '沪市', sz: '深市', cyb: '创业板', kcb: '科创板', other: '其他' } as Record<string, string>,
  winRateLabel: '胜率',
  days: (n: number) => `${n} 日`,
  excessValue: (value: string) => `${value}pp`,
  noVerdict: '暂无统计',
}

function fmt(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

/** 百分数：值为空时只留一个破折号，不写成「—%」。 */
function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(digits)}%`
}

function signed(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`
}

export function AnalysisVerdictCard({ report }: { report: AnalysisReport }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  const verdict = report.verdict
  // 卡片上的周期与明细必须讲同一个周期：'worse' 讲「显著跑输」的那个，
  // 其余讲「最好」的那个（否则会出现「标题 5 日、正文 15 日」的自相矛盾）
  const focusHorizon =
    verdict.reason === 'worse' ? verdict.worst_horizon ?? verdict.best_horizon : verdict.best_horizon
  const best = report.summary.find(row => row.horizon === focusHorizon) ?? null
  let text = T.insufficient
  if (verdict.reason === 'usable' && verdict.best_horizon !== null) {
    text = T.usable(
      verdict.best_horizon,
      fmt(verdict.best_win_rate),
      fmt(verdict.baseline_win_rate),
      signed(verdict.best_excess_pp),
      verdict.sample ?? 0,
    )
  } else if (verdict.reason === 'worse') {
    text = T.worse(
      verdict.worst_horizon ?? verdict.best_horizon ?? 0,
      fmt(verdict.worst_excess_pp),
      fmt(verdict.worst_win_rate),
      fmt(verdict.worst_baseline),
    )
  } else if (verdict.reason === 'no_edge' && verdict.best_horizon !== null) {
    text = T.noEdge(verdict.best_horizon, signed(verdict.best_excess_pp), fmt(verdict.baseline_win_rate))
  } else if (verdict.reason === 'not_significant') {
    text = T.notSignificant(fmt(verdict.z, 2))
  }
  const tone =
    verdict.reason === 'usable'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700'
      : verdict.reason === 'worse'
        ? 'border-red-500/40 bg-red-500/10 text-red-700'
        : verdict.reason === 'insufficient'
          ? 'border-border/60 bg-accent/20 text-foreground'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700'

  return (
    <div data-fork-analysis-verdict className={`rounded-lg border p-3 text-[12px] leading-relaxed ${tone}`}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide opacity-70">{T.verdictTitle}</span>
        {focusHorizon !== null && focusHorizon !== undefined && (
          <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium">
            {T.days(focusHorizon)}
          </span>
        )}
      </div>
      <p data-fork-analysis-verdict-text>{text}</p>
      {best && (
        <p className="mt-1 text-[11px] opacity-80">
          {`${T.detailLine(fmt(best.signal.avg_return, 2), fmt(best.signal.payoff, 2), fmt(best.signal.touch_rate))}`}
        </p>
      )}
    </div>
  )
}

export function AnalysisHorizonTable({ report }: { report: AnalysisReport }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  return (
    <div className="overflow-x-auto scrollbar" data-fork-analysis-horizons>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-border/60 text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">{T.tableHorizon}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tableSignal}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tableControl}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tableExcess}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tableTouch}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tableAvg}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tablePayoff}</th>
            <th className="px-2 py-1 text-right font-medium">{T.tableSample}</th>
          </tr>
        </thead>
        <tbody>
          {report.summary.map(row => (
            <tr
              key={row.horizon}
              className={`border-b border-border/30 ${
                row.horizon === report.verdict.best_horizon ? 'bg-primary/5 font-medium' : ''
              }`}
            >
              <td className="px-2 py-1">{T.days(row.horizon)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{pct(row.signal.win_rate)}</td>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{pct(row.control.win_rate)}</td>
              <td className="px-2 py-1 text-right tabular-nums" style={{ color: excessColor(row.excess_pp) }}>
                {T.excessValue(signed(row.excess_pp))}
              </td>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{pct(row.signal.touch_rate)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{signed(row.signal.avg_return, 2)}%</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmt(row.signal.payoff, 2)}</td>
              <td className="px-2 py-1 text-right tabular-nums text-muted-foreground">{row.signal.n}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AnalysisSummaryBody({ report, compact = false }: { report: AnalysisReport; compact?: boolean }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  const barItems = report.summary.map(row => ({
    label: T.days(row.horizon),
    signal: row.signal.win_rate,
    control: row.control.win_rate,
    excess: row.excess_pp,
  }))
  const boardRows = report.by_board.map(row => ({
    label: T.boardLabels[row.key] ?? row.key,
    values: report.horizons.map(horizon => row.excess[String(horizon)] ?? null),
  }))
  const yearLabels = report.by_year.map(row => row.key)
  const yearSeries = [
    {
      name: T.tableSignal,
      color: '#2b3eee',
      points: report.by_year.map(row => ({
        x: row.key,
        y: row.signal?.['10']?.win_rate ?? null,
      })),
    },
    {
      name: T.tableControl,
      color: '#94a3b8',
      points: report.by_year.map(row => ({
        x: row.key,
        y: row.control?.['10']?.win_rate ?? null,
      })),
    },
  ]

  return (
    <div className="space-y-3" data-fork-analysis-summary>
      <AnalysisVerdictCard report={report} />

      <section>
        <header className="mb-1 flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.horizonsTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.horizonsHint}</span>
        </header>
        <BarPairChart items={barItems} height={compact ? 190 : 230} />
        {!compact && <AnalysisHorizonTable report={report} />}
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <div>
          <header className="mb-1 flex items-baseline gap-2">
            <h4 className="text-[12px] font-medium">{T.boardTitle}</h4>
            <span className="text-[10px] text-muted-foreground">{T.boardHint}</span>
          </header>
          <Heatmap rows={boardRows} columns={report.horizons.map(horizon => T.days(horizon))} />
        </div>
        <div>
          <header className="mb-1 flex items-baseline gap-2">
            <h4 className="text-[12px] font-medium">{T.yearTitle}</h4>
            <span className="text-[10px] text-muted-foreground">{T.yearHint}</span>
          </header>
          <LineChart series={yearSeries} />
          <p className="text-[10px] text-muted-foreground">{yearLabels.join(' · ')}</p>
        </div>
      </section>

      {!compact && (
        <section>
          <header className="mb-1 flex items-baseline gap-2">
            <h4 className="text-[12px] font-medium">{T.histTitle}</h4>
            <span className="text-[10px] text-muted-foreground">{T.histHint}</span>
          </header>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {report.histograms.series.map(series => (
              <div key={series.horizon}>
                <p className="mb-0.5 text-[10px] text-muted-foreground">{T.days(series.horizon)}</p>
                <HistogramChart edges={report.histograms.edges} counts={series.counts} height={132} />
              </div>
            ))}
          </div>
        </section>
      )}

      {!compact && (
        <section>
          <header className="mb-1 flex items-baseline gap-2">
            <h4 className="text-[12px] font-medium">{T.densityTitle}</h4>
            <span className="text-[10px] text-muted-foreground">{T.densityHint}</span>
          </header>
          <DensityChart points={report.density} />
        </section>
      )}
    </div>
  )
}
