import { useMemo, useState } from 'react'
import type { ReactNode, WheelEvent } from 'react'
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

/**
 * 列表的滚轮。
 *
 * 坑：这个浮层是 portal 到 body 的，而外层「条件选股」是 Radix Dialog（modal）。
 * Dialog 的滚动锁（react-remove-scroll）在 **document 的 capture 阶段** 拦掉
 * 所有不在锁范围内元素的 wheel 默认行为，浮层正落在锁范围外 —— 于是鼠标滚轮
 * 完全推不动列表，只能拖滚动条（用户反馈）。
 *
 * 该事件到我们手上时 `defaultPrevented` 已经是 true，说明原生滚动不会发生，
 * 那就自己改 scrollTop；为 false 说明没被锁（或不在 Dialog 里），交回浏览器，
 * 避免滚两倍。
 */
function scrollListByWheel(event: WheelEvent<HTMLDivElement>) {
  const node = event.currentTarget
  const max = node.scrollHeight - node.clientHeight
  if (max <= 0) return
  if (!event.defaultPrevented) return
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1
  const next = Math.min(max, Math.max(0, node.scrollTop + event.deltaY * unit))
  if (next !== node.scrollTop) node.scrollTop = next
}

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
            <div
              className="max-h-72 overflow-y-auto scrollbar"
              data-fork-screen-picker-list
              onWheel={scrollListByWheel}
            >
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
