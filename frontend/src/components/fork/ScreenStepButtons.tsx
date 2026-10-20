import { ChevronDown, ChevronUp } from 'lucide-react'

/**
 * fork 专用：数字输入框右侧的加减按钮（用户反馈截图 3：参照原生 number 的上下箭头）。
 *
 * 为什么自己做而不用 `type="number"`：原生 spinner 在暗色主题下几乎看不见，
 * 交互上也带不进「控件自己把值夹在合法范围内」这套规则。这里的箭头是同一个
 * 取值模型的第二组入口 —— 和手敲数字走同一条 clamp 逻辑，点不出越界值。
 *
 * 每次 ±1（用户明确要求「点击加减 1」）；到边界按钮直接禁用，
 * 而不是点了没反应。
 */

export type StepDirection = 1 | -1

/**
 * 按方向走一步。
 *
 * 空值（`Number.isFinite` 为 false）直接落到下限：用户清空后点「+」，期望看到的是
 * 「从这个字段的最小值起步」，而不是莫名其妙变成下限 +1。
 * 整数场取整；小数场留两位，避免 0.1 + 1 变成 1.1000000000000001。
 */
export function stepValue(
  current: number,
  direction: StepDirection,
  min: number,
  max: number,
  integer: boolean,
): number {
  const next = Number.isFinite(current)
    ? Math.min(max, Math.max(min, current + direction))
    : min
  return integer ? Math.round(next) : Math.round(next * 100) / 100
}

export function ScreenStepButtons({
  onStep,
  canStepUp,
  canStepDown,
  label,
}: {
  onStep: (direction: StepDirection) => void
  canStepUp: boolean
  canStepDown: boolean
  /** 无障碍名：「统计窗口 加 1」这类，由调用方给出字段名 */
  label: string
}) {
  return (
    <span
      className="absolute inset-y-0 right-0 flex w-[18px] flex-col overflow-hidden rounded-r-[5px] border-l border-input bg-background"
      data-fork-screen-stepper
    >
      {/*
        tabIndex -1：键盘用户用输入框上的 ↑/↓ 更顺手（原生 spinner 也不进 Tab 序）。
        mousedown 阻止默认行为，免得点一下就把输入框的焦点抢走 —— 连点加减时
        焦点要留在框里，箭头键才能继续用。
      */}
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${label} +1`}
        title="+1"
        disabled={!canStepUp}
        onMouseDown={event => event.preventDefault()}
        onClick={() => onStep(1)}
        className="flex flex-1 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronUp className="h-2.5 w-2.5" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label={`${label} -1`}
        title="-1"
        disabled={!canStepDown}
        onMouseDown={event => event.preventDefault()}
        onClick={() => onStep(-1)}
        className="flex flex-1 items-center justify-center border-t border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronDown className="h-2.5 w-2.5" strokeWidth={2.5} />
      </button>
    </span>
  )
}

/** 带加减按钮的数字框外壳：输入框右侧留出 18px 给按钮，边框圆角对齐。 */
export function stepFieldClasses(extra = ''): string {
  return `relative inline-flex items-stretch ${extra}`.trim()
}

export const STEP_INPUT_CLASSES =
  'h-7 w-full min-w-0 rounded-md border border-input bg-background pl-2 pr-[22px] text-[12px] font-mono text-foreground outline-none transition-colors focus:border-primary'
