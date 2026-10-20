import { useEffect, useState } from 'react'

/**
 * fork 专用：条件选股里的受控数字输入。
 *
 * 存在的理由（用户反馈截图 1）：参数浮层里 N 填了 -1，界面上就多出一行红字，
 * 浮层被撑高、参数表单被裁掉一截。做法是**控件自己挡住非法输入** —— 只接受
 * 数字（整数场不吃小数点、负数只在 min < 0 时吃一个开头的负号），越界当场
 * 夹到边界，而不是「先让你填进去，再弹红字」。
 *
 * 为什么自己留一份文本：`type="number"` 在「1.」「-」这种中间态上会给出空字符串，
 * 受控回写会把用户正在敲的内容吃掉；而每次按键都 `String(Number(text))` 又会把
 * 「1.」立刻改写成「1」，小数点敲不进去。
 */

export function ScreenNumberField({
  value,
  min,
  max,
  integer = true,
  invalid = false,
  allowEmpty = false,
  ariaLabel,
  screenField,
  paramField,
  className = '',
  onChange,
  onTouched,
}: {
  value: number
  min: number
  max: number
  /** 整数场：不吃小数点 */
  integer?: boolean
  invalid?: boolean
  /** 允许留空（模糊时保持空串，交给上层校验） */
  allowEmpty?: boolean
  ariaLabel: string
  /** `data-screen-field`：弹窗里的基础筛选字段（校验失败时按 path 聚焦） */
  screenField?: string
  /** `data-screen-param-field`：条件参数里的字段 */
  paramField?: string
  className?: string
  onChange: (value: number) => void
  onTouched?: () => void
}) {
  const [text, setText] = useState(() => (Number.isFinite(value) ? String(value) : ''))

  // 父级把值换掉（换条件 / 恢复草稿 / 回填上次请求）时才同步；
  // 比较数值而不是字符串，免得用户正在敲的「1.」被立刻改写成「1」。
  useEffect(() => {
    if (Number(text) !== value) setText(Number.isFinite(value) ? String(value) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const handleChange = (raw: string) => {
    const cleaned = cleanNumeric(raw, integer, min < 0)
    // 空 / 只有一个负号或小数点：先留着，交给 blur 兜底
    if (cleaned === '' || cleaned === '-' || cleaned === '.') {
      setText(cleaned)
      return
    }
    const parsed = Number(cleaned)
    if (!Number.isFinite(parsed)) {
      setText(cleaned)
      return
    }
    if (parsed < min) {
      setText(String(min))
      onChange(min)
      return
    }
    if (parsed > max) {
      setText(String(max))
      onChange(max)
      return
    }
    setText(cleaned)
    onChange(parsed)
  }

  return (
    <input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      role="spinbutton"
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number.isFinite(value) ? value : undefined}
      data-screen-field={screenField}
      data-screen-param-field={paramField}
      value={text}
      onBlur={() => {
        onTouched?.()
        if (text === '' || text === '-' || text === '.') {
          if (allowEmpty) {
            setText('')
            return
          }
          setText(String(min))
          onChange(min)
        }
      }}
      onChange={event => handleChange(event.target.value)}
      className={`h-7 w-full min-w-0 rounded-md border border-input bg-background px-2 text-[12px] font-mono text-foreground outline-none transition-colors focus:border-primary ${
        invalid ? 'border-destructive' : ''
      } ${className}`}
    />
  )
}

/** 只保留允许的字符（整数不带小数点；负数只在 min < 0 时允许开头一个负号）。 */
export function cleanNumeric(raw: string, integer: boolean, allowNegative: boolean): string {
  let out = ''
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch
    else if (ch === '.' && !integer) out += ch
    else if (ch === '-' && allowNegative && out === '') out += ch
  }
  return out
}
