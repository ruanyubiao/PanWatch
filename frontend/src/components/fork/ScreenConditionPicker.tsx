import { useCallback, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@panwatch/base-ui/components/ui/popover'
import { Input } from '@panwatch/base-ui/components/ui/input'
import {
  CONDITION_CATEGORIES,
  CONDITION_DEFS_ZH,
  PICKABLE_CONDITION_NAMES,
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
 * 列表的滚轮（用户反馈两次：滚轮推不动列表）。
 *
 * 坑：这个浮层是 portal 到 body 的，而外层「条件选股」是 Radix Dialog（modal）。
 * react-remove-scroll 在 **document 的冒泡阶段** 拦 wheel：当目标是锁范围外的
 * 元素（也就是这个浮层）时调用 `preventDefault()`，于是浏览器不做原生滚动。
 *
 * 上一版在 React 的 `onWheel` 里判断 `event.defaultPrevented` 再手动滚 —— 顺序
 * 反了：React 的 wheel 监听挂在根容器（冒泡阶段，比 document 早），事件到我们
 * 手上时 `defaultPrevented` 还是 false，于是我们直接 return，随后 document 才
 * preventDefault，结果谁也不滚。这就是「修了还是没效果」。
 *
 * 现在改成**自己装非 passive 的原生监听**：直接 preventDefault + 改 scrollTop，
 * 不再猜谁拦了谁。`stopPropagation` 让 document 那个拦截器根本收不到事件，
 * 也就不会滚两倍。监听必须非 passive —— React 的 onWheel 是 passive 的，
 * 在里面调 preventDefault 无效。
 *
 * 用**回调 ref** 而不是 `useEffect + ref.current`：浮层里的列表是 Radix 在 Portal
 * 内挂载的，effect 跑的那一刻节点还不一定在（实测就是空的，监听一直没装上，
 * 于是「修了还是没效果」）。回调 ref 在节点真正挂上的那一刻执行，最稳。
 */
function useWheelScroll(): (node: HTMLDivElement | null) => void {
  const detach = useRef<(() => void) | null>(null)
  return useCallback((node: HTMLDivElement | null) => {
    detach.current?.()
    detach.current = null
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      const max = node.scrollHeight - node.clientHeight
      if (max <= 0) return
      event.preventDefault()
      event.stopPropagation()
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1
      node.scrollTop = Math.min(max, Math.max(0, node.scrollTop + event.deltaY * unit))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    detach.current = () => node.removeEventListener('wheel', onWheel)
  }, [])
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
  // 列表挂载的那一刻装上滚轮监听（portal 里节点出现得比 effect 晚，见 useWheelScroll）
  const attachWheel = useWheelScroll()

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return PICKABLE_CONDITION_NAMES
    return PICKABLE_CONDITION_NAMES.filter(name => {
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
      {/* w-[27rem]（432px）：在 w-80（320px）下说明文字会折成两行（用户反馈） */}
      <PopoverContent align="start" className="w-[27rem] max-w-[calc(100vw-2rem)] p-2" data-fork-screen-picker>
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
              ref={attachWheel}
              className="max-h-72 overflow-y-auto overscroll-contain scrollbar"
              data-fork-screen-picker-list
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
