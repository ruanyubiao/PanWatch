/**
 * 评估体系（v4）：把「这个条件到底能不能用」拆成六个可以分别验证的问题。
 *
 * 1. 成本敏感性 —— 优势是不是只在 0.2% 成本假设下存在（微盘尤其重要）；
 * 2. 入场假设 —— 换成次日收盘/典型价买入，超额还在不在（拿不拿得到那个价）；
 * 3. 组合模拟 —— 每天只能买 K 只、持有 H 天时，真实净值与回撤；
 * 4. 因子归因 —— 控制市值/行业/年份之后还剩多少（是不是只是「选中小盘」）；
 * 5. 年度异质性 —— 优势是不是只存在于某一年（Cochran's Q）；
 * 6. 数据体检 —— 结论有没有被漏复权/停牌/缺口污染。
 *
 * 另外两块交互：消融分析（哪条子条件该删）与跨条件排行榜。
 */
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import {
  getAnalysisAblation,
  getAnalysisLeaderboard,
  startAnalysisAblation,
  type AnalysisAblation,
  type AnalysisAblationVariant,
  type AnalysisLeaderboard,
  type AnalysisReport,
} from '@/lib/analysis-api'
import { LineChart } from './AnalysisCharts'

export const ANALYSIS_EVALUATION_TEXTS_ZH = {
  title: '评估细节',
  hint: '六项独立检验：任何一项过不了，这个条件都不能直接拿去用',
  costTitle: '成本敏感性',
  costHint: '同一个信号在不同往返成本下的按日平均超额；微盘的正超额经常在 0.4% 就消失',
  costUnavailable: '这个任务没有可执行口径（老任务），无法做成本敏感性',
  costHead: { level: '成本假设', horizon: '超额（pp）' },
  horizonCell: (days: number) => `${days} 日`,
  entryTitle: '入场假设',
  entryHint: '同一批信号只换成交价。信号日收盘那行是上界参考（实际买不到），后面三行才是可执行的',
  entryHead: { base: '入场', win: '胜率', excess: '超额', ci: '95% 区间', n: '样本' },
  entryUnavailable: '不可用（这个任务没有对应的价格列）',
  portfolioTitle: '组合容量模拟',
  portfolioHint: (k: number, h: number) =>
    `每天按成交额取前 ${k} 只、等权、持有 ${h} 个交易日；虚线为同一规则下的随机买入`,
  portfolioSignal: '条件',
  portfolioControl: '随机',
  portfolioMetrics: {
    annual: '年化（条件）',
    benchmark: '年化（随机）',
    excess: '年化超额',
    mdd: '最大回撤',
    sharpe: '夏普',
    positions: '日均持仓',
    use: '资金利用率',
    idle: '空仓天数',
    traded: '成交笔数',
  },
  portfolioUnavailable: '没有足够的可执行口径数据',
  attributionTitle: '因子归因',
  attributionHint: '控制市值/成交额/换手/振幅/上市年限/行业/年份后，条件自己还剩多少',
  attributionRaw: '原始超额',
  attributionAdjusted: '控制后超额',
  attributionExplained: '被这些变量解释掉',
  attributionFeature: '主要解释变量（每 1 个标准差的边际贡献）',
  attributionSignal: (z: string, p: string) => `条件自身（控制后）z=${z} · p=${p}`,
  attributionHead: { name: '变量', pp: '边际(pp)', z: 'z', p: 'p' },
  attributionUnavailable: '样本不足或缺少横截面字段，无法归因',
  attributionMissing: '对照组没有横截面数据（老任务未回填），无法做因子归因',
  heterogeneityTitle: '年度异质性',
  heterogeneityHint: "Cochran's Q 检验逐年超额是否一致；p < 0.05 = 优势只集中在少数年份",
  heterogeneityConsistent: '逐年一致（没有证据说明只在某几年有效）',
  heterogeneityInconsistent: '逐年不一致（优势集中在部分年份，需要看是哪几年）',
  heterogeneityHead: { year: '年份', effect: '超额', se: '标准误', days: '交易日' },
  heterogeneityEmpty: '区间不足两年，无法检验年度异质性',
  healthTitle: '数据体检',
  healthHint: '这些行如果占比过高，胜率本身会被污染，任何结论都要打折扣',
  healthScore: (score: number) => `健康分 ${score}`,
  healthLevel: { good: '良好', warn: '有疑点', bad: '差' },
  healthPolluted: '异常涨跌幅超过 1%：结论可能被数据污染，先查数据源',
  healthItems: {
    extreme: (n: number, rate: string) => `异常涨跌幅 ${n} 条（${rate}%）`,
    resume: (n: number) => `停牌后跳空 ${n} 条`,
    zeroAmount: (n: number) => `有价无量 ${n} 条`,
    adj: (n: number) => `缺复权因子 ${n} 条`,
    unverifiable: (n: number) => `不可验证 ${n} 条`,
    unfillable: (n: number) => `一字涨停买不进 ${n} 条`,
    gaps: (n: number) => `日历缺口 ${n} 处`,
  },
  healthClean: '四项检查都没有发现问题',
  ablationTitle: '消融分析',
  ablationHint: '逐条拿掉子条件、把数值参数 ±1，看超额怎么变；「建议删」= 拿掉之后超额上升',
  ablationStart: '开始消融分析',
  ablationRestart: '重新跑',
  ablationRunning: (done: number, total: number, current: string | null) =>
    `正在跑 ${done}/${total}${current ? `：${current}` : ''}（约 10–30 分钟，页面可以关）`,
  ablationHead: { variant: '变体', win: '胜率', excess: '超额', delta: '相对原条件', advice: '建议' },
  ablationAdvice: { baseline: '原条件', drop: '建议删', keep: '建议保留', neutral: '无差别', unknown: '—' },
  ablationEmpty: '还没跑过。约 40 个抽样交易日 × 最多 14 个变体，跑完会给出「该删哪一条」。',
  ablationFailed: (message: string) => `消融失败：${message}`,
  leaderboardOpen: '条件排行榜',
  leaderboardTitle: '跨条件排行榜',
  leaderboardHint: '同一口径（同成本、同按日聚合、同主周期）比较所有已完成任务',
  leaderboardWarn: (value: string) =>
    `注意：${value}pp 是「全都没有优势」时 N 个候选里最大值的期望。第一名没超过它，就不能算真的有效。`,
  leaderboardHead: {
    rank: '#', preset: '条件', period: '区间', hits: '命中', excess: '超额', ci: '95% 区间',
    caliber: '口径', verdict: '判断',
  },
  leaderboardCaliber: { exec: '次日开盘', close: '收盘(老任务)' },
  leaderboardMixedExcluded: '列表里混了两种口径（老任务按收盘价买入、没扣成本），不能直接比大小：先看「口径」列。',
  leaderboardVerdict: { up: '显著更高', down: '显著更低', flat: '不显著' },
  leaderboardEmpty: '还没有已完成的任务',
  pp: (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}pp`,
  pct: (value: number) => `${value.toFixed(1)}%`,
  close: '关闭',
}

function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}

function signed(value: number | null | undefined, digits = 2, unit = 'pp'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}${unit}`
}

