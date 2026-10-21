import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@panwatch/base-ui/components/ui/popover'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { ScreenNumberField } from '@/components/fork/ScreenNumberField'
import {
  CONDITION_DEFS_ZH,
  MA_PERIODS,
  MAX_CHANGE_PCT,
  MAX_CONSECUTIVE_DAYS,
  METRIC_TEXTS_ZH,
  MIN_CHANGE_PCT,
  SCREEN_TEXTS_ZH,
  metricBounds,
  metricOf,
  type ConditionName,
  type ConditionParamsMap,
  type MaPeriod,
  type ParamEditorKind,
} from '@/lib/screen-rule'

/**
 * fork 专用：条件参数编辑表单（需求规格 §5.3）。
 *
 * 只做「某一种条件的参数长什么样」，不关心它被放在哪里：
 * - 添加条件时嵌在 `ScreenConditionPicker` 的浮层里（确定后插入）；
 * - 编辑已有条件时嵌在条件行的浮层里（确定后原地更新）。
 *
 * 表单内部持有 draft，点「确定」才把参数抛出去 —— 「取消」必须不修改任何东西，
 * 否则用户会看到「我明明点了取消，条件却变了」。
 *
 * 数字框统一用 `ScreenNumberField`：控件自己挡住非法输入（只吃数字/小数点/负号，
 * 越界立刻夹到边界），不再靠「填错了再弹红字」—— 之前 N 填 -1 会把浮层顶成
 * 两行、参数表单被裁掉一截（用户反馈截图 1）。
 */

const T = SCREEN_TEXTS_ZH

// ---------------------------------------------------------------- 表单

