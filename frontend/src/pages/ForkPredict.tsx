/**
 * 「模型预测」列表页（/predict）—— 从分析页「添加股票」后面那颗按钮在新窗口打开。
 *
 * 每天 17:00 行情同步完成后，A 股管道跑一次横截面推理，把全市场名次写进
 * ``stock_predict_daily``；本页只读它（接口 ``/api/stocks/predict/*``）。
 *
 * 界面口径（用户 2026-11-24）
 * --------------------------
 * - 新窗口、**无返回导航**（和 /dsa2 一样是独立页）；
 * - 一天一屏：顶部选交易日，默认最新；
 * - 列表只放「名次 / 代码 / 名称 / 分位 / 20 日中位成交额」，点代码或名称开详情窗。
 *
 * 诚实说明（必须显示，别让人把它当成买入建议）
 * --------------------------------------------
 * 这只模型只在**最头部几十只**有一点信息（测试段 2026 全年 head AUC 0.62、
 * 头部命中率 0.18 / 基础率 0.10，但整体秩 IC 为负），所以页面写的是「多条参考
 * 之一」，不给仓位、不给目标价。
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@panwatch/base-ui/components/ui/select'
import {
  getPredictDaily,
  getPredictDates,
  predictStockPath,
  type PredictDailyResponse,
  type PredictDatesResponse,
  type PredictRow,
} from '@/lib/predict-api'

export const PREDICT_TEXTS_ZH = {
  title: '模型预测',
  subtitle: '个股预测模型 · 每日横截面名次（1 = 最看好）',
  noData: '预测尚未生成。每天 17:00 行情同步完成后跑一次推理，跑完这里就会有数据。',
  loadFailed: (message: string) => `读取预测失败：${message}`,
  date: '交易日',
  refresh: '刷新',
  rank: '名次',
  code: '代码',
  name: '名称',
  pct: '分位',
  amount: '20 日中位成交额',
  total: (n: number) => `共 ${n} 只`,
  /** 列表一次只取前 500 名（接口上限）；总量更多时说清楚，别让人以为只有这些 */
  truncated: (shown: number, total: number) => `按名次只列前 ${shown} 名（共 ${total} 只）`,
  scoredAt: (at: string) => `计算于 ${at}`,
  caveat:
    '这个模型只在最头部的几十只有一点信息，整体排序不成立。当参考之一，不是买入建议，也不代表涨跌概率。',
  modelLine: (version: string, features: number | null | undefined) =>
    `模型 ${version}${features ? ` · ${features} 个特征` : ''}`,
  openHint: '点代码或名称开详情（新窗口）',
}

const CARD =
  'rounded-2xl border border-cyan-500/20 bg-[#0b1220]/80 shadow-[0_0_0_1px_rgba(34,211,238,0.06)]'

/** 分位 → 颜色：最头部 5% 用青色，其余灰（不做好坏暗示，只做分层）。 */
function pctClass(pct?: number | null) {
  if (pct == null) return 'text-slate-500'
  if (pct >= 95) return 'text-cyan-300'
  if (pct >= 80) return 'text-slate-300'
  return 'text-slate-500'
}

/** 20 日中位成交额 → 「1.7 亿」。 */
export function formatAmount(yuan?: number | null) {
  if (yuan == null || !Number.isFinite(yuan)) return '—'
  if (yuan >= 1e8) return `${(yuan / 1e8).toFixed(2)} 亿`
  if (yuan >= 1e4) return `${(yuan / 1e4).toFixed(0)} 万`
  return String(Math.round(yuan))
}

