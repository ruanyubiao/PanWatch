import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@panwatch/base-ui/components/ui/popover'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@panwatch/base-ui/components/ui/select'
import { ScreenNumberField } from '@/components/fork/ScreenNumberField'
import {
  CONDITION_DEFS_ZH,
  MA_PERIODS,
  MAX_CHANGE_PCT,
  MAX_CONSECUTIVE_DAYS,
  MAX_MARKET_CAP_YI,
  METRIC_TEXTS_ZH,
  MIN_CHANGE_PCT,
  SCREEN_TEXTS_ZH,
  daySlot,
  metricBounds,
  metricOf,
  type ConditionName,
  type ConditionParamsMap,
  type MaDayParams,
  type MaOrderDayParams,
  type MaPeriod,
  type MarketCapOp,
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

/** 均线排列的 6 个变体（周期多选 + 按日定位）。 */
const MA_ORDER_NAMES: ConditionName[] = [
  'ma_bullish',
  'ma_bullish_all',
  'ma_bullish_any',
  'ma_bearish',
  'ma_bearish_all',
  'ma_bearish_any',
]

/** 股价站上均线的 3 个变体（单周期 + 按日定位）。 */
const MA_ABOVE_NAMES: ConditionName[] = ['close_above_ma', 'close_above_ma_all', 'close_above_ma_any']

const PARAM_TEXTS_ZH = {
  /** 单日：一个 N */
  dayOnly: '只看倒数第 N 个交易日；N = 1 就是数据截至那天（默认）',
  /** 区间：N ～ M */
  spanOnly: (limit: number) => `起点 n ～ 终点 f 个交易日（n 更近、f 更早，跨度不超过 ${limit} 个交易日）`,
  nLabel: '倒数第 N 日',
  spanStart: '起点 N（更近）',
  spanEnd: '终点 M（更早）',
  endEmpty: '留空 = 统计窗口的最后一天',
}

/**
 * 按日定位的输入（2026-10-23 第 6 条）。
 *
 * 所有需要「倒数第 N 日」的条件都走这一份，不再各写一遍 N 输入框：
 * - ``single``：一个 N；
 * - ``range``：N + M（范围内每日 / 任意一天）；
 * - ``range-window``：N + M，但 M 允许留空 = 整个统计窗口（阴阳线计数）。
 */
function DayFields({
  mode,
  draft,
  tradingDays,
  invalid,
  onTouched,
  onPatch,
}: {
  mode: 'single' | 'range' | 'range-window'
  draft: Record<string, unknown>
  tradingDays: number
  invalid: boolean
  onTouched: () => void
  onPatch: (patch: Record<string, number>) => void
}) {
  const limit = Math.max(1, Math.trunc(tradingDays || 1))
  const n = daySlot(draft as { n?: number })
  const m = Number((draft as { m?: number }).m)

  const field = (key: 'n' | 'm', label: string, value: number, min: number) => (
    <div className="min-w-0 space-y-1">
      <Label className="block truncate text-[11px] text-muted-foreground">{label}</Label>
      <ScreenNumberField
        paramField={key}
        ariaLabel={label}
        value={value}
        min={min}
        max={limit}
        invalid={invalid}
        onTouched={onTouched}
        onChange={next => onPatch({ [key]: next })}
      />
    </div>
  )

  if (mode === 'single') {
    return (
      <div className="space-y-1" data-fork-screen-day="single">
        <div className="grid grid-cols-2 gap-2">
          {field('n', PARAM_TEXTS_ZH.nLabel, n, 1)}
          <div className="flex items-end pb-1 text-[11px] leading-4 text-muted-foreground">
            {PARAM_TEXTS_ZH.dayOnly}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1" data-fork-screen-day={mode}>
      <div className="grid grid-cols-2 gap-2">
        {field('n', PARAM_TEXTS_ZH.spanStart, n, 1)}
        {mode === 'range-window' ? (
          <div className="min-w-0 space-y-1">
            <Label className="block truncate text-[11px] text-muted-foreground">{PARAM_TEXTS_ZH.spanEnd}</Label>
            {/*
              M 用 0 当「整个统计窗口」的哨兵，所以这里不能用 ScreenNumberField
              （它不接受空串）：留空 → 0，输入框显示空、占位符写窗口长度。
            */}
            <input
              type="text"
              inputMode="numeric"
              role="spinbutton"
              aria-label={PARAM_TEXTS_ZH.spanEnd}
              aria-valuemin={1}
              aria-valuemax={limit}
              data-screen-param-field="m"
              value={Number.isFinite(m) && m > 0 ? String(m) : ''}
              placeholder={String(limit)}
              onChange={event => {
                const digits = event.target.value.replace(/[^0-9]/g, '')
                onTouched()
                if (digits === '') {
                  onPatch({ m: 0 })
                  return
                }
                const parsed = Math.min(limit, Math.max(1, Number(digits)))
                onPatch({ m: parsed })
              }}
              onBlur={onTouched}
              className={`h-7 w-full rounded-md border bg-background px-2 text-[12px] text-foreground ${
                invalid ? 'border-destructive' : 'border-input'
              }`}
            />
          </div>
        ) : (
          field('m', PARAM_TEXTS_ZH.spanEnd, Number.isFinite(m) && m > 0 ? m : Math.max(n, 1), n)
        )}
      </div>
      <div className="text-[11px] leading-4 text-muted-foreground">
        {mode === 'range-window'
          ? PARAM_TEXTS_ZH.endEmpty
          : PARAM_TEXTS_ZH.spanOnly(Number.isFinite(tradingDays) && tradingDays >= 1 ? Math.trunc(tradingDays) : 250)}
      </div>
    </div>
  )
}

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
      {MA_ORDER_NAMES.includes(name) ? (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">{T.periodsLabel}</Label>
          <div className="flex flex-wrap gap-1">
            {MA_PERIODS.map(period => {
              const selected = (draft as MaOrderDayParams).periods.includes(period)
              return (
                <button
                  key={period}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    const current = (draft as MaOrderDayParams).periods
                    const next = selected
                      ? current.filter(item => item !== period)
                      : [...current, period]
                    // 保留 n / m（按日定位）：只改周期，不能把「倒数第 N 日」清掉
                    setDraft({ ...(draft as MaOrderDayParams), periods: next } as ConditionParamsMap[ConditionName])
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

      {MA_ABOVE_NAMES.includes(name) ? (
        <div className="space-y-1.5">
          <Label className="text-[11px] text-muted-foreground">{T.periodLabel}</Label>
          <div className="flex flex-wrap gap-1">
            {MA_PERIODS.map(period => {
              const selected = (draft as MaDayParams).period === period
              return (
                <button
                  key={period}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    setDraft({ ...(draft as MaDayParams), period: period as MaPeriod } as ConditionParamsMap[ConditionName])
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

      {def.daySelector ? (
        <DayFields
          mode={def.daySelector}
          draft={draft as unknown as Record<string, unknown>}
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
    // 三个文本条件共用这个编辑器，标题/占位/说明按条件分开说
    const isCode = name === 'stock_code'
    const isName = name === 'stock_name'
    const label = isCode ? M.labelStockCode : isName ? M.labelStockName : M.stockLabel
    const placeholder = isCode
      ? M.stockCodePlaceholder
      : isName
        ? M.stockNamePlaceholder
        : M.stockPlaceholder
    const hint = isCode ? M.descStockCode : isName ? M.descStockName : M.stockHint
    return (
      <div className="space-y-1.5" data-fork-screen-metric-editor="text">
        <Label className="text-[11px] text-muted-foreground">{label}</Label>
        <Input
          className="h-7 text-[12px]"
          aria-label={label}
          placeholder={placeholder}
          value={String(draft.text ?? '')}
          onChange={event => onPatch({ text: event.target.value })}
          data-fork-screen-param-field="text"
        />
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
    )
  }

  if (editor === 'market-cap-op') {
    const op = String(draft.op ?? 'gte')
    const options: { value: MarketCapOp; label: string }[] = [
      { value: 'gt', label: M.opGt },
      { value: 'gte', label: M.opGte },
      { value: 'lt', label: M.opLt },
      { value: 'lte', label: M.opLte },
    ]
    return (
      <div className="space-y-2" data-fork-screen-metric-editor="market-cap-op">
        <div className="text-[11px] leading-4 text-muted-foreground">{M.marketCapHint}</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 space-y-1">
            <Label className="block truncate text-[11px] text-muted-foreground">
              {M.marketCapOpLabel}
            </Label>
            <Select value={op} onValueChange={value => onPatch({ op: value })}>
              <SelectTrigger
                aria-label={M.marketCapOpLabel}
                data-fork-screen-param-field="op"
                className="h-7 px-1.5 text-[12px]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map(option => (
                  <SelectItem key={option.value} value={option.value} className="text-[12px]">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {field('value', M.marketCapValueLabel, 0, MAX_MARKET_CAP_YI, false)}
        </div>
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
