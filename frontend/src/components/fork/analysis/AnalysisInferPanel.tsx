/**
 * 条件推理的进度与结果（嵌在「数据分析」弹窗里）。
 *
 * 2026-10-24 用户第 2 条报的 bug：任务停在 99/100 显示「已完成」，按钮全灰、也停不下来。
 * 根因有两个 ——（1）搜索空间耗尽时提前 break，界面上只是「99/100」看不出原因；
 * （2）状态判断只看 status，不看「线程是否还活着」。这里都补上了：
 * 状态按 alive 修正、耗尽时写明原因、只要线程还在就允许暂停/停止。
 */
import { Pause, Play, Square } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { AnalysisScoreCard, SCORE_VERDICTS_ZH } from './AnalysisScoreCard'
import { formatInferDuration, type InferFinalist, type InferRunMeta } from '@/lib/infer-api'

export const ANALYSIS_INFER_TEXTS_ZH = {
  title: '条件推理',
  enabled: '启用',
  iterations: '推演次数',
  iterationsUnit: '次',
  iterationsHint: '每调整一次条件就跑一轮完整评估，次数越多越容易过拟合',
  progressTitle: (done: number, total: number) => `已完成 ${done} / ${total} 次`,
  successFail: (ok: number, bad: number) => `成功 ${ok} · 失败 ${bad}`,
  elapsed: (text: string) => `已用 ${text}`,
  eta: (text: string) => `预计剩余 ${text}`,
  best: (text: string) => `当前最优：${text}`,
  finalizing: '正在做最终验算（完整训练段 + 验证段）',
  pause: '暂停',
  resume: '继续',
  stop: '停止',
  stopped: '已停止：已跑完的部分照样做了验算',
  exhausted: (done: number, total: number) => `搜索空间已耗尽（${done}/${total}），结果按已跑完的算`,
  failed: '推理失败',
  interrupted: '任务中断（进程重启过），已跑完的结果仍然有效',
  resultTitle: '推理结果',
  cond: '条件',
  trainCol: '推理段',
  testCol: '验证段',
  horizon: '最优持有期',
  excess: '超额',
  events: '信号数',
  scopeCol: '有效范围',
  scopeHint: '通用：整条达标（≥60）；个股：某只股票个别达标（≥80）',
  stockTitle: '个股名单（这条条件对这些个股特别有效）',
  stockHint: (count: number, total: number) =>
    `共 ${count} 只个股达到个股门槛（≥80 分），下表列出分数最高的 ${Math.min(count, 20)} 只 / 参与评估 ${total} 只。个股是线索，不是确证：一个条件 × 几千只股票总会有几只碰巧很准。`,
  stockEmpty: '没有个股达到 80 分（这条条件是靠整体表现，不是靠某几只股票）',
  stock: {
    code: '代码',
    name: '名称',
    trainScore: '推理分',
    testScore: '测试分',
    window: '最佳持有',
    winRate: '胜率',
    signals: '信号',
  },
  save: '保存条件',
  saved: (name: string) => `已保存为「${name}」`,
  saveFailed: (message: string) => `保存失败：${message}`,
  noFinalist: '这次没有条件能进入最终验算（信号太少或全部不可用）',
  ranking: '搜索过程（前 10 名）',
  rankScore: '搜索评分',
  status: {
    pending: '排队中',
    running: '进行中',
    interrupted: '已中断',
    paused: '已暂停',
    done: '已完成',
    stopped: '已停止',
    failed: '失败',
  } as Record<string, string>,
}

const T = ANALYSIS_INFER_TEXTS_ZH

function statusText(run: InferRunMeta): string {
  const alive = run.alive !== false
  if (run.status === 'running' && !alive) return T.status.interrupted
  return T.status[run.status] ?? run.status
}

