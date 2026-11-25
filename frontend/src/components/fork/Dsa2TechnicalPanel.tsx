/**
 * 深度分析2 —— K 线 / 技术指标区（插在页面头部下面）。
 *
 * 数据的两个来源，优先级严格
 * ------------------------
 * 1. ``report.details.technical`` —— 报告**生成时**一起存下来的那一份。正常情况走这条，
 *    旧报告永远显示旧数据（用户口径：报告可能是 3 天前的，今天打开不能给今天的数据）。
 * 2. 老报告没有这个块时，才按**报告自己的基准日**调 ``/dsa/technical?asof=`` 复原 ——
 *    后端只读到那天为止的日线并关掉实时快照，读到的仍是那一天的数。区块上标
 *    「按报告基准日复原」，不让它冒充「报告内保存」。
 *
 * 两条路都拿不到就如实写「这份报告没有技术面数据」并提示重新分析，**不静默取
 * 今天的指标** —— 那是最容易让人误判的一种错。
 */
import { useEffect, useState } from 'react'
import { Activity, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { TechnicalBadge, technicalToneFromSuggestionAction } from '@panwatch/biz-ui/components/technical-badge'
import { KlineIndicators } from '@panwatch/biz-ui/components/kline-indicators'
import { getDsaTechnical, type DsaTechnical } from '@/lib/dsa-api'
import {
  buildTechnicalSuggestion,
  summaryFromTechnical,
} from '@/lib/fork-dsa-technical'

const CARD = 'rounded-2xl border border-cyan-500/20 bg-[#0b1220]/80 shadow-[0_0_0_1px_rgba(34,211,238,0.06)]'

export const DSA2_TECH_TEXTS_ZH = {
  title: 'K线 / 技术指标',
  asof: (date: string) => `数据截至 ${date}`,
  asofHint: '技术指标基于该交易日的已收盘日线，与这份报告一起保存；它不会随今天的数据变化。',
  stored: '报告内保存',
  reconstructed: '按报告基准日复原',
  reconstructedHint: '这份报告是旧版本，没有保存技术面快照；下面按报告自己的基准日从行情库复原，不是今天的数据。',
  reconstructing: '正在按报告基准日复原技术面…',
  notHeld: '未持仓口径',
  notHeldHint: '评分按「未持有」那张动作表映射，与本页无持仓上下文一致',
  score: (value: string) => `评分 ${value}`,
  empty: '这份报告没有技术面数据',
  emptyHint: '这只票可能上市不足 120 个交易日，或者旧报告的基准日当天没有日线。点「重新分析」会按当前口径重算一份。',
  noSnapshot: '这份报告没有保存技术面，也无法按基准日复原。点上方「重新分析」重跑一份即可。',
  indicator: '指标',
  metricsTitle: '区间涨跌',
  ret5: (value: string) => `5日 ${value}%`,
  ret20: (value: string) => `20日 ${value}%`,
  ret60: (value: string) => `60日 ${value}%`,
  range20: (low: string, high: string) => `20日区间 ${low} ~ ${high}`,
  volumeRatio: (value: string) => `量比 ${value}`,
}

interface Props {
  /** ``report.details.technical`` —— 有就不用请求任何接口 */
  technical?: DsaTechnical | null
  symbol: string
  /** 报告的技术面基准日（``meta.bar_asof`` 优先，其次 ``meta.asof``） */
  reportAsof?: string | null
}

function fmt(value?: number | null, digits = 2): string {
  return value == null || Number.isNaN(value) ? '—' : value.toFixed(digits)
}

function signed(value?: number | null): string {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

export function Dsa2TechnicalPanel({ technical, symbol, reportAsof }: Props) {
  const { t, i18n } = useTranslation('bizUi')
  const tr = (key: string, options?: Record<string, unknown>) =>
    (t as unknown as (k: string, o?: Record<string, unknown>) => string)(`kline.${key}`, options)

  const stored = technical && technical.available ? technical : null
  const [block, setBlock] = useState<DsaTechnical | null>(stored)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 「字段在不在」与「字段里有没有数」是两件事：
  //   - 字段不在（旧报告）→ 才去按基准日复原；
  //   - 字段在但 available=false（这只票本来就没技术指标）→ 直接如实显示原因，
  //     不要去复原 —— 复原的结果一样是空，白打一次行情库。
  const needsRestore = !technical
  const unavailableReason = technical && !technical.available ? technical.reason : null

  useEffect(() => {
    // 报告里已经存了就不用请求。没有就按基准日复原（只读那一天为止的日线）。
    if (!needsRestore) {
      setBlock(stored)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    getDsaTechnical(symbol, reportAsof ?? null)
      .then(result => {
        if (!alive) return
        setBlock(result)
      })
      .catch((reason: unknown) => {
        if (!alive) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [needsRestore, stored, symbol, reportAsof])

  const summary = block ? summaryFromTechnical(block, tr) : null
  const suggestion = summary ? buildTechnicalSuggestion(summary, tr) : null

  return (
    <section className={`${CARD} p-5`} data-dsa2-technical="1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-cyan-300">
          <Activity className="h-4 w-4" />
          {DSA2_TECH_TEXTS_ZH.title}
        </h2>
        {block?.asof ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500" data-dsa2-tech-asof={block.asof}>
            <span title={DSA2_TECH_TEXTS_ZH.asofHint}>{DSA2_TECH_TEXTS_ZH.asof(block.asof)}</span>
            <span
              className={`rounded-md border px-1.5 py-0.5 ${
                block.reconstructed
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                  : 'border-slate-700 text-slate-400'
              }`}
              title={block.reconstructed ? DSA2_TECH_TEXTS_ZH.reconstructedHint : DSA2_TECH_TEXTS_ZH.asofHint}
              data-dsa2-tech-source={block.reconstructed ? 'reconstructed' : 'stored'}
            >
              {block.reconstructed ? DSA2_TECH_TEXTS_ZH.reconstructed : DSA2_TECH_TEXTS_ZH.stored}
            </span>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {DSA2_TECH_TEXTS_ZH.reconstructing}
        </div>
      ) : null}

      {!loading && (error || unavailableReason) ? (
        <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          <div className="text-slate-300">{DSA2_TECH_TEXTS_ZH.empty}</div>
          <div className="mt-1">{error || unavailableReason}</div>
          <div className="mt-1 text-slate-500">{DSA2_TECH_TEXTS_ZH.noSnapshot}</div>
        </div>
      ) : null}

      {!loading && !error && !unavailableReason && !summary ? (
        <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          <div className="text-slate-300">{DSA2_TECH_TEXTS_ZH.empty}</div>
          <div className="mt-1">{block?.reason || DSA2_TECH_TEXTS_ZH.emptyHint}</div>
        </div>
      ) : null}

      {!loading && summary && suggestion ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-lg border border-border/30 bg-accent/20 p-3" data-dsa2-tech-card="1">
            <div className="flex items-center justify-between gap-2">
              <TechnicalBadge
                label={suggestion.action_label}
                tone={technicalToneFromSuggestionAction(suggestion.action, suggestion.action_label)}
                size="sm"
              />
              <span className="text-[10px] text-slate-400" title={DSA2_TECH_TEXTS_ZH.notHeldHint}>
                {DSA2_TECH_TEXTS_ZH.notHeld} · {DSA2_TECH_TEXTS_ZH.score(String(suggestion.score))}
              </span>
            </div>
            {suggestion.signal ? (
              <div className="mt-2 text-[12px] font-medium text-slate-100" data-dsa2-tech-signal="1">
                {suggestion.signal}
              </div>
            ) : null}
            {suggestion.items.length > 0 ? (
              <div className="mt-2 space-y-1">
                {suggestion.items.map((item, index) => (
                  <div key={`${item.key}-${index}`} className="flex items-center justify-between gap-3 text-[11px]">
                    <span className="text-slate-400">{item.text}</span>
                    <span
                      className={`font-mono ${
                        item.delta > 0
                          ? 'text-market-up'
                          : item.delta < 0
                            ? 'text-market-down'
                            : 'text-market-flat'
                      }`}
                    >
                      {item.delta > 0 ? '+' : ''}
                      {item.delta}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="mt-2 text-[10px] text-slate-500">{tr('disclaimer')}</div>
          </div>

          <div className="text-[10px] text-slate-500">{tr('hoverHint')}</div>
          <KlineIndicators summary={summary} />

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-400">
            {block?.ret_5d != null ? <span>{DSA2_TECH_TEXTS_ZH.ret5(signed(block.ret_5d))}</span> : null}
            {block?.ret_20d != null ? <span>{DSA2_TECH_TEXTS_ZH.ret20(signed(block.ret_20d))}</span> : null}
            {block?.ret_60d != null ? <span>{DSA2_TECH_TEXTS_ZH.ret60(signed(block.ret_60d))}</span> : null}
            {block?.volume_ratio != null ? (
              <span>{DSA2_TECH_TEXTS_ZH.volumeRatio(fmt(block.volume_ratio, 2))}</span>
            ) : null}
            {block?.low_20 != null && block?.high_20 != null ? (
              <span className="text-slate-500">
                {DSA2_TECH_TEXTS_ZH.range20(fmt(block.low_20), fmt(block.high_20))}
              </span>
            ) : null}
          </div>

          <details className="group">
            <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
              {tr('rules.title')} <span className="text-[10px]">{tr('rules.expand')}</span>
            </summary>
            <div className="mt-2 space-y-1.5 whitespace-pre-wrap rounded bg-slate-900/60 p-2 text-[11px] text-slate-400">
              <div className="font-medium text-slate-200">{tr('rules.recommendation')}</div>
              <div>{tr('rules.unheld')}</div>
              <div>{tr('rules.held')}</div>
              <div className="font-medium text-slate-200">{tr('rules.scoring')}</div>
              {['trend', 'macd', 'rsi', 'kdj', 'boll', 'volume', 'levels'].map(key => (
                <div key={key}>{tr(`rules.${key}`)}</div>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      {/* 语言不是中文时也不留空：上面的文案是中文，徽章与规则走 i18n */}
      <span className="sr-only" data-dsa2-tech-lang={i18n.resolvedLanguage || i18n.language}>
        {needsRestore ? 'restore' : 'stored'}
      </span>
    </section>
  )
}
