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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ListOrdered,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  TrendingUp,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { marketSignTextClass } from '@/lib/market-colors'
import {
  DSA_POLL_MS,
  DSA_QUEUE_POLL_MS,
  analyzeDsa,
  dsaElapsedSeconds,
  deleteDsaQueueItem,
  formatDsaInstant,
  getDsaLatest,
  getDsaQueue,
  getDsaReport,
  isBeijingCode,
  type DsaQueueSnapshot,
  type DsaReportRow,
  type DsaSource,
  type DsaSourceStatus,
} from '@/lib/dsa-api'

export const DSA2_TEXTS_ZH = {
  title: '深度分析2',
  loadFailed: (message: string) => `读取报告失败：${message}`,
  running: '正在生成决策报告…',
  runningHint: '通常 1~3 分钟；可关掉窗口，稍后再看同一份结果。',
  elapsed: (text: string) => `已用 ${text}`,
  startedAt: (at: string) => `任务开始时间 ${at}`,
  queuedTitle: '排队中',
  queuedHint: (position: number) =>
    `前面还有 ${position} 个任务，轮到你才会开始取数与调用模型。可以关掉这个窗口，稍后回来还是这一份。`,
  queuedNext: '队首，马上开始…',
  queuedSince: (at: string) => `入队时间 ${at}`,
  queue: '队列',
  queueTitle: '深度分析2 队列',
  queueSubtitle: '运行中的任务永远排在第一，其余按入队先后。队列与 PanWatch 的分析任务相互独立。',
  queueEmpty: '队列里没有任务',
  queueRunning: '运行',
  queueWaiting: '等待',
  queuePosition: (position: number) => `前面 ${position} 个`,
  queueDelete: '删除',
  queueDeleteLabel: (symbol: string) => `把 ${symbol} 从队列删除`,
  queueClose: '关闭',
  queueLoadFailed: (message: string) => `读取队列失败：${message}`,
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
  sourcesTitle: '数据源',
  sourcesSubtitle: '本页不含任何需要 apikey 的数据源',
  sourceOk: '已接入',
  sourceEmpty: '无数据',
  sourceUnavailable: '本次未取到',
  sourceUnconfigured: '未配置',
  sourcesFailed: (labels: string, count: number) =>
    `另 ${count} 项本次未取到：${labels}（其余结论不受影响）`,
  bjExcluded: '北交所标的不在股票池内',
  bjHint: '本页只分析沪深 A 股；北交所（bj / 4xx / 8xx / 920xxx）一律排除，不做分析也不排队。',
  backToAnalysis: '返回分析页',
  failed: '分析失败',
  empty: '还没有分析结果',
  start: '开始分析',
  startHint: '这一页不会自动跑分析：点下面的按钮才会取数并调用模型，避免每次刷新页面都重新烧一次。',
}

const CARD = 'rounded-2xl border border-cyan-500/20 bg-[#0b1220]/80 shadow-[0_0_0_1px_rgba(34,211,238,0.06)]'

