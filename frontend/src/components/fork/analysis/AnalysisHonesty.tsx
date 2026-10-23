/**
 * 统计可信度：把「这个数字有多可信」和「数据有多少是假的」摊开给用户看。
 *
 * 三块内容（都是 2026-10-23 那轮改动的结果）：
 * 1. **重叠修正后区间**：同一个条件在 1600 个交易日上命中几十万次，但 30 日窗口
 *    互相重叠 29 天，独立样本只有一百多个。这里展示按日聚合后的日均超额与 95%
 *    区间 —— 区间跨 0 就是「说不清」，哪怕合并胜率看起来差 3 个百分点。
 * 2. **样本内 / 样本外**：2024 年之前调出来的优势，2024 年之后还在不在。
 * 3. **数据质量**：多少条因为长期停牌/退市/缺复权而不可验证、多少条次日一字
 *    涨停买不进、哪几天行情没同步全。
 */
import type { AnalysisReport } from '@/lib/analysis-api'

export const ANALYSIS_HONESTY_TEXTS_ZH = {
  title: '统计可信度',
  hint: '按交易日聚合 + 重叠修正；区间跨 0 = 不能下结论',
  caliberExec: (cost: string) => `口径：次日开盘买入，已扣 ${cost}% 往返成本`,
  caliberClose: '口径：信号日收盘买入（老任务，未做可执行修正）',
  head: {
    horizon: '周期',
    mean: '日均超额',
    ci: '95% 区间',
    days: '交易日',
    effective: '有效样本',
    verdict: '判断',
  },
  verdictUp: '显著更高',
  horizonCell: (days: number) => `${days} 日`,
  ppCell: (value: string) => `${value}pp`,
  rangeCell: (low: string, high: string) => `[${low}, ${high}]`,
  stableItem: (days: number, design: string, validate: string) =>
    `${days} 日 · ${design}pp · ${validate}pp`,
  verdictDown: '显著更低',
  verdictFlat: '无法确认',
  notePooled: (pooled: string, honest: string) =>
    `合并口径 ${pooled}pp → 按日口径 ${honest}pp：差额来自重叠样本被当成独立样本`,
  stableTitle: '样本内 / 样本外',
  stableHint: (split: string) => `${split} 之前是设计期，之后是验证期；验证期掉下来 = 这个条件已经不好用了`,
  stableDesign: '设计期',
  stableValidate: '验证期',
  stableDecay: (value: string) => `衰减 ${value}pp`,
  stableEmpty: '区间只覆盖一个时期，无法对比',
  qualityTitle: '数据质量',
  qualityUnverifiable: (n: number) => `不可验证 ${n} 条`,
  qualityUnfillable: (n: number) => `次日一字涨停买不进 ${n} 条`,
  qualitySuspect: (n: number) => `行情不全 ${n} 天`,
  qualityStale: (n: number) => `最长停牌顺延 ${n} 天`,
  qualityOk: '所有交易日的数据都完整',
  versionLine: (day: string, symbols: number) => `行情截至 ${day} · 股票池 ${symbols} 只`,
  caveatTitle: '已知局限',
  caveats: [
    '退市股不在行情库里，样本只含「现在还活着」的股票，历史胜率会略偏高（幸存者偏差）。',
    '2026-09-24 之前的 ST 状态无法回溯，「不含 ST」实际按今天的名字过滤。',
    '行业分类是当前快照，不是信号日的历史行业。',
  ],
  empty: '这个任务没有可用的显著性数据（太短或还没有信号）',
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

export function AnalysisHonesty({ report }: { report: AnalysisReport }) {
  const T = ANALYSIS_HONESTY_TEXTS_ZH
  const rows = report.significance ?? []
  const quality = report.quality
  const stability = report.stability
  const version = report.data_version
  if (rows.length === 0) {
    return <p className="text-[11px] text-muted-foreground">{T.empty}</p>
  }
  const cost = ((report.cost ?? 0) * 100).toFixed(1)
  const caliberText = report.caliber === 'close' ? T.caliberClose : T.caliberExec(cost)

  return (
    <section className="space-y-2" data-fork-analysis-honesty>
      <header className="flex items-baseline gap-2">
        <h4 className="text-[12px] font-medium">{T.title}</h4>
        <span className="text-[10px] text-muted-foreground">{T.hint}</span>
      </header>
      <p className="text-[10px] text-muted-foreground">{caliberText}</p>

      <div className="overflow-x-auto scrollbar">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[10px] text-muted-foreground">
              <th className="py-1 pr-2 font-normal">{T.head.horizon}</th>
              <th className="py-1 pr-2 font-normal">{T.head.mean}</th>
              <th className="py-1 pr-2 font-normal">{T.head.ci}</th>
              <th className="py-1 pr-2 font-normal">{T.head.days}</th>
              <th className="py-1 pr-2 font-normal">{T.head.effective}</th>
              <th className="py-1 font-normal">{T.head.verdict}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const verdict = row.significant_up ? T.verdictUp : row.significant_down ? T.verdictDown : T.verdictFlat
              const tone = row.significant_up
                ? 'text-emerald-600'
                : row.significant_down
                  ? 'text-rose-600'
                  : 'text-muted-foreground'
              return (
                <tr key={row.horizon} className="border-t border-border/40">
                  <td className="py-1 pr-2">{T.horizonCell(row.horizon)}</td>
                  <td className="py-1 pr-2 tabular-nums">{T.ppCell(fmt(row.mean_excess_pp))}</td>
                  <td className="py-1 pr-2 tabular-nums text-muted-foreground">
                    {T.rangeCell(fmt(row.ci_low_pp), fmt(row.ci_high_pp))}
                  </td>
                  <td className="py-1 pr-2 tabular-nums">{row.days}</td>
                  <td className="py-1 pr-2 tabular-nums">{row.n_eff}</td>
                  <td className={`py-1 ${tone}`}>{verdict}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {rows[0]?.pooled_excess_pp !== null && rows[0]?.mean_excess_pp !== null && (
        <p className="text-[10px] text-muted-foreground">
          {T.notePooled(fmt(rows[0].pooled_excess_pp), fmt(rows[0].mean_excess_pp))}
        </p>
      )}

      {stability && (
        <div>
          <p className="text-[11px] font-medium">{T.stableTitle}</p>
          <p className="mb-1 text-[10px] text-muted-foreground">{T.stableHint(stability.split)}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            {report.horizons.map(horizon => {
              const design = stability.design_excess_pp[String(horizon)]
              const validate = stability.validate_excess_pp[String(horizon)]
              if (design === null && validate === null) return null
              return (
                <span key={horizon} className="tabular-nums">
                  {T.stableItem(horizon, `${T.stableDesign} ${fmt(design)}`, `${T.stableValidate} ${fmt(validate)}`)}
                  {design !== null && validate !== null && (
                    <span className="text-muted-foreground"> （{T.stableDecay(fmt(validate - design))}）</span>
                  )}
                </span>
              )
            })}
          </div>
        </div>
      )}

      {quality && (
        <div>
          <p className="text-[11px] font-medium">{T.qualityTitle}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>{T.qualityUnverifiable(quality.unverifiable)}</span>
            <span>{T.qualityUnfillable(quality.unfillable)}</span>
            <span>{T.qualitySuspect(quality.suspect_days_count)}</span>
            <span>{T.qualityStale(quality.max_stale_days)}</span>
          </div>
        </div>
      )}

      <div>
        <p className="text-[11px] font-medium">{T.caveatTitle}</p>
        <ul className="list-disc pl-4 text-[10px] text-muted-foreground">
          {T.caveats.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      {version?.max_trade_date && (
        <p className="text-[10px] text-muted-foreground">
          {T.versionLine(version.max_trade_date, version.symbols ?? 0)}
        </p>
      )}
    </section>
  )
}
