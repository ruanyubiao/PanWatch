import { HelpCircle, Search, X } from 'lucide-react'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { HoverPopover } from '@panwatch/base-ui/components/ui/hover-popover'
import { cn } from '@panwatch/base-ui'
import {
  STOCK_SEARCH_CLEAR_ZH,
  STOCK_SEARCH_HELP_FOOTER_ZH,
  STOCK_SEARCH_HELP_TITLE_ZH,
  STOCK_SEARCH_HELP_ZH,
  STOCK_SEARCH_PLACEHOLDER_ZH,
} from '@/lib/stock-search'

/**
 * fork：分析页的搜索框（Everything 语法 + 悬停语法说明）。
 *
 * 语法由 ``lib/vendor/everything_filter.js``（逐字复制的第三方库）解释，
 * 匹配对象是「代码 + 名称」，见 lib/stock-search.ts。这里只负责界面：
 * 输入框、「?」提示、以及清空按钮。
 *
 * 为什么要带说明：这套语法（空格与、|或、!非、*?通配）不看说明猜不出来，
 * placeholder 放不下，所以用一个悬停气泡把每条规则连同例子列出来。
 */
export function StockSearchBox({
  value,
  onChange,
  className,
  inputClassName,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
  inputClassName?: string
}) {
  return (
    <div className={cn('flex items-center gap-1.5', className)}>
      <div className="relative w-full">
        <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
        <Input
          value={value}
          onChange={event => onChange(event.target.value)}
          placeholder={STOCK_SEARCH_PLACEHOLDER_ZH}
          aria-label={STOCK_SEARCH_PLACEHOLDER_ZH}
          className={cn('h-8 pl-9 pr-8 text-[12px]', inputClassName)}
        />
        {value && (
          <button
            type="button"
            aria-label={STOCK_SEARCH_CLEAR_ZH}
            onClick={() => onChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      <HoverPopover
        align="end"
        trigger={
          <HelpCircle className="h-4 w-4 shrink-0 cursor-help text-muted-foreground/60 hover:text-foreground" />
        }
        title={STOCK_SEARCH_HELP_TITLE_ZH}
        content={
          <div>
            <ul className="space-y-1">
              {STOCK_SEARCH_HELP_ZH.map(item => (
                <li key={item.syntax} className="flex items-center gap-2">
                  <code className="shrink-0 rounded bg-accent/60 px-1 py-px font-mono text-[10px] text-foreground">
                    {item.syntax}
                  </code>
                  <span className="text-[11px]">{item.desc}</span>
                  <code className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/80">
                    {item.sample}
                  </code>
                </li>
              ))}
            </ul>
            <div className="mt-2 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground/70">
              {STOCK_SEARCH_HELP_FOOTER_ZH}
            </div>
          </div>
        }
      />
    </div>
  )
}

export default StockSearchBox