export default function ForkPredictPage() {
  const [dates, setDates] = useState<PredictDatesResponse | null>(null)
  const [date, setDate] = useState<string | null>(null)
  const [daily, setDaily] = useState<PredictDailyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /* 交易日列表读完（哪怕一条都没有）才去拉列表：否则「没有任何预测」时
     请求永远不会发，页面会一直停在转圈上。 */
  const [dateReady, setDateReady] = useState(false)

  // 初始：交易日列表（默认最新一天）
  useEffect(() => {
    let alive = true
    getPredictDates()
      .then(res => {
        if (!alive) return
        setDates(res)
        const fromUrl = new URLSearchParams(window.location.search).get('date')
        setDate(fromUrl || res.latest || null)
        setDateReady(true)
      })
      .catch((err: Error) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!dateReady) return
    let alive = true
    setLoading(true)
    getPredictDaily(date, 500, 0)
      .then(res => {
        if (!alive) return
        setDaily(res)
        setError(null)
      })
      .catch((err: Error) => alive && setError(err.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [date, dateReady])

  const rows = daily?.items ?? []
  const modelLabel = useMemo(() => {
    const model = dates?.model
    if (!model?.version) return null
    return PREDICT_TEXTS_ZH.modelLine(model.version, model.n_features)
  }, [dates])

  return (
    <div className="min-h-screen bg-[#05080f] px-4 py-6 text-slate-200 md:px-8" data-predict-page="list">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <header className={`${CARD} p-5`}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-cyan-300">{PREDICT_TEXTS_ZH.title}</h1>
              <p className="mt-1 text-xs text-slate-400">{PREDICT_TEXTS_ZH.subtitle}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">{PREDICT_TEXTS_ZH.date}</span>
              {/* 用共享 Select（UI 规范禁止原生 select：主题、键盘、无障碍三处不一致） */}
              <Select
                value={date ?? ''}
                onValueChange={value => setDate(value || null)}
              >
                <SelectTrigger
                  className="h-7 w-[168px] border-slate-700 bg-[#0b1220] text-xs text-slate-200"
                  data-predict-date-select="1"
                  aria-label={PREDICT_TEXTS_ZH.date}
                >
                  <SelectValue placeholder={PREDICT_TEXTS_ZH.date} />
                </SelectTrigger>
                <SelectContent>
                  {(dates?.dates ?? []).map(item => (
                    <SelectItem key={item.trade_date} value={item.trade_date}>
                      {item.trade_date}（{item.count}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:text-cyan-300"
                onClick={() => {
                  if (!date) return
                  setLoading(true)
                  getPredictDaily(date, 500, 0)
                    .then(res => {
                      setDaily(res)
                      setError(null)
                    })
                    .catch((err: Error) => setError(err.message))
                    .finally(() => setLoading(false))
                }}
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
                {PREDICT_TEXTS_ZH.refresh}
              </button>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            {daily?.trade_date && <span>{PREDICT_TEXTS_ZH.total(daily.total)}</span>}
            {daily?.total != null && rows.length > 0 && daily.total > rows.length && (
              <span data-predict-truncated="1">
                {PREDICT_TEXTS_ZH.truncated(rows.length, daily.total)}
              </span>
            )}
            {daily?.scored_at && <span>{PREDICT_TEXTS_ZH.scoredAt(daily.scored_at)}</span>}
            {modelLabel && <span>{modelLabel}</span>}
            <span>{PREDICT_TEXTS_ZH.openHint}</span>
          </div>
        </header>

        <div className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-amber-200/80">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span data-predict-caveat="1">{PREDICT_TEXTS_ZH.caveat}</span>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
            {PREDICT_TEXTS_ZH.loadFailed(error)}
          </div>
        )}

        {!daily?.available && !error ? (
          <div className={`${CARD} px-5 py-10 text-center text-xs text-slate-400`} data-predict-empty="1">
            {loading ? <Loader2 className="mx-auto h-4 w-4 animate-spin text-cyan-400" /> : PREDICT_TEXTS_ZH.noData}
          </div>
        ) : (
          <div className={`${CARD} overflow-x-auto scrollbar`}>
            <table className="w-full min-w-[720px] table-fixed text-[12px]">
              <colgroup>
                <col style={{ width: 64 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 140 }} />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-700/60 text-[11px] text-slate-500">
                  <th className="px-3 py-2 text-left font-normal">{PREDICT_TEXTS_ZH.rank}</th>
                  <th className="px-3 py-2 text-left font-normal">{PREDICT_TEXTS_ZH.code}</th>
                  <th className="px-3 py-2 text-left font-normal">{PREDICT_TEXTS_ZH.name}</th>
                  <th className="px-3 py-2 text-right font-normal">{PREDICT_TEXTS_ZH.pct}</th>
                  <th className="px-3 py-2 text-right font-normal">{PREDICT_TEXTS_ZH.amount}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row: PredictRow) => (
                  <tr
                    key={row.code}
                    className="border-b border-slate-800/60 hover:bg-cyan-500/5"
                    data-predict-row={row.code}
                  >
                    <td className="px-3 py-1.5 font-mono text-slate-400">{row.rank_no}</td>
                    <td className="px-3 py-1.5">
                      <a
                        href={predictStockPath(row.code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-cyan-300 hover:underline"
                      >
                        {row.code}
                        <ExternalLink className="h-2.5 w-2.5 opacity-50" />
                      </a>
                    </td>
                    <td className="truncate px-3 py-1.5 text-slate-200">
                      <a
                        href={predictStockPath(row.code)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-cyan-300 hover:underline"
                      >
                        {row.name || '—'}
                      </a>
                    </td>
                    <td className={`px-3 py-1.5 text-right font-mono ${pctClass(row.pct)}`}>
                      {row.pct == null ? '—' : row.pct.toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-slate-400">
                      {formatAmount(row.amt_med20)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