/** 「已用 1 分 06 秒」——秒数是算出来的，不从 0 起数。 */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes} 分 ${rest} 秒` : `${rest} 秒`
}

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

/** 数据源面板：逐行列出「这个字段是从哪来的 / 有没有配上」。 */
function SourcePanel({ sources }: { sources: DsaSource[] }) {
  const text = DSA2_TEXTS_ZH
  // 用户口径：需要 apikey / 付费源、本页没接的模块不显示（老报告 payload 里还带
  // 这几行 unconfigured，也必须在这里挡掉，不能等重新分析才干净）。
  const visible = sources.filter(item => item.status !== 'unconfigured')
  // 接口超时的模块不逐条报红，折叠成一行安静的汇总，避免面板变成一列失败
  const failed = visible.filter(item => item.status === 'unavailable')
  const rows = visible.filter(item => item.status !== 'unavailable')
  const toneOf = (status: DsaSourceStatus) =>
    status === 'ok'
      ? 'text-emerald-300'
      : status === 'empty'
        ? 'text-slate-400'
        : status === 'unavailable'
          ? 'text-amber-300'
          : 'text-slate-500'
  const labelOf = (item: DsaSource) =>
    item.status === 'ok'
      ? text.sourceOk
      : item.status === 'empty'
        ? item.empty_label || text.sourceEmpty
        : item.status === 'unavailable'
          ? text.sourceUnavailable
          : text.sourceUnconfigured
  const dotOf = (status: DsaSourceStatus) =>
    status === 'ok'
      ? 'bg-emerald-400'
      : status === 'empty'
        ? 'bg-slate-500'
        : status === 'unavailable'
          ? 'bg-amber-400'
          : 'bg-slate-600'

  if (!visible.length) return null

  return (
    <section className={`${CARD} p-4`} data-dsa2-sources>
      <h2 className="text-sm font-medium text-cyan-300">{text.sourcesTitle}</h2>
      <div className="mt-1 text-[11px] text-slate-500">{text.sourcesSubtitle}</div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {rows.map(item => (
          <li
            key={item.key}
            className="flex items-start justify-between gap-2 text-[11px]"
            data-dsa2-source={item.key}
            data-dsa2-source-status={item.status}
          >
            <span className="flex min-w-0 items-start gap-1.5">
              <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${dotOf(item.status)}`} />
              <span className="min-w-0">
                <span className="text-slate-300">{item.label}</span>
                {item.source ? <span className="block text-slate-500">{item.source}</span> : null}
                {item.note && (item.status === 'empty' || !item.source) ? (
                  <span className="block text-slate-600">{item.note}</span>
                ) : null}
              </span>
            </span>
            <span className={`shrink-0 ${toneOf(item.status)}`}>{labelOf(item)}</span>
          </li>
        ))}
      </ul>
      {failed.length ? (
        <div className="mt-2 text-[11px] leading-relaxed text-slate-500" data-dsa2-sources-failed={failed.length}>
          {text.sourcesFailed(failed.map(item => item.label).join('、'), failed.length)}
        </div>
      ) : null}
    </section>
  )
}