function tone(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'text-muted-foreground'
  if (value > 0.5) return 'text-emerald-500'
  if (value < -0.5) return 'text-rose-500'
  return 'text-muted-foreground'
}

export function AnalysisEvaluation({ report, runId }: { report: AnalysisReport; runId: string }) {
  const T = ANALYSIS_EVALUATION_TEXTS_ZH
  const horizons = report.horizons ?? []
  const cost = report.cost_sensitivity
  const entry = report.entry ?? []
  const portfolio = report.portfolio
  const attribution = report.attribution
  const heterogeneity = report.heterogeneity
  const health = report.quality?.health

  return (
    <div className="space-y-4" data-fork-analysis-evaluation>
      <header className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold">{T.title}</h3>
        <span className="text-[10px] text-muted-foreground">{T.hint}</span>
      </header>

      {/* ------------------------------------------------ 成本敏感性 */}
      <section className="space-y-1.5" data-fork-eval="cost">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.costTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.costHint}</span>
        </div>
        {cost?.available && cost.levels.length > 0 ? (
          <div className="overflow-x-auto scrollbar">
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-normal">{T.costHead.level}</th>
                  {horizons.map(horizon => (
                    <th key={horizon} className="py-1 text-right font-normal">
                      {T.horizonCell(horizon)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cost.levels.map(level => (
                  <tr key={level.key} className="border-t border-border/50">
                    <td className="py-1">{level.label}</td>
                    {horizons.map(horizon => {
                      const value = level.horizons[String(horizon)]
                      return (
                        <td key={horizon} className={`py-1 text-right tabular-nums ${tone(value)}`}>
                          {signed(value)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{T.costUnavailable}</p>
        )}
      </section>

      {/* ------------------------------------------------ 入场假设 */}
      <section className="space-y-1.5" data-fork-eval="entry">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.entryTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.entryHint}</span>
        </div>
        <table className="w-full text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">{T.entryHead.base}</th>
              <th className="py-1 text-right font-normal">{T.entryHead.win}</th>
              <th className="py-1 text-right font-normal">{T.entryHead.excess}</th>
              <th className="py-1 text-right font-normal">{T.entryHead.ci}</th>
              <th className="py-1 text-right font-normal">{T.entryHead.n}</th>
            </tr>
          </thead>
          <tbody>
            {entry.map(row => (
              <tr key={row.base} className="border-t border-border/50">
                <td className={`py-1 ${row.executable ? '' : 'text-muted-foreground'}`}>{row.label}</td>
                <td className="py-1 text-right tabular-nums">
                  {row.available ? `${fmt(row.win_rate)}%` : T.entryUnavailable}
                </td>
                <td className={`py-1 text-right tabular-nums ${tone(row.excess_pp)}`}>
                  {row.available ? signed(row.excess_pp) : '—'}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">
                  {row.available ? `[${fmt(row.ci_low_pp)}, ${fmt(row.ci_high_pp)}]` : '—'}
                </td>
                <td className="py-1 text-right tabular-nums">{row.n ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------ 组合模拟 */}
      <section className="space-y-1.5" data-fork-eval="portfolio">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.portfolioTitle}</h4>
          {portfolio?.config && (
            <span className="text-[10px] text-muted-foreground">
              {T.portfolioHint(portfolio.config.top_k, portfolio.config.hold_days)}
            </span>
          )}
        </div>
        {portfolio?.signal?.metrics?.days ? (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-4">
              <Cell label={T.portfolioMetrics.annual} detail={`${fmt(portfolio.signal.metrics.annualised_pct)}%`} />
              <Cell label={T.portfolioMetrics.benchmark}
                detail={`${fmt(portfolio.control?.metrics?.annualised_pct)}%`} />
              <Cell label={T.portfolioMetrics.excess} detail={signed(portfolio.annualised_excess_pp)} />
              <Cell label={T.portfolioMetrics.mdd} detail={`${fmt(portfolio.signal.metrics.max_drawdown_pct)}%`} />
              <Cell label={T.portfolioMetrics.sharpe} detail={`${fmt(portfolio.signal.metrics.sharpe)}`} />
              <Cell label={T.portfolioMetrics.positions}
                detail={`${fmt(portfolio.signal.metrics.avg_positions, 1)} / ${portfolio.config?.top_k ?? '—'}`} />
              <Cell label={T.portfolioMetrics.use} detail={`${fmt(portfolio.signal.metrics.capital_use_pct, 1)}%`} />
              <Cell label={T.portfolioMetrics.idle} detail={`${portfolio.signal.metrics.idle_days ?? 0}`} />
            </div>
            <PortfolioCurve portfolio={portfolio} />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{T.portfolioUnavailable}</p>
        )}
      </section>

      {/* ------------------------------------------------ 因子归因 */}
      <section className="space-y-1.5" data-fork-eval="attribution">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.attributionTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.attributionHint}</span>
        </div>
        {attribution?.raw_excess_pp != null ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
              <span>
                {T.attributionRaw} <b className={tone(attribution.raw_excess_pp)}>{signed(attribution.raw_excess_pp)}</b>
              </span>
              <span>
                {T.attributionAdjusted}{' '}
                <b className={tone(attribution.adjusted_excess_pp)}>{signed(attribution.adjusted_excess_pp)}</b>
              </span>
              <span className="text-muted-foreground">
                {T.attributionExplained} {fmt(attribution.explained_pct, 1)}%
              </span>
              {attribution.signal_z != null && (
                <span className="text-muted-foreground">
                  {T.attributionSignal(fmt(attribution.signal_z), fmt(attribution.signal_p, 3))}
                </span>
              )}
            </div>
            {(attribution.features ?? []).length > 0 && (
              <table className="w-full max-w-[520px] text-[11px]">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 text-left font-normal">{T.attributionHead.name}</th>
                    <th className="py-1 text-right font-normal">{T.attributionHead.pp}</th>
                    <th className="py-1 text-right font-normal">{T.attributionHead.z}</th>
                    <th className="py-1 text-right font-normal">{T.attributionHead.p}</th>
                  </tr>
                </thead>
                <tbody>
                  {(attribution.features ?? []).slice(1, 7).map(feature => (
                    <tr key={feature.name} className="border-t border-border/50">
                      <td className="py-1">{feature.name}</td>
                      <td className={`py-1 text-right tabular-nums ${tone(feature.pp)}`}>{signed(feature.pp)}</td>
                      <td className="py-1 text-right tabular-nums">{fmt(feature.z)}</td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">{fmt(feature.p, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {attribution?.note === 'cross_section_missing' ? T.attributionMissing : T.attributionUnavailable}
          </p>
        )}
      </section>

      {/* ------------------------------------------------ 年度异质性 */}
      <section className="space-y-1.5" data-fork-eval="heterogeneity">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.heterogeneityTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.heterogeneityHint}</span>
        </div>
        {(heterogeneity?.rows ?? []).length > 0 ? (
          <div className="space-y-1">
            <p className="text-[11px]">
              {heterogeneity?.consistent === false ? T.heterogeneityInconsistent : T.heterogeneityConsistent}
              <span className="ml-2 text-muted-foreground">
                Q={fmt(heterogeneity?.q, 2)} · p={fmt(heterogeneity?.p, 3)} · I²={fmt(heterogeneity?.i2, 1)}%
              </span>
            </p>
            <table className="w-full max-w-[520px] text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-normal">{T.heterogeneityHead.year}</th>
                  <th className="py-1 text-right font-normal">{T.heterogeneityHead.effect}</th>
                  <th className="py-1 text-right font-normal">{T.heterogeneityHead.se}</th>
                  <th className="py-1 text-right font-normal">{T.heterogeneityHead.days}</th>
                </tr>
              </thead>
              <tbody>
                {(heterogeneity?.rows ?? []).map(row => (
                  <tr key={row.year} className="border-t border-border/50">
                    <td className="py-1">{row.year}</td>
                    <td className={`py-1 text-right tabular-nums ${tone(row.effect_pp)}`}>
                      {signed(row.effect_pp)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-muted-foreground">{fmt(row.se_pp)}</td>
                    <td className="py-1 text-right tabular-nums">{row.days}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{T.heterogeneityEmpty}</p>
        )}
      </section>

      {/* ------------------------------------------------ 数据体检 */}
      <section className="space-y-1.5" data-fork-eval="health">
        <div className="flex items-baseline gap-2">
          <h4 className="text-[12px] font-medium">{T.healthTitle}</h4>
          <span className="text-[10px] text-muted-foreground">{T.healthHint}</span>
        </div>
        {health ? (
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
              <span
                className={
                  health.level === 'good'
                    ? 'text-emerald-500'
                    : health.level === 'warn'
                      ? 'text-amber-500'
                      : 'text-rose-500'
                }
              >
                {T.healthScore(health.score)} · {T.healthLevel[health.level]}
              </span>
              <span className="text-muted-foreground">
                {T.healthItems.extreme(health.extreme_rows, fmt(health.extreme_rate))}
              </span>
              <span className="text-muted-foreground">{T.healthItems.resume(health.resume_jump_rows)}</span>
              <span className="text-muted-foreground">{T.healthItems.zeroAmount(health.zero_amount_rows)}</span>
              <span className="text-muted-foreground">{T.healthItems.adj(health.adj_missing_rows)}</span>
              <span className="text-muted-foreground">{T.healthItems.unverifiable(health.unverifiable)}</span>
              <span className="text-muted-foreground">{T.healthItems.unfillable(health.unfillable)}</span>
              <span className="text-muted-foreground">{T.healthItems.gaps(health.gap_count)}</span>
            </p>
            {health.polluted && <p className="text-[11px] text-rose-500">{T.healthPolluted}</p>}
            {health.samples.length > 0 && (
              <table className="w-full max-w-[520px] text-[11px]">
                <tbody>
                  {health.samples.slice(0, 5).map(sample => (
                    <tr key={`${sample.d0}-${sample.code}`} className="border-t border-border/50">
                      <td className="py-1">{sample.d0}</td>
                      <td className="py-1">{sample.code}</td>
                      <td className="py-1 text-right tabular-nums text-rose-500">{signed(sample.r1, 2, '%')}</td>
                      <td className="py-1 text-right tabular-nums text-muted-foreground">
                        {sample.stale_days}d / {sample.adj_missing}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{T.healthClean}</p>
        )}
      </section>

      <AblationSection runId={runId} defaultHorizon={report.primary_horizon ?? 10} />
    </div>
  )
}

function adviceLabel(advice: AnalysisAblationVariant['advice']): string {
  const T = ANALYSIS_EVALUATION_TEXTS_ZH
  if (advice === 'drop') return T.ablationAdvice.drop
  if (advice === 'keep') return T.ablationAdvice.keep
  if (advice === 'baseline') return T.ablationAdvice.baseline
  if (advice === 'neutral') return T.ablationAdvice.neutral
  return T.ablationAdvice.unknown
}

function Cell({ label, detail }: { label: string; detail: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="tabular-nums">{detail}</p>
    </div>
  )
}

function PortfolioCurve({ portfolio }: { portfolio: NonNullable<AnalysisReport['portfolio']> }) {
  const T = ANALYSIS_EVALUATION_TEXTS_ZH
  const signal = portfolio.signal?.equity ?? []
  if (signal.length < 2) return null
  const step = Math.max(1, Math.ceil(signal.length / 16))
  const pick = signal.filter((_point, index) => index % step === 0)
  const points = pick.map(point => ({ x: point.d0.slice(2, 7), y: (point.value - 1) * 100 }))
  const controlPoints = (portfolio.control?.equity ?? [])
    .filter((_point, index) => index % step === 0)
    .map(point => ({ x: point.d0.slice(2, 7), y: (point.value - 1) * 100 }))
  const values = [...points, ...controlPoints].map(point => point.y)
  const maxValue = Math.max(10, ...values) + 5
  const minValue = Math.min(-10, ...values) - 5
  return (
    <LineChart
      series={[
        { name: T.portfolioSignal, points, color: 'rgb(16 185 129)' },
        { name: T.portfolioControl, points: controlPoints, color: 'rgb(148 163 184)' },
      ]}
      height={150}
      width={320}
      minValue={minValue}
      maxValue={maxValue}
    />
  )
}

function AblationSection({ runId, defaultHorizon }: { runId: string; defaultHorizon: number }) {
  const T = ANALYSIS_EVALUATION_TEXTS_ZH
  const [data, setData] = useState<AnalysisAblation | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const payload = await getAnalysisAblation(runId)
      setData(payload)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    }
  }, [runId])

  useEffect(() => {
    void load()
  }, [load])

  const running = data?.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(timer)
  }, [running, load])

  const start = async () => {
    setStarting(true)
    setError(null)
    try {
      const payload = await startAnalysisAblation(runId, { sampleDays: 40, horizon: defaultHorizon })
      setData(payload)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setStarting(false)
    }
  }

  const variants = data?.variants ?? []
  return (
    <section className="space-y-1.5" data-fork-eval="ablation">
      <div className="flex flex-wrap items-baseline gap-2">
        <h4 className="text-[12px] font-medium">{T.ablationTitle}</h4>
        <span className="text-[10px] text-muted-foreground">{T.ablationHint}</span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto h-7 px-2 text-[12px]"
          disabled={running || starting}
          onClick={() => void start()}
        >
          {variants.length > 0 ? T.ablationRestart : T.ablationStart}
        </Button>
      </div>
      {error && <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>}
      {data?.status === 'failed' && data.error && (
        <p className="text-[11px] text-rose-500">{T.ablationFailed(data.error)}</p>
      )}
      {running && data?.progress && (
        <p className="text-[11px] text-muted-foreground">
          {T.ablationRunning(data.progress.done, data.progress.total, data.progress.current)}
        </p>
      )}
      {variants.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{T.ablationEmpty}</p>
      ) : (
        <table className="w-full text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">{T.ablationHead.variant}</th>
              <th className="py-1 text-right font-normal">{T.ablationHead.win}</th>
              <th className="py-1 text-right font-normal">{T.ablationHead.excess}</th>
              <th className="py-1 text-right font-normal">{T.ablationHead.delta}</th>
              <th className="py-1 text-right font-normal">{T.ablationHead.advice}</th>
            </tr>
          </thead>
          <tbody>
            {variants.map(variant => (
              <tr key={variant.key} className="border-t border-border/50">
                <td className="py-1">{variant.label}</td>
                <td className="py-1 text-right tabular-nums">{fmt(variant.win_rate)}%</td>
                <td className={`py-1 text-right tabular-nums ${tone(variant.excess_pp)}`}>
                  {signed(variant.excess_pp)}
                </td>
                <td className={`py-1 text-right tabular-nums ${tone(variant.delta_pp)}`}>
                  {variant.kind === 'base' ? '—' : signed(variant.delta_pp)}
                </td>
                <td className="py-1 text-right">{adviceLabel(variant.advice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

export function AnalysisLeaderboardDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const T = ANALYSIS_EVALUATION_TEXTS_ZH
  const [data, setData] = useState<AnalysisLeaderboard | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    getAnalysisLeaderboard(40)
      .then(setData)
      .catch((exc: unknown) => setError(exc instanceof Error ? exc.message : String(exc)))
  }, [open])

  const items = data?.items ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[860px]" data-fork-analysis-leaderboard>
        <DialogHeader>
          <DialogTitle>{T.leaderboardTitle}</DialogTitle>
          <DialogDescription>{T.leaderboardHint}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-2 overflow-y-auto scrollbar pr-1">
          {error && <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">{error}</p>}
          {data?.mixed && <p className="text-[11px] text-amber-500">{T.leaderboardMixedExcluded}</p>}
          {data?.expected_max_pp != null && (
            <p className="text-[11px] text-amber-500">{T.leaderboardWarn(fmt(data.expected_max_pp))}</p>
          )}
          {items.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{T.leaderboardEmpty}</p>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-1 text-left font-normal">{T.leaderboardHead.rank}</th>
                  <th className="py-1 text-left font-normal">{T.leaderboardHead.preset}</th>
                  <th className="py-1 text-left font-normal">{T.leaderboardHead.period}</th>
                  <th className="py-1 text-right font-normal">{T.leaderboardHead.hits}</th>
                  <th className="py-1 text-right font-normal">{T.leaderboardHead.excess}</th>
                  <th className="py-1 text-right font-normal">{T.leaderboardHead.ci}</th>
                  <th className="py-1 text-center font-normal">{T.leaderboardHead.caliber}</th>
                  <th className="py-1 text-right font-normal">{T.leaderboardHead.verdict}</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.run_id} className="border-t border-border/50">
                    <td className="py-1 tabular-nums">{item.rank}</td>
                    <td className="py-1">{item.preset}</td>
                    <td className="py-1 text-muted-foreground">
                      {item.start_date} ~ {item.end_date}
                    </td>
                    <td className="py-1 text-right tabular-nums">{item.hits}</td>
                    <td className={`py-1 text-right tabular-nums ${tone(item.excess_pp)}`}>
                      {signed(item.excess_pp)}
                    </td>
                    <td className="py-1 text-right tabular-nums text-muted-foreground">
                      [{fmt(item.ci_low_pp)}, {fmt(item.ci_high_pp)}]
                    </td>
                    <td className="py-1 text-center text-muted-foreground">
                      {T.leaderboardCaliber[item.caliber]}
                    </td>
                    <td className="py-1 text-right">
                      {item.significant_up
                        ? T.leaderboardVerdict.up
                        : item.significant_down
                          ? T.leaderboardVerdict.down
                          : T.leaderboardVerdict.flat}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
