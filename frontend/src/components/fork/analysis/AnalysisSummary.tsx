/**
 * 报告主体：结论卡 + 各周期指标表 + 分市场/分年度 + 到达天数 + 分组统计
 * （弹窗与独立报告页共用）。
 *
 * 用户 2026-10-22 第 6 条：界面不显示随机对照组 —— 表格里没有「随机胜率」列，
 * 柱状图与折线图也不画对照线。超额胜率仍然保留（它是判断「有没有用」的唯一
 * 参照，只是不再把对照组的绝对数字摆出来）。
 */
import { BarPairChart, DensityChart, Heatmap, HistogramChart, LineChart, excessColor } from './AnalysisCharts'
import type { AnalysisGroupBlock, AnalysisReport } from '@/lib/analysis-api'
import { AnalysisHonesty } from './AnalysisHonesty'

export const ANALYSIS_SUMMARY_TEXTS_ZH = {
  verdictTitle: '结论',
  usable: (horizon: number, rate: string, sample: number) =>
    `这个条件有用：最佳持有 ${horizon} 个交易日，胜率 ${rate}%，显著高于同期随机买入，样本 ${sample} 条。`,
  noEdge: (horizon: number, excess: string) =>
    `没有优势：最好的周期（${horizon} 日）相对随机买入只有 ${excess}pp，建议重新设计条件。`,
  worse: (horizon: number, rate: string, excess: string) =>
    `比随机买入还差：${horizon} 日胜率 ${rate}%，低 ${excess}pp 且统计显著。这个条件要重新设计。`,
  notSignificant: (z: string) => `差异不显著（z=${z}）：看着高一点，但统计上不能确认，不能据此下结论。`,
  notSignificantHonest: (low: string, high: string) =>
    `区间跨 0：日均超额 ${low} 到 ${high}pp（95%，已修正重叠样本），说不清有没有优势。`,
  insufficient: '样本不足 100 条，无法判断条件好坏。把日期区间放长再跑一次。',
  detailLine: (avg: string, payoff: string, touch: string, arrive: string) =>
    `平均涨幅 ${avg}%，盈亏比 ${payoff}，最高价曾上涨过的比例 ${touch}%，中位到达天数 ${arrive}`,
  horizonsTitle: '按持有周期看',
  horizonsHint: '超额 = 条件胜率 − 同期随机买入胜率（界面不展示对照组数字）；|超额| < 2pp 涂灰 = 等于没用',
  tableHorizon: '周期',
  tableSignal: '条件胜率',
  tableExcess: '超额',
  tableTouch: '触及率',
  tableAvg: '平均涨幅',
  tablePayoff: '盈亏比',
  tableSample: '样本',
  boardTitle: '分市场',
  boardHint: '每格是该市场相对这个条件整体胜率的差值（百分点）',
  yearTitle: '分年度',
  yearHint: '只有一条线：条件组逐年胜率。贴住 50% 或往下走 = 这个条件在当前市场已经失效',
  histTitle: '涨幅分布',
  histHint: '0 线右侧是上涨；右尾越长说明命中后的弹性越大',
  densityTitle: '每日命中数',
  densityHint: '逐年变少说明条件在被市场消化',
  arrivalTitle: '多久内能走出来',
  arrivalHint: '第一次收盘涨幅 > 0 的交易日分布（含一次都没涨的），中位数越小说明启动越快',
  arrivalMedian: (days: number | null) =>
    days === null ? '中位到达天数 —' : `中位到达天数 ${days} 个交易日`,
  arrivalWithin: (values: string) => `区间内到达比例：${values}`,
  arrivalNever: (share: string) => `整段都没收涨 ${share}%`,
  groupTitle: '哪类股票特别有效',
  groupHint: '胜率 − 这个条件整体胜率；q 值是 BH 校正后的显著性，样本 < 100 的不下结论',
  groupFocus: (days: number) => `按 ${days} 日胜率`,
  groupDimEmpty: '这个维度没有可用数据（行业要等数据同步写入）',
  groupTableHead: {
    key: '分类',
    n: '样本',
    rate: '胜率',
    edge: '优势',
    vsRandom: '对随机',
    q: 'q值',
    verdict: '结论',
  },
  groupVsRandomHint: '「优势」= 比这个条件整体好多少；「对随机」= 比同期随机买入好多少（负值说明这一类照样跑输）',
  groupVerdict: { edge: '特别有效', no_edge: '一般', insufficient: '样本不足' } as Record<string, string>,
  groupTopTitle: '最有效的分类（跨维度）',
  groupTopEmpty: '没有哪个分类达到「特别有效」（样本足 + q<0.1 + 优势为正）。',
  groupTopItem: (dim: string, key: string, rate: string, edge: string, n: number) =>
    `${dim} · ${key}：${rate}（${edge}pp，样本 ${n}）`,
  arrivalBucket: (day: number, n: number) => `第 ${day} 个交易日 ${n} 条`,
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
    text = T.usable(verdict.best_horizon, fmt(verdict.best_win_rate), verdict.sample ?? 0)
  } else if (verdict.reason === 'worse') {
    text = T.worse(
      verdict.worst_horizon ?? verdict.best_horizon ?? 0,
      fmt(verdict.worst_win_rate),
      fmt(Math.abs(Number(verdict.worst_excess_pp ?? 0))),
    )
  } else if (verdict.reason === 'no_edge' && verdict.best_horizon !== null) {
    text = T.noEdge(verdict.best_horizon, signed(verdict.best_excess_pp))
  } else if (verdict.reason === 'not_significant') {
    const honest = verdict.honest
    text =
      honest && honest.primary_ci_low_pp !== null && honest.primary_ci_low_pp !== undefined
        ? T.notSignificantHonest(fmt(honest.primary_ci_low_pp), fmt(honest.primary_ci_high_pp))
        : T.notSignificant(fmt(verdict.z, 2))
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
          {T.detailLine(
            fmt(best.signal.avg_return, 2),
            fmt(best.signal.payoff, 2),
            fmt(best.signal.touch_rate),
            fmt(report.arrival?.median_days ?? null, 0),
          )}
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

/** 到达天数分布：一根一格的竖条（不引图表库，纯 div 足够）。 */
export function ArrivalChart({ report }: { report: AnalysisReport }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  const arrival = report.arrival
  if (!arrival || arrival.buckets.length === 0) return null
  const max = Math.max(1, ...arrival.buckets.map(item => item.n))
  const withinText = report.horizons
    .map(horizon => `${horizon}日 ${pct(arrival.within[String(horizon)])}`)
    .join(' · ')
  return (
    <div data-fork-analysis-arrival>
      <p className="mb-1 text-[10px] text-muted-foreground">
        {T.arrivalMedian(arrival.median_days)} · {T.arrivalWithin(withinText)} ·{' '}
        {T.arrivalNever(pct(arrival.total ? (arrival.never_positive / arrival.total) * 100 : null))}
      </p>
      <div className="flex items-end gap-[2px]" style={{ height: 84 }}>
        {arrival.buckets.map(item => (
          <div
            key={item.day}
            className="flex-1 rounded-t bg-primary/70"
            style={{ height: `${Math.max(2, (item.n / max) * 100)}%` }}
            title={T.arrivalBucket(item.day, item.n)}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
        <span>1</span>
        <span>{arrival.buckets[arrival.buckets.length - 1]?.day}</span>
      </div>
    </div>
  )
}

function GroupTable({ block }: { block: AnalysisGroupBlock }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  const rows = block.items.filter(item => item.n > 0).slice(0, 12)
  if (rows.length === 0) {
    return <p className="text-[10px] text-muted-foreground">{T.groupDimEmpty}</p>
  }
  return (
    <div className="overflow-x-auto scrollbar">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-border/60 text-muted-foreground">
            <th className="px-1.5 py-1 text-left font-medium">{T.groupTableHead.key}</th>
            <th className="px-1.5 py-1 text-right font-medium">{T.groupTableHead.n}</th>
            <th className="px-1.5 py-1 text-right font-medium">{T.groupTableHead.rate}</th>
            <th className="px-1.5 py-1 text-right font-medium">{T.groupTableHead.edge}</th>
            <th className="px-1.5 py-1 text-right font-medium">{T.groupTableHead.vsRandom}</th>
            <th className="px-1.5 py-1 text-right font-medium">{T.groupTableHead.q}</th>
            <th className="px-1.5 py-1 text-left font-medium">{T.groupTableHead.verdict}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(item => (
            <tr key={item.key} className="border-b border-border/20">
              <td className="px-1.5 py-0.5">{T.boardLabels[item.key] ?? item.key}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{item.n}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums">{pct(item.win_rate)}</td>
              <td className="px-1.5 py-0.5 text-right tabular-nums" style={{ color: excessColor(item.edge_pp) }}>
                {signed(item.edge_pp)}
              </td>
              <td
                className="px-1.5 py-0.5 text-right tabular-nums"
                style={{ color: excessColor(item.excess_vs_random_pp) }}
              >
                {signed(item.excess_vs_random_pp)}
              </td>
              <td className="px-1.5 py-0.5 text-right tabular-nums text-muted-foreground">{fmt(item.q, 3)}</td>
              <td className="px-1.5 py-0.5">
                <span
                  className={
                    item.verdict === 'edge'
                      ? 'text-emerald-600'
                      : item.verdict === 'insufficient'
                        ? 'text-muted-foreground'
                        : ''
                  }
                >
                  {T.groupVerdict[item.verdict] ?? item.verdict}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function AnalysisGroups({ report, compact = false }: { report: AnalysisReport; compact?: boolean }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  const blocks = report.groups ?? []
  if (blocks.length === 0) return null
  const focus = blocks[0]?.focus_horizon ?? report.horizons[report.horizons.length - 1]
  const top = blocks
    .flatMap(block => block.items.filter(item => item.significant).map(item => ({ block, item })))
    .sort((a, b) => (b.item.edge_pp ?? 0) - (a.item.edge_pp ?? 0))
    .slice(0, compact ? 6 : 15)
  return (
    <div className="space-y-2" data-fork-analysis-groups>
      <header className="flex items-baseline gap-2">
        <h4 className="text-[12px] font-medium">{T.groupTitle}</h4>
        <span className="text-[10px] text-muted-foreground">{T.groupHint}</span>
        <span className="text-[10px] text-muted-foreground">{T.groupFocus(focus)}</span>
      </header>
      <p className="text-[10px] text-muted-foreground">{T.groupVsRandomHint}</p>

      <div>
        <p className="mb-1 text-[11px] font-medium">{T.groupTopTitle}</p>
        {top.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">{T.groupTopEmpty}</p>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {top.map(({ block, item }) => (
              <li
                key={`${block.dim}-${item.key}`}
                className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px]"
              >
                {T.groupTopItem(
                  block.label,
                  T.boardLabels[item.key] ?? item.key,
                  pct(item.win_rate),
                  signed(item.edge_pp),
                  item.n,
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={compact ? 'grid gap-3 md:grid-cols-2' : 'grid gap-3 md:grid-cols-2 xl:grid-cols-3'}>
        {(compact ? blocks.slice(0, 4) : blocks).map(block => (
          <div key={block.dim}>
            <p className="mb-0.5 text-[11px] font-medium">{block.label}</p>
            <GroupTable block={block} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function AnalysisSummaryBody({ report, compact = false }: { report: AnalysisReport; compact?: boolean }) {
  const T = ANALYSIS_SUMMARY_TEXTS_ZH
  const barItems = report.summary.map(row => ({
    label: T.days(row.horizon),
    signal: row.signal.win_rate,
    control: null,
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
        y: row.signal?.[String(report.horizons[report.horizons.length - 1])]?.win_rate ?? null,
      })),
    },
  ]

  return (
    <div className="space-y-3" data-fork-analysis-summary>
      <AnalysisVerdictCard report={report} />

      <AnalysisHonesty report={report} />

      <section>
        <header className="mb-1 flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.horizonsTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.horizonsHint}</span>
        </header>
        <BarPairChart items={barItems} height={compact ? 190 : 230} showControl={false} />
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

      <section>
        <header className="mb-1 flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.arrivalTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.arrivalHint}</span>
        </header>
        <ArrivalChart report={report} />
      </section>

      <AnalysisGroups report={report} compact={compact} />

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
