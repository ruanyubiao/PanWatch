/**
 * 深度分析2 —— 模型预测区（插在技术面后面）。
 *
 * 三件事必须写清楚，否则这块会被误读成「AI 说要看涨」
 * ------------------------------------------------
 * 1. **期限**：预测的是未来 20 个交易日的**相对位置**（同池内排名），不是涨跌方向、
 *    也不是概率。名次 1 只说明「在这 5000 只里排最前」。
 * 2. **有效区间**：实测只有最头部约前 10%（name 前 ~500 名）有一点信息，其余区间
 *    按「无信息」处理。**不在前 10% 不等于看空** —— 这条必须在页面上说明白，
 *    否则每个没进前 500 的票都会被读成利空。
 * 3. **时点**：报告里存了预测快照就用它；旧报告没有时，按报告基准日去预测库里
 *    找同一天的那一条。找不到同一天的，才退回「最近一次」并**明确标注不是本报告
 *    时点**，绝不把两者混在一起说。
 *
 * 实测数字（2026 全年测试段，约 96 万行，见 docs/PREDICT_MODEL.md）：
 *   - 头部命中率 18.0%，基础率 10%，约 1.8 倍
 *   - head AUC 0.62
 *   - 连续秩 IC −0.071（整体排序**不成立**）
 *   - 十分位超额：最高一档 +172bp，其余档位 −95 ~ +57bp，负的居多
 * 所以：只能当「多条参考之一」。
 */
import { useEffect, useState } from 'react'
import { AlertTriangle, Cpu, ExternalLink, Loader2 } from 'lucide-react'
import { getPredictStock, openPredictStockWindow, type PredictStockResponse } from '@/lib/predict-api'
import type { DsaPrediction } from '@/lib/dsa-api'

const CARD = 'rounded-2xl border border-cyan-500/20 bg-[#0b1220]/80 shadow-[0_0_0_1px_rgba(34,211,238,0.06)]'

/** 有效区阈值：分位 ≥ 90 即全市场前 10%（约前 500 名）。调这里一处即可。 */
export const PREDICT_EFFECTIVE_PCT = 90

export const DSA2_PREDICT_TEXTS_ZH = {
  title: '模型预测',
  tradeDate: (date: string) => `预测日 ${date}`,
  sameDay: '与本报告同一交易日',
  otherDay: (date: string) => `非本报告时点（最近一次 ${date}）`,
  rank: '名次',
  universe: (n: number) => `全市场 ${n} 只`,
  pct: '分位',
  pctHint: '越高越靠前（100 = 第 1 名）',
  zone: '有效性判定',
  inZone: '在有效区（前 10%）',
  outZone: '不在有效区（无信息）',
  inZoneHint: '这是模型唯一有实测信息的区间：值得作为一条参考，但它只说明相对位置靠前，不是买入信号。',
  outZoneHint: '模型对这个区间没有实测信息，按「无信息」处理 —— 不能说它在看空这只票，也不能据此回避。',
  plainUse: '怎么用：只看有没有进前 10%（约前 500 名）。进了，当成「再多看一眼这只票」的理由；没进，就当这个信号不存在 —— 不看空，也不据此卖出。',
  plainWhy: '为什么只看前 10%：2026 全年实测里，只有最头部那一档真有超额（+172bp），中间和尾部各档基本往下偏（−95 ~ +57bp），整体排序不成立，所以只有头部有点信息。',
  loading: '正在读取预测…',
  empty: '这只票没有预测记录',
  emptyHint: '可能不在股票池内（北交所/ST/上市不足），或当天推理还没跑（每日 17:00 同步后计算）。',
  latest: '完整预测曲线',
  howToTitle: '这个模型怎么用（点击展开）',
  howToLines: [
    '口径：未来 20 个交易日内，相对同池（沪深 A 股，剔除 ST 与北交所）的横截面排名。不是涨跌预测，也不是概率。',
    '实测（2026 全年测试段，约 96 万行）：头部命中率 18.0%，而随便挑一只是 10% —— 约 1.8 倍；但连续秩 IC 为 −0.071，说明整体排序不成立。',
    '十分位超额：最高一档 +172bp，其余档位在 −95bp ~ +57bp 之间，负的居多。所以只有最头部几十只有信息。',
    '用法：只看「是否落在前 10%」。落在里面 = 值得再多看一眼；落在外面 = 无信息，不是利空。',
    '最近 20 个交易日的预测还没到兑现期（标签要 20 个交易日后才算得出），这一段只有预测、没有成绩。',
  ],
  model: (version: string) => `模型 ${version}`,
}

