/**
 * 「深度分析2」独立页（/dsa2/:symbol）—— 从分析页那颗 BrainCircuit 按钮在新窗口打开。
 *
 * 界面按 daily_stock_analysis 的报告页复刻，只保留截图里红框那一块：
 *   头部（名称/价格/涨跌/代码/市场阶段/时间 + 重新分析）
 *   核心洞察 → 数据缺口提示 → 操作建议 + 趋势预测 → 板块联动 → 策略点位四卡
 *   右栏：市场情绪（恐慌贪婪指数环）
 *
 * 数据全部来自本站 fork 接口 ``/api/stocks/dsa/*``：行情取本机 MySQL，板块/资金流/
 * 新闻取东财公开接口，模型取库里已配置的 AI service。**不依赖内网那个 DSA 服务**
 * （云端到内网没有路由，且它没有按标的的深链）。
 *
 * 为什么固定深色：这一页是「终端风」的分析面板，跟主应用的明暗主题无关；截图就是
 * 深色，改成跟随主题反而对不上。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Loader2, RefreshCw, Sparkles, Target, TrendingUp, Zap } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { marketSignTextClass } from '@/lib/market-colors'
import {
  DSA_POLL_MS,
  analyzeDsa,
  getDsaLatest,
  getDsaReport,
  type DsaReportRow,
} from '@/lib/dsa-api'

export const DSA2_TEXTS_ZH = {
  title: '深度分析2',
  loadFailed: (message: string) => `读取报告失败：${message}`,
  running: '正在生成决策报告…',
  runningHint: '取数 + 大模型分析，通常 1~3 分钟。可以关掉这个窗口，稍后从原页面再打开会读到同一份结果。',
  elapsed: (seconds: number) => `已用 ${seconds} 秒`,
  retry: '重新分析',
  coreInsight: '核心洞察',
  advice: '操作建议',
  trend: '趋势预测',
  sectors: '板块联动',
  sectorsEmpty: '未取到板块归属',
  sniper: '策略点位',
  idealBuy: '理想买入',
  secondaryBuy: '二次买入',
  stopLoss: '止损价位',
  takeProfit: '止盈目标',
  sentiment: '市场情绪',
  sentimentIndex: '恐慌贪婪指数',
  noValue: '暂无',
  marketPhase: (label: string) => `市场阶段: CN · ${label}`,
  modelLine: (model: string, at: string) => `模型 ${model} · 生成于 ${at}`,
  limitations: '数据缺口',
  confidence: (level: string) => `置信度 ${level}`,
  riskTitle: '风险提示',
  asof: (date: string) => `行情日期 ${date}`,
  dataSources: (sources: string) => `数据源：${sources}`,
  failed: '分析失败',
  empty: '还没有分析结果',
  start: '开始分析',
}

const CARD = 'rounded-2xl border border-cyan-500/20 bg-[#0b1220]/80 shadow-[0_0_0_1px_rgba(34,211,238,0.06)]'

function formatTime(value?: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatPrice(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(2)
}

function formatPct(value?: number | null): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

/** 情绪环：分数越高越「贪婪」，配色从恐惧的紫蓝渐变到贪婪的橙红。 */
function SentimentRing({ score, label }: { score?: number | null; label?: string | null }) {
  const text = DSA2_TEXTS_ZH
  const value = typeof score === 'number' && Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null
  const radius = 52
  const circumference = 2 * Math.PI * radius
  const ratio = value === null ? 0 : value / 100
  return (
    <div className="flex flex-col items-center gap-2">
      <svg viewBox="0 0 128 128" className="h-32 w-32" role="img" aria-label={text.sentimentIndex}>
        <defs>
          <linearGradient id="dsa2-gauge" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#38bdf8" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <circle cx="64" cy="64" r={radius} fill="none" stroke="#1e293b" strokeWidth="10" />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          stroke="url(#dsa2-gauge)"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform="rotate(-90 64 64)"
          style={{ filter: 'drop-shadow(0 0 6px rgba(56,189,248,0.55))' }}
        />
        <text x="64" y="70" textAnchor="middle" className="fill-white text-[26px] font-semibold">
          {value === null ? '—' : Math.round(value)}
        </text>
      </svg>
      <span className="text-sm text-slate-300">{label || text.noValue}</span>
    </div>
  )
}

function SniperCard({ label, value, tone }: { label: string; value?: string | null; tone: string }) {
  return (
    <div className={`${CARD} p-4`} data-dsa2-sniper={label}>
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`mt-2 text-sm leading-relaxed ${tone}`}>{value || DSA2_TEXTS_ZH.noValue}</div>
    </div>
  )
}

