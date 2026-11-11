import { BrainCircuit } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { openDsa2Window } from '@/lib/dsa-api'

export interface Dsa2ButtonProps {
  symbol: string
  name?: string | null
  /** 悬停提示，默认「深度分析2」 */
  label?: string
}

/**
 * fork：「深度分析2」入口（DSA 口径决策报告）。
 *
 * 只负责开新窗口 —— 分析任务由 /dsa2/:symbol 页面自己起、自己轮询，所以点这颗
 * 按钮不发任何请求，也不会卡住当前页。做成一颗粒子组件是为了分析页表格与本组
 * 件之外的调用方共用同一套地址口径（``dsa2Path``），避免各处手拼 URL。
 */
export function Dsa2Button({ symbol, name, label = '深度分析2' }: Dsa2ButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 hover:text-primary"
      title={label}
      aria-label={label}
      data-fork-dsa2-trigger="1"
      onClick={() => openDsa2Window(symbol, name)}
    >
      <BrainCircuit className="w-3.5 h-3.5" />
    </Button>
  )
}
