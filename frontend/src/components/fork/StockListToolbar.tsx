import type { ReactNode } from 'react'
import { Loader2, Search } from 'lucide-react'
import { Input } from '@panwatch/base-ui/components/ui/input'

/**
 * fork：「关注」与「全部」两个列表共用的工具栏（搜索框 + 状态文案）。
 *
 * 为什么要抽出来：用户反馈「点关注和全部的切换就是数据的切换，UI 不应该变化，
 * 现在切换会抖动、宽度也不对」。根因是「全部」有搜索框、「关注」没有，
 * 切换时整块内容上下位移。现在两边渲染同一个组件、同样的 h-8，
 * 位置与高度逐像素一致，切换只换数据。
 *
 * 搜索行为由调用方决定：范围=全部时发给后端（服务端搜索 5000+ 只），
 * 范围=关注时在前端过滤（就那几十只）。组件本身只管输入框与状态文案。
 */
export function StockListToolbar({
  value,
  onChange,
  placeholder,
  status,
  loading = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** 右侧状态文案（共 N 只，当前 1-100）。固定成字符串，两边文案规则也必须一致 */
  status: ReactNode
  loading?: boolean
}) {
  return (
    <div className="mb-3 flex h-8 items-center gap-2">
      <div className="relative w-full max-w-xs shrink-0">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className="h-8 pl-9 text-[12px]"
        />
      </div>
      <span className="flex items-center truncate text-[11px] text-muted-foreground">
        {loading && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />}
        {status}
      </span>
    </div>
  )
}

export default StockListToolbar
