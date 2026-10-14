import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@panwatch/base-ui/components/ui/popover'
import { cn } from '@panwatch/base-ui'

/**
 * fork：分析页筛选行用的**多选下拉**。
 *
 * 用户要求筛选做成「机会页」那种下拉形式，并且「多选的下拉菜单也要多选」。
 * base-ui 里只有单选的下拉（``Select``，Radix Select 的 Trigger 必须挂在
 * Select.Root 下面，没法拿来做多选），所以这里用 Popover + 带勾选项的自建菜单，
 * 触发器按 SelectTrigger 的样子描（h-8 / text-[12px] / rounded-xl / border-border /
 * bg-card），保证和旁边那个单选的「涨跌」下拉长得一样。
 *
 * 语义（与 lib/market-filters.ts 的多选组一致）：
 *   - 一项都不选 = 「不限」，触发器上显示 ``allLabel``（如「全部状态」）
 *   - 勾若干项 = 并集（命中任一即通过）
 *   - 菜单第一行是 ``allLabel``，点它等于清空这一组
 */

const MULTI_SELECT_TEXTS_ZH = {
  /** 选了 1 项：直接显示那一项 */
  one: (label: string) => label,
  /** 选了多项：显示第一项 + 数量 */
  many: (label: string, count: number) => `${label} 等 ${count} 项`,
  /** 触发器 title（悬停能看到完整列表） */
  title: (label: string, allLabel: string, labels: string[]) =>
    labels.length === 0 ? `${label}：${allLabel}` : `${label}：${labels.join('、')}`,
}

export interface MultiSelectOption {
  key: string
  label: string
  hint?: string
}

interface MultiSelectFilterProps {
  /** 触发器上显示的名字（为空时显示 allLabel） */
  label: string
  /** 「不限」的文案，如「全部状态」「全部市值」 */
  allLabel: string
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  className?: string
}

export function MultiSelectFilter({
  label,
  allLabel,
  options,
  value,
  onChange,
  className,
}: MultiSelectFilterProps) {
  const selectedLabels = options.filter(option => value.includes(option.key)).map(option => option.label)
  const summary =
    selectedLabels.length === 0
      ? allLabel
      : selectedLabels.length === 1
        ? MULTI_SELECT_TEXTS_ZH.one(selectedLabels[0])
        : MULTI_SELECT_TEXTS_ZH.many(selectedLabels[0], selectedLabels.length)

  const toggle = (key: string) => {
    onChange(value.includes(key) ? value.filter(item => item !== key) : [...value, key])
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-label={label}
          title={MULTI_SELECT_TEXTS_ZH.title(label, allLabel, selectedLabels)}
          className={cn(
            'inline-flex h-8 items-center justify-between gap-1.5 rounded-xl border border-border bg-card px-3 text-[12px] shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-all hover:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/20',
            value.length > 0 ? 'text-foreground' : 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1" role="listbox">
        <button
          type="button"
          role="option"
          aria-selected={value.length === 0}
          onClick={() => onChange([])}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent/50"
        >
          <Check className={cn('h-3.5 w-3.5 shrink-0 text-primary', value.length === 0 ? '' : 'opacity-0')} />
          <span className="truncate">{allLabel}</span>
        </button>
        {options.map(option => {
          const checked = value.includes(option.key)
          return (
            <button
              key={option.key}
              type="button"
              role="option"
              aria-selected={checked}
              title={option.hint}
              onClick={() => toggle(option.key)}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-accent/50"
            >
              <Check className={cn('h-3.5 w-3.5 shrink-0 text-primary', checked ? '' : 'opacity-0')} />
              <span className="truncate">{option.label}</span>
              {option.hint && (
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/60">{option.hint}</span>
              )}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}

export default MultiSelectFilter