interface Props {
  prediction?: DsaPrediction | null
  symbol: string
  /** 报告的基准日：用来在预测库里找同一天那条 */
  reportAsof?: string | null
}

interface Resolved {
  trade_date: string | null
  rank_no: number | null
  universe: number | null
  pct: number | null
  model_version?: string | null
  sameDay: boolean
}

function fromSnapshot(block: DsaPrediction): Resolved {
  return {
    trade_date: block.trade_date ?? null,
    rank_no: block.rank_no ?? null,
    universe: block.universe ?? null,
    pct: block.pct ?? null,
    model_version: block.model_version ?? null,
    sameDay: true,
  }
}

/** 预测库历史里挑与报告基准日同日的那一条；没有就取最新一条并标 sameDay=false。 */
function pickFromHistory(data: PredictStockResponse, reportAsof?: string | null): Resolved | null {
  if (!data?.trade_date) return null
  const points = data.history || []
  const same = reportAsof ? points.find(point => point.trade_date === reportAsof) : undefined
  const chosen = same || {
    trade_date: data.trade_date,
    rank_no: data.rank_no,
    pct: data.pct ?? null,
  }
  return {
    trade_date: chosen.trade_date ?? null,
    rank_no: chosen.rank_no ?? null,
    universe: data.universe ?? null,
    pct: chosen.pct ?? null,
    model_version: data.model_version ?? null,
    sameDay: Boolean(same),
  }
}

