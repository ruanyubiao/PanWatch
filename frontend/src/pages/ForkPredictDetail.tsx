/**
 * 「模型预测」个股详情页（/predict/:code）—— 从列表页点代码/名称、或分析页那列的
 * 数值在新窗口打开。**无返回导航**（用户口径：和 /dsa2 一样是独立页）。
 *
 * 一块内容：最新一条（交易日 / 名次 / 全市场只数 / 分位 / 20 日中位成交额 /
 * 计算时间 / 模型版本）+ 近 N 个交易日的分位曲线 + 逐日列表 + 诚实提示。
 *
 * 为什么曲线画「分位」而不是「名次」：分位天然是「越高越好」，不用为了让 1 名在
 * 顶上而把坐标轴倒过来 —— 倒轴是最容易被误读成「跌了」的画法。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { getPredictStock, type PredictStockResponse } from '@/lib/predict-api'
import { formatAmount } from './ForkPredict'

export const PREDICT_DETAIL_TEXTS_ZH = {
  loadFailed: (message: string) => `读取预测失败：${message}`,
  notFound: '这只票在预测表里没有记录（可能不在股票池内，或预测还没生成）。',
  tradeDate: '交易日',
  rank: '名次',
  universe: (n: number) => `全市场 ${n} 只`,
  pct: '分位',
  amount: '20 日中位成交额',
  scoredAt: '计算时间',
  model: '模型',
  curve: '近 60 个交易日的分位',
  curveHint: '越高越靠前（分位 100 = 当日第 1 名）',
  historyTitle: '逐日记录',
  historyEmpty: '还没有更早的记录。',
  caveat:
    '这个模型只在最头部的几十只有一点信息，整体排序不成立。名次与分位都是当日横截面里的相对位置，不是涨跌概率、也不是买入建议。',
  pending:
    '最近 20 个交易日的预测还没到兑现阶段（标签要 20 个交易日后才算得出来），所以这一段只有预测、没有成绩。',
  tableDate: '交易日',
  tableRank: '名次',
  tablePct: '分位',
}

const CARD =
  'rounded-2xl border border-cyan-500/20 bg-[#0b1220]/80 shadow-[0_0_0_1px_rgba(34,211,238,0.06)]'

/** 分位曲线（SVG 折线）：0–100 固定量程，不按数据缩放，跨股票可比。 */
export function PredictCurve({ points }: { points: { trade_date: string; pct: number | null }[] }) {
  const usable = points.filter(p => p.pct != null) as { trade_date: string; pct: number }[]
  if (usable.length < 2) return <div className="py-6 text-center text-[11px] text-slate-500">—</div>
  const width = 640
  const height = 120
  const pad = 6
  const stepX = (width - pad * 2) / (usable.length - 1)
  const toY = (pct: number) => height - pad - (Math.max(0, Math.min(100, pct)) / 100) * (height - pad * 2)
  const path = usable
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * stepX).toFixed(1)},${toY(p.pct).toFixed(1)}`)
    .join(' ')
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-[120px] w-full"
      role="img"
      aria-label={PREDICT_DETAIL_TEXTS_ZH.curve}
      data-predict-curve="1"
    >
      {[0, 50, 100].map(level => (
        <line
          key={level}
          x1={pad}
          x2={width - pad}
          y1={toY(level)}
          y2={toY(level)}
          stroke="rgba(148,163,184,0.15)"
          strokeDasharray={level === 50 ? '3 3' : undefined}
        />
      ))}
      <path d={path} fill="none" stroke="rgb(34,211,238)" strokeWidth="1.5" />
    </svg>
  )
}

export default function ForkPredictDetailPage() {
  const { code = '' } = useParams()
  const [data, setData] = useState<PredictStockResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    getPredictStock(code)
      .then(res => {
        if (!alive) return
        setData(res)
        setError(null)
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [code])

  const shell = (children: ReactNode) => (
    <div className="min-h-screen bg-[#05080f] px-4 py-6 text-slate-200 md:px-8" data-predict-page="detail" data-predict-code={code}>
      <div className="mx-auto flex max-w-4xl flex-col gap-4">{children}</div>
    </div>
  )

  if (loading && !data) {
    return shell(
      <div className={`${CARD} flex items-center justify-center gap-2 px-5 py-16 text-xs text-slate-400`}>
        <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />
        …
      </div>,
    )
  }

  if (!data) {
    return shell(
      <div className={`${CARD} px-5 py-10 text-center text-xs text-slate-400`} data-predict-missing="1">
        {error ? PREDICT_DETAIL_TEXTS_ZH.loadFailed(error) : PREDICT_DETAIL_TEXTS_ZH.notFound}
      </div>,
    )
  }

  const pctText = data.pct == null ? '—' : data.pct.toFixed(2)

  return shell(
    <>
      <header className={`${CARD} p-5`}>
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-xl font-semibold text-slate-100" data-predict-name="1">
            {data.name || data.code}
          </h1>
          <span className="rounded-md border border-cyan-500/30 px-1.5 py-0.5 font-mono text-[11px] text-cyan-300">
            {data.code}
          </span>
          <span className="text-xs text-slate-500">
            {PREDICT_DETAIL_TEXTS_ZH.tradeDate} {data.trade_date}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div>
            <div className="text-[11px] text-slate-500">{PREDICT_DETAIL_TEXTS_ZH.rank}</div>
            <div className="font-mono text-lg text-slate-100" data-predict-rank="1">
              {data.rank_no}
              <span className="ml-1 text-[11px] text-slate-500">
                {PREDICT_DETAIL_TEXTS_ZH.universe(data.universe)}
              </span>
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500">{PREDICT_DETAIL_TEXTS_ZH.pct}</div>
            <div className="font-mono text-lg text-cyan-300" data-predict-pct="1">
              {pctText}
            </div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500">{PREDICT_DETAIL_TEXTS_ZH.amount}</div>
            <div className="font-mono text-lg text-slate-300">{formatAmount(data.amt_med20)}</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500">{PREDICT_DETAIL_TEXTS_ZH.scoredAt}</div>
            <div className="font-mono text-[12px] text-slate-300">{data.scored_at || '—'}</div>
            <div className="mt-1 text-[10px] text-slate-500">
              {PREDICT_DETAIL_TEXTS_ZH.model} {data.model_version || '—'}
            </div>
          </div>
        </div>
      </header>

      <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {PREDICT_DETAIL_TEXTS_ZH.caveat}
          <br />
          {PREDICT_DETAIL_TEXTS_ZH.pending}
        </span>
      </div>

      <section className={`${CARD} p-4`}>
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-[13px] text-slate-200">{PREDICT_DETAIL_TEXTS_ZH.curve}</h2>
          <span className="text-[10px] text-slate-500">{PREDICT_DETAIL_TEXTS_ZH.curveHint}</span>
        </div>
        <PredictCurve points={data.history} />
      </section>

      <section className={`${CARD} overflow-hidden`}>
        <div className="border-b border-slate-700/60 px-4 py-2 text-[13px] text-slate-200">
          {PREDICT_DETAIL_TEXTS_ZH.historyTitle}
        </div>
        {data.history.length === 0 ? (
          <div className="px-4 py-6 text-center text-[11px] text-slate-500">
            {PREDICT_DETAIL_TEXTS_ZH.historyEmpty}
          </div>
        ) : (
          <table className="w-full table-fixed text-[12px]">
            <colgroup>
              <col style={{ width: 140 }} />
              <col style={{ width: 100 }} />
              <col style={{ width: 100 }} />
            </colgroup>
            <thead>
              <tr className="text-[11px] text-slate-500">
                <th className="px-4 py-1.5 text-left font-normal">{PREDICT_DETAIL_TEXTS_ZH.tableDate}</th>
                <th className="px-4 py-1.5 text-right font-normal">{PREDICT_DETAIL_TEXTS_ZH.tableRank}</th>
                <th className="px-4 py-1.5 text-right font-normal">{PREDICT_DETAIL_TEXTS_ZH.tablePct}</th>
              </tr>
            </thead>
            <tbody>
              {[...data.history].reverse().map(point => (
                <tr key={point.trade_date} className="border-t border-slate-800/60">
                  <td className="px-4 py-1.5 font-mono text-slate-300">{point.trade_date}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-slate-300">{point.rank_no}</td>
                  <td className="px-4 py-1.5 text-right font-mono text-slate-400">
                    {point.pct == null ? '—' : point.pct.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>,
  )
}
