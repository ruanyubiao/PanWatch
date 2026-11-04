/**
 * 两个评分（推理段 / 测试段）—— 用户 2026-10-24 第 1/9 条。
 *
 * 为什么单独做一张卡：用户明确说「你输出的一大堆数据，我看不懂，现在最后输出的是评分，
 * 这样可以直接一眼看出好不好」。所以这两个数必须出现在最上面、字号最大，而且必须
 * 带一句人话（60 分 = 能拿去用；50 分 = 和随机一样）。
 */

export const ANALYSIS_SCORE_TEXTS_ZH = {
  train: '推理评分',
  test: '验证评分',
  single: '评分',
  pending: '跑完才有分数',
  scale: '50 = 和随机买入一样 · 60 = 及格（能拿去用）· 85 以上 = 优秀',
  verdict: '综合判断',
  lower: (value: number) => `超额下界 ${value}pp`,
  window: (days: number) => `最优 ${days} 日`,
  caps: '封顶原因',
}

export const SCORE_VERDICTS_ZH: Record<string, string> = {
  pass: '可以用',
  watch: '观察',
  fragile: '像过拟合',
  fail: '不可用',
  unknown: '说不清',
}

export function scoreTone(score: number | null | undefined): string {
  if (score == null) return 'border-border/60 text-muted-foreground'
  if (score >= 85) return 'border-emerald-500/50 bg-emerald-500/10 text-emerald-500'
  if (score >= 70) return 'border-sky-500/50 bg-sky-500/10 text-sky-500'
  if (score >= 60) return 'border-amber-500/50 bg-amber-500/10 text-amber-500'
  return 'border-destructive/40 bg-destructive/10 text-destructive'
}

function ScoreBox({
  label,
  score,
  grade,
  hint,
}: {
  label: string
  score: number | null | undefined
  grade?: string
  hint?: string
}) {
  const value = score == null ? '—' : Math.round(score * 10) / 10
  return (
    <div
      className={`flex min-w-[132px] flex-col rounded-lg border px-3 py-2 ${scoreTone(score)}`}
      data-fork-score={label}
    >
      <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
      <span className="flex items-baseline gap-1">
        <span className="text-[26px] font-semibold leading-none">{value}</span>
        {grade && <span className="text-[11px] opacity-80">{grade}</span>}
      </span>
      {hint && <span className="mt-0.5 text-[10px] text-muted-foreground">{hint}</span>}
    </div>
  )
}

export interface AnalysisScoreCardProps {
  train?: number | null
  test?: number | null
  trainGrade?: string | null
  verdict?: { verdict?: string; text?: string; score?: number | null } | null
  trainHint?: string
  testHint?: string
  compact?: boolean
}

export function AnalysisScoreCard({
  train,
  test,
  trainGrade,
  verdict,
  trainHint,
  testHint,
  compact = false,
}: AnalysisScoreCardProps) {
  const T = ANALYSIS_SCORE_TEXTS_ZH
  const label = verdict?.verdict ? SCORE_VERDICTS_ZH[verdict.verdict] ?? verdict.verdict : null
  // 用户 2026-11-04 第 1 条：分析任务只剩一段（不再有测试段），所以只画一张卡；
  // 有条件推理的老任务仍然有两段，照样两张。
  const single = test == null
  return (
    <div className="rounded-lg border border-border/60 bg-accent/10 p-3" data-fork-analysis-scores>
      <div className="flex flex-wrap items-stretch gap-2">
        <ScoreBox label={single ? T.single : T.train} score={train} grade={trainGrade ?? undefined}
                  hint={trainHint} />
        {!single && <ScoreBox label={T.test} score={test} grade={undefined} hint={testHint} />}
        <div className="flex min-w-[180px] flex-1 flex-col justify-center gap-0.5 text-[11px]">
          {label && (
            <p>
              <span className="text-muted-foreground">{T.verdict}：</span>
              <span className="font-medium">{label}</span>
              {verdict?.text ? <span className="text-muted-foreground"> · {verdict.text}</span> : null}
            </p>
          )}
          {!compact && <p className="text-[10px] text-muted-foreground">{T.scale}</p>}
          {train == null && test == null && (
            <p className="text-[10px] text-muted-foreground">{T.pending}</p>
          )}
        </div>
      </div>
    </div>
  )
}