export default function ForkDsa2Page() {
  const text = DSA2_TEXTS_ZH
  const { symbol = '' } = useParams()
  const [search] = useSearchParams()
  const nameHint = search.get('name') || ''
  const [row, setRow] = useState<DsaReportRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<number | null>(null)

  const startAnalysis = useCallback(async () => {
    setStarting(true)
    setError(null)
    try {
      const started = await analyzeDsa(symbol, nameHint)
      setRow(started)
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setStarting(false)
    }
  }, [nameHint, symbol])

  // 首次进入：有历史结果就直接用（done 也照样展示，并在下方标生成时间）；
  // 没有才起新任务。running 直接进轮询。
  useEffect(() => {
    let cancelled = false
    if (!symbol) return
    setRow(null)
    setError(null)
    getDsaLatest(symbol)
      .then(latest => {
        if (cancelled) return
        if (latest && latest.status !== 'none') {
          setRow(latest)
        } else {
          void startAnalysis()
        }
      })
      .catch(exc => {
        if (!cancelled) setError(exc instanceof Error ? exc.message : String(exc))
      })
    return () => {
      cancelled = true
    }
  }, [symbol, startAnalysis])

  // 轮询：只在 running 时跑，done/failed 立刻停，避免空转。
  useEffect(() => {
    if (!row || row.status !== 'running' || row.id === null) return
    const id = row.id
    const poll = window.setInterval(() => {
      getDsaReport(id)
        .then(next => setRow(next))
        .catch(exc => setError(exc instanceof Error ? exc.message : String(exc)))
    }, DSA_POLL_MS)
    return () => window.clearInterval(poll)
  }, [row])

  // running 计时（只做展示，不参与判断）
  useEffect(() => {
    if (row?.status !== 'running') {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      timerRef.current = null
      return
    }
    setElapsed(0)
    timerRef.current = window.setInterval(() => setElapsed(v => v + 1), 1000)
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [row?.status, row?.id])

  const report = row?.report ?? null
  const meta = report?.meta ?? {}
  const summary = report?.summary ?? {}
  const strategy = report?.strategy ?? {}
  const details = report?.details ?? {}

  const stockName = meta.stock_name || row?.name || nameHint || symbol
  const changeTone = marketSignTextClass(meta.change_pct)
  const limitations = details.limitations ?? []
  const sectors = details.sectors ?? []

  const adviceTone = useMemo(() => {
    const advice = summary.operation_advice || ''
    if (/买入|加仓/.test(advice)) return 'text-market-up'
    if (/卖出|减仓/.test(advice)) return 'text-market-down'
    return 'text-amber-300'
  }, [summary.operation_advice])

  const trendTone = useMemo(() => {
    const trend = summary.trend_prediction || ''
    if (/看多/.test(trend)) return 'text-market-up'
    if (/看空/.test(trend)) return 'text-market-down'
    return 'text-slate-200'
  }, [summary.trend_prediction])

  return (
    <div className="min-h-screen bg-[#05080f] px-4 py-6 text-slate-200 md:px-8" data-dsa2-page={symbol}>
      <div className="mx-auto flex max-w-6xl flex-col gap-5">
        {/* 头部 */}
        <header className={`${CARD} flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between`}>
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold text-white">{stockName}</h1>
              <span className="text-2xl font-semibold text-market-up">{formatPrice(meta.current_price)}</span>
              <span className={`text-lg font-medium ${changeTone}`}>{formatPct(meta.change_pct)}</span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className="rounded-md border border-cyan-500/25 px-2 py-0.5 font-mono text-cyan-300">
                {meta.stock_code || symbol}
              </span>
              {meta.market_phase_label ? (
                <span className="rounded-md border border-slate-700 px-2 py-0.5">
                  {text.marketPhase(meta.market_phase_label)}
                </span>
              ) : null}
              <span>{formatTime(meta.created_at || row?.created_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
              onClick={() => void startAnalysis()}
              disabled={starting || row?.status === 'running'}
            >
              {starting || row?.status === 'running' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {text.retry}
            </Button>
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {text.loadFailed(error)}
          </div>
        ) : null}

        {/* 运行中 / 失败 / 空 */}
        {row?.status === 'running' ? (
          <div className={`${CARD} flex flex-col items-center gap-3 p-10 text-center`} data-dsa2-running>
            <Loader2 className="h-6 w-6 animate-spin text-cyan-300" />
            <div className="text-base text-slate-100">{text.running}</div>
            <div className="max-w-lg text-xs leading-relaxed text-slate-400">{text.runningHint}</div>
            <div className="text-xs text-slate-500">{text.elapsed(elapsed)}</div>
          </div>
        ) : null}

        {row?.status === 'failed' ? (
          <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-4 text-sm text-rose-200">
            <div className="font-medium">{text.failed}</div>
            <div className="mt-1 text-rose-300/80">{row.error || text.noValue}</div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 border-rose-700 text-rose-200 hover:bg-rose-900/40"
              onClick={() => void startAnalysis()}
            >
              {text.retry}
            </Button>
          </div>
        ) : null}

        {report ? (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
            {/* 左栏 */}
            <div className="flex flex-col gap-5">
              <section className={`${CARD} p-5`} data-dsa2-core>
                <h2 className="flex items-center gap-2 text-sm font-medium text-cyan-300">
                  <Sparkles className="h-4 w-4" />
                  {text.coreInsight}
                </h2>
                <p className="mt-3 text-sm leading-7 text-slate-200">
                  {summary.analysis_summary || summary.one_sentence || text.noValue}
                </p>
                {summary.one_sentence && summary.analysis_summary ? (
                  <p className="mt-2 text-xs text-slate-400">{summary.one_sentence}</p>
                ) : null}
              </section>

              {limitations.length ? (
                <div className="flex items-start gap-2 rounded-xl border border-amber-700/40 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <div className="font-medium">{text.limitations}</div>
                    <div className="mt-1 leading-relaxed">{limitations.join('；')}</div>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-4">
                <div className={`${CARD} p-4`} data-dsa2-advice>
                  <div className="text-xs text-slate-400">{text.advice}</div>
                  <div className={`mt-2 text-2xl font-semibold ${adviceTone}`}>
                    {summary.action_label || summary.operation_advice || text.noValue}
                  </div>
                  {summary.confidence_level ? (
                    <div className="mt-1 text-[11px] text-slate-500">{text.confidence(summary.confidence_level)}</div>
                  ) : null}
                </div>
                <div className={`${CARD} p-4`} data-dsa2-trend>
                  <div className="text-xs text-slate-400">{text.trend}</div>
                  <div className={`mt-2 text-2xl font-semibold ${trendTone}`}>
                    {summary.trend_prediction || text.noValue}
                  </div>
                  {summary.time_sensitivity ? (
                    <div className="mt-1 text-[11px] text-slate-500">{summary.time_sensitivity}</div>
                  ) : null}
                </div>
              </div>

              <section className={`${CARD} p-5`} data-dsa2-sectors>
                <h2 className="flex items-center gap-2 text-sm font-medium text-cyan-300">
                  <Zap className="h-4 w-4" />
                  {text.sectors}
                </h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {sectors.length ? (
                    sectors.map(tag => (
                      <span
                        key={tag}
                        className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1 text-xs text-slate-300"
                      >
                        {tag}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-slate-500">{text.sectorsEmpty}</span>
                  )}
                </div>
              </section>

              <section className={`${CARD} p-5`} data-dsa2-sniper>
                <h2 className="flex items-center gap-2 text-sm font-medium text-cyan-300">
                  <Target className="h-4 w-4" />
                  {text.sniper}
                </h2>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <SniperCard label={text.idealBuy} value={strategy.ideal_buy} tone="text-market-up" />
                  <SniperCard label={text.secondaryBuy} value={strategy.secondary_buy} tone="text-cyan-300" />
                  <SniperCard label={text.stopLoss} value={strategy.stop_loss} tone="text-market-down" />
                  <SniperCard label={text.takeProfit} value={strategy.take_profit} tone="text-amber-300" />
                </div>
              </section>

              {summary.risk_warning ? (
                <section className={`${CARD} p-5`} data-dsa2-risk>
                  <h2 className="flex items-center gap-2 text-sm font-medium text-amber-300">
                    <AlertTriangle className="h-4 w-4" />
                    {text.riskTitle}
                  </h2>
                  <p className="mt-2 text-xs leading-relaxed text-slate-300">{summary.risk_warning}</p>
                </section>
              ) : null}
            </div>

            {/* 右栏 */}
            <aside className="flex flex-col gap-5">
              <section className={`${CARD} p-5 text-center`} data-dsa2-sentiment>
                <h2 className="flex items-center justify-center gap-2 text-sm font-medium text-cyan-300">
                  <TrendingUp className="h-4 w-4" />
                  {text.sentiment}
                </h2>
                <div className="mt-1 text-[11px] text-slate-500">{text.sentimentIndex}</div>
                <div className="mt-3 flex justify-center">
                  <SentimentRing score={summary.sentiment_score} label={summary.sentiment_label} />
                </div>
              </section>

              <section className={`${CARD} p-4 text-[11px] leading-relaxed text-slate-500`}>
                <div>
                  {text.modelLine(
                    meta.model_used || row?.model_used || '—',
                    formatTime(meta.created_at || row?.created_at),
                  )}
                </div>
                {meta.asof ? <div className="mt-1">{text.asof(meta.asof)}</div> : null}
                {details.data_sources?.length ? (
                  <div className="mt-1">{text.dataSources(details.data_sources.join('、'))}</div>
                ) : null}
              </section>
            </aside>
          </div>
        ) : null}

        {row && row.status !== 'running' && row.status !== 'failed' && !report ? (
          <div className={`${CARD} flex flex-col items-center gap-3 p-10 text-center`}>
            <div className="text-sm text-slate-300">{text.empty}</div>
            <Button size="sm" onClick={() => void startAnalysis()}>
              {text.start}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