export function Dsa2PredictPanel({ prediction, symbol, reportAsof }: Props) {
  const stored = prediction && prediction.available ? prediction : null
  const [resolved, setResolved] = useState<Resolved | null>(stored ? fromSnapshot(stored) : null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 同上：只有「字段整个不在」才去预测库找同一天那条
  const needsLookup = !prediction
  const unavailableReason = prediction && !prediction.available ? prediction.reason : null

  useEffect(() => {
    if (!needsLookup) {
      setResolved(stored ? fromSnapshot(stored) : null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    getPredictStock(symbol, 60)
      .then(data => {
        if (!alive) return
        setResolved(pickFromHistory(data, reportAsof ?? null))
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
  }, [needsLookup, stored, symbol, reportAsof])

  const inZone = resolved?.pct != null && resolved.pct >= PREDICT_EFFECTIVE_PCT

  return (
    <section className={`${CARD} p-5`} data-dsa2-predict="1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-cyan-300">
          <Cpu className="h-4 w-4" />
          {DSA2_PREDICT_TEXTS_ZH.title}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {resolved?.trade_date ? (
            <span data-dsa2-predict-date={resolved.trade_date}>
              {DSA2_PREDICT_TEXTS_ZH.tradeDate(resolved.trade_date)}
            </span>
          ) : null}
          {resolved ? (
            <span
              className={`rounded-md border px-1.5 py-0.5 ${
                resolved.sameDay
                  ? 'border-slate-700 text-slate-400'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
              }`}
              data-dsa2-predict-sameday={resolved.sameDay ? '1' : '0'}
            >
              {resolved.sameDay
                ? DSA2_PREDICT_TEXTS_ZH.sameDay
                : DSA2_PREDICT_TEXTS_ZH.otherDay(resolved.trade_date || '—')}
            </span>
          ) : null}
          {resolved?.model_version ? (
            <span>{DSA2_PREDICT_TEXTS_ZH.model(resolved.model_version)}</span>
          ) : null}
        </div>
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {DSA2_PREDICT_TEXTS_ZH.loading}
        </div>
      ) : null}

      {!loading && (error || unavailableReason) && !resolved ? (
        <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          <div className="text-slate-300">{DSA2_PREDICT_TEXTS_ZH.empty}</div>
          <div className="mt-1">{error || unavailableReason}</div>
          <div className="mt-1 text-slate-500">{DSA2_PREDICT_TEXTS_ZH.emptyHint}</div>
        </div>
      ) : null}

      {!loading && !error && !resolved ? (
        <div className="mt-3 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2 text-[11px] leading-relaxed text-slate-400">
          <div className="text-slate-300">{DSA2_PREDICT_TEXTS_ZH.empty}</div>
          <div className="mt-1">{unavailableReason || DSA2_PREDICT_TEXTS_ZH.emptyHint}</div>
        </div>
      ) : null}

      {!loading && resolved ? (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] text-slate-500">{DSA2_PREDICT_TEXTS_ZH.rank}</div>
              <div className="mt-0.5 font-mono text-lg text-slate-100" data-dsa2-predict-rank="1">
                #{resolved.rank_no ?? '—'}
              </div>
              {resolved.universe ? (
                <div className="text-[10px] text-slate-500">
                  {DSA2_PREDICT_TEXTS_ZH.universe(resolved.universe)}
                </div>
              ) : null}
            </div>
            <div>
              <div className="text-[11px] text-slate-500" title={DSA2_PREDICT_TEXTS_ZH.pctHint}>
                {DSA2_PREDICT_TEXTS_ZH.pct}
              </div>
              <div
                className={`mt-0.5 font-mono text-lg ${inZone ? 'text-cyan-300' : 'text-slate-300'}`}
                data-dsa2-predict-pct="1"
              >
                {resolved.pct == null ? '—' : resolved.pct.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-500">{DSA2_PREDICT_TEXTS_ZH.pctHint}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500">{DSA2_PREDICT_TEXTS_ZH.zone}</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                inZone
                  ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                  : 'border-slate-700 bg-slate-800/60 text-slate-400'
              }`}
              data-dsa2-predict-zone={inZone ? 'in' : 'out'}
            >
              {inZone ? DSA2_PREDICT_TEXTS_ZH.inZone : DSA2_PREDICT_TEXTS_ZH.outZone}
            </span>
          </div>

          <div
            className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
              inZone
                ? 'border-cyan-500/25 bg-cyan-500/5 text-cyan-100/80'
                : 'border-slate-700/60 bg-slate-900/40 text-slate-400'
            }`}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span data-dsa2-predict-hint="1">
              {inZone ? DSA2_PREDICT_TEXTS_ZH.inZoneHint : DSA2_PREDICT_TEXTS_ZH.outZoneHint}
            </span>
          </div>

          {/* 人话说明：始终可见，不进折叠区 —— 这块最容易被误读成一个「看涨分数」 */}
          <div
            className="space-y-1.5 border-l-2 border-slate-700/70 pl-2.5 text-[11px] leading-relaxed text-slate-400"
            data-dsa2-predict-plain="1"
          >
            <p>{DSA2_PREDICT_TEXTS_ZH.plainUse}</p>
            <p>{DSA2_PREDICT_TEXTS_ZH.plainWhy}</p>
          </div>

          <details className="group">
            <summary className="cursor-pointer text-[11px] text-slate-400 hover:text-slate-200">
              {DSA2_PREDICT_TEXTS_ZH.howToTitle}
            </summary>
            <div className="mt-2 space-y-1.5 rounded bg-slate-900/60 p-2 text-[11px] leading-relaxed text-slate-400">
              {DSA2_PREDICT_TEXTS_ZH.howToLines.map(line => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </details>

          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200"
            onClick={() => openPredictStockWindow(symbol)}
            data-dsa2-predict-detail="1"
          >
            {DSA2_PREDICT_TEXTS_ZH.latest}
            <ExternalLink className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      <span className="sr-only" data-dsa2-predict-lookup={needsLookup ? '1' : '0'} />
    </section>
  )
}