export function ScreenParamForm({
  name,
  value,
  tradingDays,
  onConfirm,
  onCancel,
}: {
  name: ConditionName
  value: ConditionParamsMap[ConditionName]
  tradingDays: number
  onConfirm: (params: ConditionParamsMap[ConditionName]) => void
  onCancel: () => void
}) {
  const def = CONDITION_DEFS_ZH[name]
  const [draft, setDraft] = useState<ConditionParamsMap[ConditionName]>(() => clone(value))
  const [touched, setTouched] = useState(false)

  // 换条件时重置草稿（同一个浮层里「选中 A 又改成 B」）
  useEffect(() => {
    setDraft(clone(value))
    setTouched(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  const issues = def.validate(draft as never, tradingDays)
  const maxDays = Math.min(tradingDays, MAX_CONSECUTIVE_DAYS)

  const markTouched = () => setTouched(true)
  const invalid = touched && issues.length > 0

  return (
    <div className="space-y-2" data-fork-screen-param={name}>
      {name === 'ma_bullish' || name === 'ma_bearish' ? (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">{T.periodsLabel}</Label>
          <div className="flex flex-wrap gap-1">
            {MA_PERIODS.map(period => {
              const selected = (draft as ConditionParamsMap['ma_bullish']).periods.includes(period)
              return (
                <button
                  key={period}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    const current = (draft as ConditionParamsMap['ma_bullish']).periods
                    const next = selected
                      ? current.filter(item => item !== period)
                      : [...current, period]
                    setDraft({ periods: next } as ConditionParamsMap[ConditionName])
                  }}
                  className={`rounded border px-1.5 py-0.5 text-[11px] font-mono transition-colors ${
                    selected
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {`MA${period}`}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {name === 'close_above_ma' ? (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">{T.periodLabel}</Label>
          <div className="flex flex-wrap gap-1">
            {MA_PERIODS.map(period => {
              const selected = (draft as ConditionParamsMap['close_above_ma']).period === period
              return (
                <button
                  key={period}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setDraft({ period: period as MaPeriod } as ConditionParamsMap[ConditionName])
                  }
                  className={`rounded border px-1.5 py-0.5 text-[11px] font-mono transition-colors ${
                    selected
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {`MA${period}`}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* 连续阳线 / 连续上涨：起点（倒数第几个交易日，默认 1）+ 天数 */}
      {name === 'consecutive_bullish' || name === 'consecutive_rising' ? (
        <>
          {/* 输入时就把「从倒数第几日、连续几日」念一遍 —— description 说不清两个参数的关系。
              两个条件的参数形状一样、判据不同，所以提示语按条件名分开说。 */}
          <div
            className="text-[11px] leading-4 text-muted-foreground"
            data-fork-screen-consecutive-hint=""
          >
            {name === 'consecutive_rising'
              ? T.consecutiveRisingHint(
                  (draft as ConditionParamsMap['consecutive_rising']).start,
                  (draft as ConditionParamsMap['consecutive_rising']).days,
                )
              : T.consecutiveHint(
                  (draft as ConditionParamsMap['consecutive_bullish']).start,
                  (draft as ConditionParamsMap['consecutive_bullish']).days,
                )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0 space-y-1">
              <Label className="block truncate text-[11px] text-muted-foreground">
                {`${T.startLabel}（1 – ${maxDays}）`}
              </Label>
              <ScreenNumberField
                paramField="start"
                ariaLabel={T.startLabel}
                value={(draft as ConditionParamsMap['consecutive_bullish']).start}
                min={1}
                max={maxDays}
                invalid={invalid}
                onTouched={markTouched}
                onChange={next =>
                  setDraft({
                    ...(draft as ConditionParamsMap['consecutive_bullish']),
                    start: next,
                  } as ConditionParamsMap[ConditionName])
                }
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="block truncate text-[11px] text-muted-foreground">
                {`${T.daysLabel}（1 – ${maxDays}）`}
              </Label>
              <ScreenNumberField
                paramField="days"
                ariaLabel={T.daysLabel}
                value={(draft as ConditionParamsMap['consecutive_bullish']).days}
                min={1}
                max={maxDays}
                invalid={invalid}
                onTouched={markTouched}
                onChange={next =>
                  setDraft({
                    ...(draft as ConditionParamsMap['consecutive_bullish']),
                    days: next,
                  } as ConditionParamsMap[ConditionName])
                }
              />
            </div>
          </div>
        </>
      ) : null}

      {name === 'change_pct' ? (
        <div className="space-y-1.5">
          {/* 三列放不下「N（倒数第几个交易日）」这种长标题，所以标题只留 N，
              完整含义写在上面这行提示里（用户反馈截图 1：长标题把浮层顶到裁切） */}
          <div className="text-[11px] text-muted-foreground">{T.changePctHint(Math.max(1, tradingDays))}</div>
          <div className="grid grid-cols-3 gap-2">
            <div className="min-w-0 space-y-1">
              <Label className="block text-[11px] text-muted-foreground">{T.nShortLabel}</Label>
              <ScreenNumberField
                paramField="n"
                ariaLabel={T.nLabel}
                value={(draft as ConditionParamsMap['change_pct']).n}
                min={1}
                max={Math.max(1, tradingDays)}
                invalid={invalid}
                onTouched={markTouched}
                onChange={next =>
                  setDraft({
                    ...(draft as ConditionParamsMap['change_pct']),
                    n: next,
                  } as ConditionParamsMap[ConditionName])
                }
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="block text-[11px] text-muted-foreground">{T.pctMinLabel}</Label>
              <ScreenNumberField
                paramField="min"
                ariaLabel={T.pctMinLabel}
                value={(draft as ConditionParamsMap['change_pct']).min}
                min={MIN_CHANGE_PCT}
                max={MAX_CHANGE_PCT}
                integer={false}
                invalid={invalid}
                onTouched={markTouched}
                onChange={next =>
                  setDraft({
                    ...(draft as ConditionParamsMap['change_pct']),
                    min: next,
                  } as ConditionParamsMap[ConditionName])
                }
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="block text-[11px] text-muted-foreground">{T.pctMaxLabel}</Label>
              <ScreenNumberField
                paramField="max"
                ariaLabel={T.pctMaxLabel}
                value={(draft as ConditionParamsMap['change_pct']).max}
                min={MIN_CHANGE_PCT}
                max={MAX_CHANGE_PCT}
                integer={false}
                invalid={invalid}
                onTouched={markTouched}
                onChange={next =>
                  setDraft({
                    ...(draft as ConditionParamsMap['change_pct']),
                    max: next,
                  } as ConditionParamsMap[ConditionName])
                }
              />
            </div>
          </div>
        </div>
      ) : null}

      {def.editor ? (
        <MetricParamFields
          name={name}
          editor={def.editor}
          draft={draft as unknown as Record<string, number | string>}
          tradingDays={tradingDays}
          invalid={invalid}
          onTouched={markTouched}
          onPatch={patch =>
            setDraft({
              ...(draft as Record<string, unknown>),
              ...patch,
            } as ConditionParamsMap[ConditionName])
          }
        />
      ) : null}

      {invalid ? (
        <div className="space-y-0.5 text-[11px] leading-snug text-destructive" data-fork-screen-param-issue>
          {issues.map(issue => (
            <div key={issue}>{issue}</div>
          ))}
        </div>
      ) : null}

      <div className="flex justify-end gap-1.5 pt-1">
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={onCancel}>
          {T.paramCancel}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2 text-[12px]"
          onClick={() => {
            setTouched(true)
            if (issues.length === 0) onConfirm(draft)
          }}
        >
          {T.paramConfirm}
        </Button>
      </div>
    </div>
  )
}

/** 挂在「编辑」按钮上的浮层版。 */
export function ScreenParamEditor({
  name,
  value,
  tradingDays,
  onConfirm,
  trigger,
}: {
  name: ConditionName
  value: ConditionParamsMap[ConditionName]
  tradingDays: number
  onConfirm: (params: ConditionParamsMap[ConditionName]) => void
  trigger: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const key = useMemo(() => JSON.stringify(value), [value])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {/* w-[22rem]：三列参数（N / 下限 / 上限）各自带加减按钮，320px 会把标题挤成两行 */}
      <PopoverContent align="end" className="w-[22rem] p-3" data-fork-screen-param-popover>
        <ScreenParamForm
          key={key}
          name={name}
          value={value}
          tradingDays={tradingDays}
          onCancel={() => setOpen(false)}
          onConfirm={params => {
            onConfirm(params)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function clone<P>(value: P): P {
  return JSON.parse(JSON.stringify(value)) as P
}

// ---------------------------------------------------------------- 量价条件的表单

/**
 * 量价 / 第二批条件的参数表单。
 *
 * 以前每个条件在 `ScreenParamForm` 里各写一段 JSX（新增 27 条就得写 27 段）。
 * 现在按 `def.editor`（single / range / consecutive / lookback / ma-cross / text）
 * 渲染 —— 形状只有五种，指标只影响单位与上下限。
 */
function MetricParamFields({
  name,
  editor,
  draft,
  tradingDays,
  invalid,
  onTouched,
  onPatch,
}: {
  name: ConditionName
  editor: ParamEditorKind
  draft: Record<string, number | string>
  tradingDays: number
  invalid: boolean
  onTouched: () => void
  onPatch: (patch: Record<string, number | string>) => void
}) {
  const M = METRIC_TEXTS_ZH
  const spec = metricOf(name)
  const defaults = CONDITION_DEFS_ZH[name].defaults as unknown as Record<string, number | string>
  const limit = Number.isFinite(tradingDays) && tradingDays >= 1 ? Math.trunc(tradingDays) : 250
  const consecutiveLimit = Math.min(limit, MAX_CONSECUTIVE_DAYS)
  const isRatio = spec?.metric === 'vol_ratio'
  const [lo, hi] = spec ? metricBounds(spec.metric) : ([0, 1e9] as [number, number])
  const unitText = spec ? METRIC_TEXTS_ZH.unit[spec.metric] : ''

  const num = (key: string): number => {
    const parsed = Number(draft[key])
    if (Number.isFinite(parsed)) return parsed
    const fallback = Number(defaults[key])
    return Number.isFinite(fallback) ? fallback : 0
  }

  const field = (key: string, label: string, min: number, max: number, integer = true) => (
    <div key={key} className="min-w-0 space-y-1">
      <Label className="block truncate text-[11px] text-muted-foreground">{label}</Label>
      <ScreenNumberField
        paramField={key}
        ariaLabel={label}
        value={num(key)}
        min={min}
        max={max}
        integer={integer}
        invalid={invalid}
        onTouched={onTouched}
        onChange={next => onPatch({ [key]: next })}
      />
    </div>
  )

  const rangeFields = (minField: number, maxField: number, integer: boolean) => (
    <div className="space-y-1">
      <div className="grid grid-cols-2 gap-2">
        {field('min', M.minLabel, minField, maxField, integer)}
        {field('max', M.maxLabel, minField, maxField, integer)}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {M.unitSuffix(unitText)}
      </div>
    </div>
  )

  if (editor === 'text') {
    return (
      <div className="space-y-1.5" data-fork-screen-metric-editor="text">
        <Label className="text-[11px] text-muted-foreground">{M.stockLabel}</Label>
        <Input
          className="h-7 text-[12px]"
          aria-label={M.stockLabel}
          placeholder={M.stockPlaceholder}
          value={String(draft.text ?? '')}
          onChange={event => onPatch({ text: event.target.value })}
          data-fork-screen-param-field="text"
        />
        <div className="text-[11px] text-muted-foreground">{M.stockHint}</div>
      </div>
    )
  }

  if (editor === 'lookback') {
    return (
      <div className="space-y-2" data-fork-screen-metric-editor="lookback">
        <div className="text-[11px] leading-4 text-muted-foreground">{M.lookbackHint(limit)}</div>
        <div className="grid grid-cols-3 gap-2">{field('m', M.lookbackLabel, 1, limit)}</div>
      </div>
    )
  }

  if (editor === 'ma-cross') {
    return (
      <div className="space-y-2" data-fork-screen-metric-editor="ma-cross">
        {(['fast', 'slow'] as const).map(key => (
          <div key={key} className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">
              {key === 'fast' ? M.crossFast : M.crossSlow}
            </Label>
            <div className="flex flex-wrap gap-1">
              {MA_PERIODS.map(period => {
                const selected = Number(draft[key]) === period
                return (
                  <button
                    key={period}
                    type="button"
                    aria-pressed={selected}
                    data-fork-screen-cross-period={`${key}-${period}`}
                    onClick={() => onPatch({ [key]: period })}
                    className={`rounded border px-1.5 py-0.5 text-[11px] font-mono transition-colors ${
                      selected
                        ? 'border-primary/60 bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {`MA${period}`}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <div className="text-[11px] text-muted-foreground">{M.crossHint}</div>
      </div>
    )
  }

  const hint =
    editor === 'metric-consecutive'
      ? M.hintConsecutive
      : editor === 'metric-single'
        ? M.hintSingle(limit)
        : M.hintRange(limit)

  return (
    <div className="space-y-2" data-fork-screen-metric-editor={editor}>
      <div className="text-[11px] leading-4 text-muted-foreground">{hint}</div>
      {editor === 'metric-single' ? (
        <div className="space-y-1">
          <div className="grid grid-cols-3 gap-2">
            {field('n', M.nShortLabel, 1, limit)}
            {field('min', M.minLabel, lo, hi, false)}
            {field('max', M.maxLabel, lo, hi, false)}
          </div>
          <div className="text-[11px] text-muted-foreground">{M.unitSuffix(unitText)}</div>
        </div>
      ) : null}
      {editor === 'metric-range' ? (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-2">
            {field('n', M.startLabel, 1, limit)}
            {field('m', M.endLabel, 1, limit)}
          </div>
          {rangeFields(lo, hi, false)}
        </div>
      ) : null}
      {editor === 'metric-consecutive' ? (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-2">
            {field('start', M.consecutiveStartLabel, 1, consecutiveLimit)}
            {field('days', M.consecutiveDaysLabel, 1, consecutiveLimit)}
          </div>
          {rangeFields(lo, hi, false)}
        </div>
      ) : null}
      {isRatio ? (
        <div className="grid grid-cols-3 gap-2">
          {field('window', M.windowLabel, 1, 60)}
          <div className="col-span-2 flex items-end pb-1 text-[11px] leading-4 text-muted-foreground">
            {M.hintVolRatio}
          </div>
        </div>
      ) : null}
    </div>
  )
}