/** 队列弹层：运行中的排第一，其余是等待；每项可删。 */
function QueuePanel({
  snapshot,
  error,
  deletingId,
  onClose,
  onDelete,
}: {
  snapshot: DsaQueueSnapshot | null
  error: string | null
  deletingId: number | null
  onClose: () => void
  onDelete: (id: number) => void
}) {
  const text = DSA2_TEXTS_ZH
  const items = snapshot?.items ?? []
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 py-10"
      data-dsa2-queue-overlay
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`${CARD} w-full max-w-xl bg-[#0b1220] p-5`}
        data-dsa2-queue
        role="dialog"
        aria-label={text.queueTitle}
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-cyan-300">{text.queueTitle}</h2>
            <div className="mt-1 text-[11px] text-slate-500">{text.queueSubtitle}</div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-slate-400 hover:text-slate-100"
            onClick={onClose}
            aria-label={text.queueClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-[11px] text-rose-200">
            {text.queueLoadFailed(error)}
          </div>
        ) : null}

        <ul className="mt-4 flex max-h-[60vh] flex-col gap-2 overflow-y-auto scrollbar">
          {items.length === 0 ? (
            <li className="rounded-lg border border-slate-800 px-3 py-6 text-center text-xs text-slate-500">
              {text.queueEmpty}
            </li>
          ) : (
            items.map(item => {
              const running = item.status === 'running'
              const position = item.queue_position ?? 0
              return (
                <li
                  key={item.id ?? item.symbol}
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
                  data-dsa2-queue-item={item.symbol}
                  data-dsa2-queue-status={item.status}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${
                        running
                          ? 'bg-cyan-500/15 text-cyan-300'
                          : 'bg-slate-700/40 text-slate-400'
                      }`}
                    >
                      {running ? text.queueRunning : text.queueWaiting}
                    </span>
                    {/* 名称 / 代码 / 时间压在**一行**：队列扫一眼就够，不该占两行 */}
                    <span className="min-w-0 truncate whitespace-nowrap text-xs text-slate-200">
                      <span className="truncate">{item.name || item.symbol}</span>
                      <span className="ml-2 font-mono text-[11px] text-slate-500">
                        {item.symbol}
                      </span>
                      <span className="ml-2 text-[11px] text-slate-500">
                        {running
                          ? formatDsaInstant(item.started_at)
                          : text.queuePosition(position)}
                      </span>
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-rose-300 hover:bg-rose-950/40 hover:text-rose-200"
                    aria-label={text.queueDeleteLabel(item.symbol)}
                    disabled={item.id === null || deletingId === item.id}
                    onClick={() => item.id !== null && onDelete(item.id)}
                  >
                    {deletingId === item.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    <span className="ml-1 text-[11px]">{text.queueDelete}</span>
                  </Button>
                </li>
              )
            })
          )}
        </ul>
      </div>
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
  const [loaded, setLoaded] = useState(false)
  // 每秒 tick 的「当前时刻」。已用时间由 started_at 算出来，与前端 mount 无关 ——
  // 刷新、换窗口、换浏览器都是同一个数（用户口径）。
  const [now, setNow] = useState(() => Date.now())
  const [queueOpen, setQueueOpen] = useState(false)
  const [queue, setQueue] = useState<DsaQueueSnapshot | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const loadQueue = useCallback(async () => {
    try {
      const snapshot = await getDsaQueue()
      setQueue(snapshot)
      setQueueError(null)
    } catch (exc) {
      setQueueError(exc instanceof Error ? exc.message : String(exc))
    }
  }, [])

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

  // 首次进入：只读历史结果，**绝不自动起任务**（用户口径：新窗口弹出后由人手动点按钮）。
  // 没有历史就停在「开始分析」这一屏；queued/running 直接进轮询。
  useEffect(() => {
    let cancelled = false
    if (!symbol) return
    setRow(null)
    setError(null)
    setLoaded(false)
    // 北交所：不在股票池内，一个请求都不发（后端本来也会 400）
    if (isBeijingCode(symbol)) {
      setLoaded(true)
      return
    }
    getDsaLatest(symbol)
      .then(latest => {
        if (cancelled) return
        if (latest && latest.status !== 'none') {
          setRow(latest)
        }
        setLoaded(true)
      })
      .catch(exc => {
        if (cancelled) return
        setError(exc instanceof Error ? exc.message : String(exc))
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [symbol])

  // 轮询：排队中与运行中都轮询（排到队时要能看到状态变化），done/failed 立刻停。
  useEffect(() => {
    if (!row || (row.status !== 'running' && row.status !== 'queued') || row.id === null) return
    const id = row.id
    const poll = window.setInterval(() => {
      getDsaReport(id)
        .then(next => setRow(next))
        .catch(exc => setError(exc instanceof Error ? exc.message : String(exc)))
    }, DSA_POLL_MS)
    return () => window.clearInterval(poll)
  }, [row])

  // 计时：只在跑着的时候每秒刷新一次 now（不累加秒数，避免刷新后归零）
  useEffect(() => {
    if (row?.status !== 'running') return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [row?.status, row?.id])

  // 队列读取：打开弹层时按固定间隔刷新；关掉就停，不空转。
  useEffect(() => {
    if (!queueOpen) return
    void loadQueue()
    const id = window.setInterval(() => void loadQueue(), DSA_QUEUE_POLL_MS)
    return () => window.clearInterval(id)
  }, [queueOpen, loadQueue])

  const handleDelete = useCallback(
    async (id: number) => {
      setDeletingId(id)
      try {
        await deleteDsaQueueItem(id)
        await loadQueue()
        // 删掉的正是本页这一份：回到「还没有分析结果」，别继续轮询一个已经不存在的任务
        setRow(current => (current?.id === id ? null : current))
      } catch (exc) {
        setQueueError(exc instanceof Error ? exc.message : String(exc))
      } finally {
        setDeletingId(null)
      }
    },
    [loadQueue],
  )

  const report = row?.report ?? null
  const meta = report?.meta ?? {}
  const summary = report?.summary ?? {}
  const strategy = report?.strategy ?? {}
  const details = report?.details ?? {}

  const stockName = meta.stock_name || row?.name || nameHint || symbol
  const changeTone = marketSignTextClass(meta.change_pct)
  // 数据缺口：老报告里可能还留着「需第三方 apikey / 未配置」这类已过时的行 ——
  // 那些模块现在都换成免费源了，显示出来只会误导，所以在渲染层筛掉（新报告本就没有）。
  const limitations = (details.limitations ?? []).filter(
    line => !/未配置|需第三方\s*apikey|需付费数据源/.test(line),
  )
  const sectors = details.sectors ?? []
  // 数据源清单：老报告没有这一项 → 空数组，面板整块不渲染（不显示一堆假的「未配置」）
  const sources = details.sources ?? []

  // 已用时长：起点是库里的 started_at（真正开跑的时刻），不是前端 mount 的时刻。
  const elapsedSeconds = dsaElapsedSeconds(row, now)
  const startedAtText = formatDsaInstant(row?.started_at)
  const queuedPosition = row?.queue_position ?? 0

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

  // 北交所：股票池外，直接给一句话，不进「开始分析」也不排队
  if (isBeijingCode(symbol)) {
    return (
      <div className="min-h-screen bg-[#05080f] px-4 py-6 text-slate-200 md:px-8" data-dsa2-page={symbol} data-dsa2-bj-blocked="1">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          <header className={`${CARD} flex flex-wrap items-center justify-between gap-3 p-5`}>
            <div>
              <h1 className="text-xl font-semibold text-white">{nameHint || symbol}</h1>
              <div className="mt-2 text-xs text-slate-400">
                <span className="rounded-md border border-cyan-500/25 px-2 py-0.5 font-mono text-cyan-300">{symbol}</span>
              </div>
            </div>
          </header>
          <section className={`${CARD} flex flex-col gap-2 p-6 text-center`} data-dsa2-bj-notice>
            <div className="text-sm font-medium text-amber-300">{text.bjExcluded}</div>
            <div className="text-xs leading-relaxed text-slate-400">{text.bjHint}</div>
            <div className="mt-2">
              <a className="text-xs text-cyan-300 hover:underline" href="/analysis">
                {text.backToAnalysis}
              </a>
            </div>
          </section>
        </div>
      </div>
    )
  }

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
              <span>{formatTime(row?.created_at || meta.created_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/10"
              onClick={() => void startAnalysis()}
              disabled={starting || row?.status === 'running' || row?.status === 'queued'}
            >
              {starting || row?.status === 'running' || row?.status === 'queued' ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              {text.retry}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-slate-700 text-slate-300 hover:bg-slate-800/60"
              onClick={() => setQueueOpen(true)}
              data-dsa2-queue-trigger="1"
              aria-label={text.queue}
            >
              <ListOrdered className="mr-1 h-3.5 w-3.5" />
              {text.queue}
              {queue && queue.pending > 0 ? (
                <span className="ml-1 rounded-full bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-200">
                  {queue.pending}
                </span>
              ) : null}
            </Button>
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-rose-900/60 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {text.loadFailed(error)}
          </div>
        ) : null}

        {/* 运行中 / 排队中 / 失败 / 空 */}
        {row?.status === 'running' ? (
          <div className={`${CARD} flex flex-col items-center gap-3 p-10 text-center`} data-dsa2-running>
            <Loader2 className="h-6 w-6 animate-spin text-cyan-300" />
            <div className="text-base text-slate-100">{text.running}</div>
            <div className="max-w-lg text-xs leading-relaxed text-slate-400">{text.runningHint}</div>
            <div className="flex flex-col items-center gap-1 text-xs text-slate-500">
              <div data-dsa2-started-at>{text.startedAt(startedAtText)}</div>
              <div data-dsa2-elapsed>{text.elapsed(formatDuration(elapsedSeconds))}</div>
            </div>
          </div>
        ) : null}

        {row?.status === 'queued' ? (
          <div className={`${CARD} flex flex-col items-center gap-3 p-10 text-center`} data-dsa2-queued>
            <ListOrdered className="h-6 w-6 text-cyan-300" />
            <div className="text-base text-slate-100">{text.queuedTitle}</div>
            <div className="max-w-lg text-xs leading-relaxed text-slate-400">
              {queuedPosition > 0 ? text.queuedHint(queuedPosition) : text.queuedNext}
            </div>
            <div className="text-xs text-slate-500">{text.queuedSince(formatDsaInstant(row.created_at))}</div>
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

              {sources.length ? <SourcePanel sources={sources} /> : null}

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

        {loaded && !row && !error ? (
          <div className={`${CARD} flex flex-col items-center gap-3 p-10 text-center`} data-dsa2-idle>
            <div className="text-sm text-slate-300">{text.empty}</div>
            <div className="max-w-lg text-xs leading-relaxed text-slate-500">{text.startHint}</div>
            <Button size="sm" onClick={() => void startAnalysis()} disabled={starting}>
              {starting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
              {text.start}
            </Button>
          </div>
        ) : null}

        {row && row.status !== 'running' && row.status !== 'queued' && row.status !== 'failed' && !report ? (
          <div className={`${CARD} flex flex-col items-center gap-3 p-10 text-center`}>
            <div className="text-sm text-slate-300">{text.empty}</div>
            <Button size="sm" onClick={() => void startAnalysis()}>
              {text.start}
            </Button>
          </div>
        ) : null}
      </div>

      {queueOpen ? (
        <QueuePanel
          snapshot={queue}
          error={queueError}
          deletingId={deletingId}
          onClose={() => setQueueOpen(false)}
          onDelete={id => void handleDelete(id)}
        />
      ) : null}
    </div>
  )
}