export function AnalysisInferPanel({
  run,
  onPause,
  onResume,
  onStop,
  onSave,
  savedIndex,
  finalists,
  busy,
}: {
  run: InferRunMeta
  onPause?: () => void
  onResume?: () => void
  onStop?: () => void
  onSave?: (item: InferFinalist) => void
  savedIndex?: Record<number, string>
  finalists?: InferFinalist[]
  busy?: boolean
}) {
  const progress = run.progress ?? {}
  const done = progress.done_iterations ?? run.done_iterations ?? 0
  const total = progress.iterations ?? run.iterations ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const active = ['pending', 'running', 'paused'].includes(run.status) && run.alive !== false
  const exhausted = progress.exhausted ?? run.exhausted ?? false
  const finalizing = active && progress.phase === 'verifying'
  const scores = run.scores ?? null

  // 个股名单（用户 2026-11-03 第 5 条）：取入围里分数最高的那条展示
  const stockHost = (finalists ?? [])
    .filter(item => (item.stock_list?.length ?? 0) > 0)
    .sort((a, b) => (b.combined?.score ?? b.stock_best_score ?? 0) - (a.combined?.score ?? a.stock_best_score ?? 0))[0] ?? null

  return (
    <div className="space-y-2" data-fork-infer-panel={run.status}>
      <div className="rounded-lg border border-border/60 bg-accent/10 p-3">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <span className="font-medium">
            {run.preset} · {T.title} · {statusText(run)}
          </span>
          <span className="text-muted-foreground">
            {T.progressTitle(done, total)}
          </span>
        </div>

        {run.base_summary && (
          <p className="mb-1 line-clamp-2 text-[10px] text-muted-foreground">{run.base_summary}</p>
        )}

        <div className="mb-1 h-1.5 w-full overflow-hidden rounded bg-border/60">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${finalizing ? 100 : percent}%` }}
          />
        </div>

        <p className="text-[10px] text-muted-foreground" data-fork-infer-counts>
          {T.successFail(progress.successes ?? run.successes ?? done, progress.failures ?? run.failures ?? 0)}
          {' · '}
          {T.elapsed(formatInferDuration(progress.elapsed_s))}
          {active && progress.eta_s != null ? ` · ${T.eta(formatInferDuration(progress.eta_s))}` : ''}
        </p>
        {exhausted && (
          <p className="text-[10px] text-amber-600" data-fork-infer-exhausted>
            {T.exhausted(done, total)}
          </p>
        )}
        {finalizing && <p className="text-[10px] text-muted-foreground">{T.finalizing}</p>}
        {progress.current && !finalizing && active && (
          <p className="line-clamp-1 text-[10px] text-muted-foreground">{progress.current}</p>
        )}
        {run.status === 'stopped' && <p className="text-[11px]">{T.stopped}</p>}
        {run.status === 'failed' && (
          <p className="text-[11px] text-destructive">{T.failed}：{run.error ?? '—'}</p>
        )}
        {run.status === 'interrupted' && <p className="text-[11px]">{T.interrupted}</p>}

        {(active || run.status === 'paused') && (
          <div className="mt-2 flex items-center gap-2">
            {run.status === 'paused' ? (
              <Button size="sm" className="h-7 px-3 text-[12px]" onClick={onResume} disabled={busy}
                      data-fork-infer-resume>
                <Play className="h-3.5 w-3.5" />
                {T.resume}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" className="h-7 px-3 text-[12px]" onClick={onPause}
                      disabled={busy} data-fork-infer-pause>
                <Pause className="h-3.5 w-3.5" />
                {T.pause}
              </Button>
            )}
            <Button size="sm" variant="destructive" className="h-7 px-3 text-[12px]" onClick={onStop}
                    disabled={busy} data-fork-infer-stop>
              <Square className="h-3.5 w-3.5" />
              {T.stop}
            </Button>
          </div>
        )}
      </div>

      {scores && (
        <AnalysisScoreCard
          train={scores.train?.score}
          test={scores.test?.score}
          trainGrade={scores.train?.grade}
          verdict={scores.verdict ?? null}
          trainHint={scores.train?.lower_pp != null ? `超额下界 ${scores.train.lower_pp}pp` : undefined}
          testHint={scores.test?.lower_pp != null ? `超额下界 ${scores.test.lower_pp}pp` : undefined}
          compact
        />
      )}

      {finalists && finalists.length > 0 && (
        <div className="rounded-lg border border-border/60 p-2" data-fork-infer-finalists>
          <p className="mb-1 text-[11px] font-medium">{T.resultTitle}</p>
          <div className="overflow-x-auto scrollbar">
            <table className="w-full text-[11px]">
              <thead className="text-[10px] text-muted-foreground">
                <tr>
                  <th className="px-1 py-0.5 text-left">#</th>
                  <th className="px-1 py-0.5 text-left">{T.cond}</th>
                  <th className="px-1 py-0.5 text-left">{T.scopeCol}</th>
                  <th className="px-1 py-0.5 text-right">{T.trainCol}</th>
                  <th className="px-1 py-0.5 text-right">{T.testCol}</th>
                  <th className="px-1 py-0.5 text-right">{T.horizon}</th>
                  <th className="px-1 py-0.5 text-right">{T.excess}</th>
                  <th className="px-1 py-0.5 text-right">{T.events}</th>
                  <th className="px-1 py-0.5" />
                </tr>
              </thead>
              <tbody>
                {finalists.map(item => {
                  const saved = savedIndex?.[item.rank]
                  const verdict = item.combined?.verdict
                  return (
                    <tr key={item.rank} className="border-t border-border/40 align-top">
                      <td className="px-1 py-1">{item.rank}</td>
                      <td className="max-w-[420px] px-1 py-1">
                        <span className="line-clamp-2">{item.desc}</span>
                        {verdict && (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            {SCORE_VERDICTS_ZH[verdict] ?? verdict}
                          </span>
                        )}
                      </td>
                      <td className="px-1 py-1 whitespace-nowrap text-[10px]" data-fork-infer-scope={item.scope_label ?? '—'}>
                        {item.scope_label ?? '—'}
                      </td>
                      <td className="px-1 py-1 text-right">{fmt(item.train_grade?.score)}</td>
                      <td className="px-1 py-1 text-right">{fmt(item.valid_grade?.score)}</td>
                      <td className="px-1 py-1 text-right">
                        {item.train_grade?.best_window ?? item.train_horizon ?? '—'}
                      </td>
                      <td className="px-1 py-1 text-right">
                        {item.train_grade?.excess_pp != null ? `${item.train_grade.excess_pp > 0 ? '+' : ''}${item.train_grade.excess_pp}pp` : '—'}
                      </td>
                      <td className="px-1 py-1 text-right">{item.train_signals ?? '—'}</td>
                      <td className="px-1 py-1 text-right">
                        {onSave && (
                          <Button
                            size="sm"
                            variant={saved ? 'ghost' : 'secondary'}
                            className="h-6 px-2 text-[10px]"
                            disabled={Boolean(saved) || busy}
                            onClick={() => onSave(item)}
                            data-fork-infer-save={item.rank}
                          >
                            {saved ? saved : T.save}
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {stockHost && (
        <div className="rounded-lg border border-border/60 p-2" data-fork-infer-stocks>
          <p className="mb-1 text-[11px] font-medium">
            {T.stockTitle}
            <span className="ml-1 text-[10px] text-muted-foreground">
              #{stockHost.rank} · {stockHost.scope_label ?? '—'}
            </span>
          </p>
          <p className="mb-1 text-[10px] text-muted-foreground">
            {T.stockHint(stockHost.stock_qualified ?? 0, stockHost.stock_universe ?? 0)}
          </p>
          {(stockHost.stock_list?.length ?? 0) === 0 ? (
            <p className="text-[10px] text-muted-foreground">{T.stockEmpty}</p>
          ) : (
            <div className="max-h-[220px] overflow-y-auto scrollbar">
              <table className="w-full text-[11px]">
                <thead className="text-[10px] text-muted-foreground">
                  <tr>
                    <th className="px-1 py-0.5 text-left">{T.stock.code}</th>
                    <th className="px-1 py-0.5 text-left">{T.stock.name}</th>
                    <th className="px-1 py-0.5 text-right">{T.stock.trainScore}</th>
                    <th className="px-1 py-0.5 text-right">{T.stock.testScore}</th>
                    <th className="px-1 py-0.5 text-right">{T.stock.window}</th>
                    <th className="px-1 py-0.5 text-right">{T.stock.winRate}</th>
                    <th className="px-1 py-0.5 text-right">{T.stock.signals}</th>
                  </tr>
                </thead>
                <tbody>
                  {(stockHost.stock_list ?? []).slice(0, 20).map(stock => {
                    const strong = (stock.best_score ?? 0) >= 80
                    return (
                      <tr key={stock.code} className="border-t border-border/40">
                        <td className="px-1 py-1 tabular-nums">{stock.code}</td>
                        <td className="px-1 py-1">{stock.name || '—'}</td>
                        <td className={`px-1 py-1 text-right tabular-nums ${strong ? 'font-medium text-emerald-600' : ''}`}>
                          {fmt(stock.train_score)}
                        </td>
                        <td className={`px-1 py-1 text-right tabular-nums ${strong ? 'font-medium text-emerald-600' : ''}`}>
                          {fmt(stock.test_score)}
                        </td>
                        <td className="px-1 py-1 text-right">{stock.window ?? '—'}</td>
                        <td className="px-1 py-1 text-right tabular-nums">
                          {stock.train_win_rate == null ? '—' : `${stock.train_win_rate}%`}
                        </td>
                        <td className="px-1 py-1 text-right tabular-nums">
                          {stock.train_signals ?? '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {(!finalists || finalists.length === 0) && !active && run.status !== 'pending' && (
        <p className="text-[10px] text-muted-foreground">{T.noFinalist}</p>
      )}
    </div>
  )
}

function fmt(value: number | null | undefined): string {
  return value == null ? '—' : String(Math.round(value * 10) / 10)
}
