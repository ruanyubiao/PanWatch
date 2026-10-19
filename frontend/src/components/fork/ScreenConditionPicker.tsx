import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@panwatch/base-ui/components/ui/popover'
import { Input } from '@panwatch/base-ui/components/ui/input'
import {
  CONDITION_CATEGORIES,
  CONDITION_DEFS_ZH,
  CONDITION_NAMES,
  SCREEN_TEXTS_ZH,
  type ConditionName,
  type ConditionParamsMap,
} from '@/lib/screen-rule'
import { ScreenParamForm } from '@/components/fork/ScreenParamEditor'

/**
 * fork 专用：条件选择列表（需求规格 §5.3）。
 *
 * 点「+ 条件」打开：顶部搜索框按名称/说明模糊匹配，列表按分类分组。
 * 选中**有参数**的条件后，浮层**原地**切换成参数表单（不新开一层浮层，
 * 否则会叠两个 popover，点外面先关掉的是里面那个）；「确定」才插入。
 */

const T = SCREEN_TEXTS_ZH

export function ScreenConditionPicker({
  tradingDays,
  onPick,
  trigger,
}: {
  tradingDays: number
  onPick: (name: ConditionName, params: ConditionParamsMap[ConditionName]) => void
  trigger: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<ConditionName | null>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return CONDITION_NAMES
    return CONDITION_NAMES.filter(name => {
      const def = CONDITION_DEFS_ZH[name]
      return (
        def.label.toLowerCase().includes(needle) ||
        def.description.toLowerCase().includes(needle)
      )
    })
  }, [query])

  const reset = () => {
    setQuery('')
    setPending(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2" data-fork-screen-picker>
        {pending ? (
          <ScreenParamForm
            name={pending}
            value={CONDITION_DEFS_ZH[pending].defaults}
            tradingDays={tradingDays}
            onCancel={() => setPending(null)}
            onConfirm={params => {
              onPick(pending, params)
              setOpen(false)
              reset()
            }}
          />
        ) : (
          <div className="space-y-1.5">
            <Input
              autoFocus
              placeholder={T.pickerSearch}
              className="h-7 text-[12px]"
              value={query}
              onChange={event => setQuery(event.target.value)}
              data-fork-screen-picker-search
            />
            <div className="max-h-72 overflow-y-auto scrollbar">
              {filtered.length === 0 ? (
                <div className="py-4 text-center text-[11px] text-muted-foreground">{T.pickerEmpty}</div>
              ) : (
                CONDITION_CATEGORIES.map(category => {
                  const items = filtered.filter(name => CONDITION_DEFS_ZH[name].category === category)
                  if (items.length === 0) return null
                  return (
                    <div key={category} className="py-1">
                      <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {category}
                      </div>
                      {items.map(name => {
                        const def = CONDITION_DEFS_ZH[name]
                        return (
                          <button
                            key={name}
                            type="button"
                            onClick={() => {
                              // 有参数的条件先展开参数表单；无参数的（阴阳线计数）直接插入
                              if (Object.keys(def.defaults).length > 0) {
                                setPending(name)
                                return
                              }
                              onPick(name, def.defaults)
                              setOpen(false)
                              reset()
                            }}
                            className="block w-full rounded px-1.5 py-1 text-left transition-colors hover:bg-accent/60"
                            data-fork-screen-picker-item={name}
                          >
                            <div className="text-[12px] text-foreground">{def.label}</div>
                            <div className="text-[11px] text-muted-foreground">{def.description}</div>
                          </button>
                        )
                      })}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
