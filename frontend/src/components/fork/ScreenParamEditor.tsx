import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@panwatch/base-ui/components/ui/popover'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { ScreenNumberField } from '@/components/fork/ScreenNumberField'
import {
  CONDITION_DEFS_ZH,
  MA_PERIODS,
  MAX_CHANGE_PCT,
  MAX_CONSECUTIVE_DAYS,
  MIN_CHANGE_PCT,
  SCREEN_TEXTS_ZH,
  type ConditionName,
  type ConditionParamsMap,
  type MaPeriod,
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

      {/* 连续阳线：起点（倒数第几个交易日，默认 1）+ 天数（默认 4） */}
      {name === 'consecutive_bullish' ? (
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
      {/* w-80：三列输入（N / 下限 / 上限）要放得下，窄了会把文字挤成两行 */}
      <PopoverContent align="end" className="w-80 p-3" data-fork-screen-param-popover>
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
