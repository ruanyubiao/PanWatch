import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'

/**
 * fork：分析页表格的分页条（上、下各一条，同一种形式）。
 *
 * 用户给的参考（截图 2）是一个「共 N 条 + ‹ 1 2 3 … › + 每页条数下拉」的横条，
 * 所以这里不再用上游那种「上一页 / 下一页」两个按钮的写法。
 *
 * 为什么要两组数字按钮都渲染：用户要求「上下都一样」——顶部一条、底部一条，
 * 同一组件同一份样式，翻页不用先把滚动条拖回顶部。
 *
 * 每页条数给到 10000：数据是**一次性全量取回**的（见 StockMarketTable），
 * 所以「每页 10000 条」只是浏览器里切一刀，不会再打接口。
 */

/** 每页条数下拉的取值（用户指定）。 */
export const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000, 2000, 5000, 10000] as const

const PAGINATION_TEXTS_ZH = {
  total: (n: number) => `共 ${n} 条`,
  perPage: (n: number) => `${n} 条/页`,
  prev: '上一页',
  next: '下一页',
  more: '更多页码',
}

/**
 * 页码序列：页数少就全列，多了就「首页 + 当前附近 + 末页」，中间用 'gap' 表示省略号。
 *
 * 例（56 页，当前 1）→ [1, 2, 3, 4, 5, 'gap', 56]
 */
export function paginationItems(current: number, pageCount: number): (number | 'gap')[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1)

  const items: (number | 'gap')[] = [1]
  const start = Math.max(2, Math.min(current - 1, pageCount - 4))
  const end = Math.min(pageCount - 1, Math.max(current + 1, 5))
  if (start > 2) items.push('gap')
  for (let page = start; page <= end; page++) items.push(page)
  if (end < pageCount - 1) items.push('gap')
  items.push(pageCount)
  return items
}

interface TablePaginationProps {
  total: number
  /** 1 起 */
  page: number
  pageSize: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  disabled?: boolean
}

export function TablePagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  disabled = false,
}: TablePaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const arrowClass =
    'inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2 text-[11px] text-muted-foreground">
      <span className="whitespace-nowrap">{PAGINATION_TEXTS_ZH.total(total)}</span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={PAGINATION_TEXTS_ZH.prev}
          className={arrowClass}
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        {paginationItems(page, pageCount).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className="px-1 text-muted-foreground/60" aria-label={PAGINATION_TEXTS_ZH.more}>
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              aria-current={item === page ? 'page' : undefined}
              className={`h-6 min-w-6 rounded border px-1.5 text-[11px] transition-colors ${
                item === page
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent text-muted-foreground hover:bg-accent'
              }`}
              disabled={disabled}
              onClick={() => onPageChange(item)}
            >
              {item}
            </button>
          ),
        )}

        <button
          type="button"
          aria-label={PAGINATION_TEXTS_ZH.next}
          className={arrowClass}
          disabled={disabled || page >= pageCount}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 宽度给足：「10000 条/页」是最长的一项，下拉里也不能被截断 */}
      <div className="ml-auto">
        <Select value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
          <SelectTrigger className="h-7 w-[124px] text-[11px]" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-[148px]">
            {PAGE_SIZE_OPTIONS.map(size => (
              <SelectItem key={size} value={String(size)} className="text-[11px]">
                {PAGINATION_TEXTS_ZH.perPage(size)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

export default TablePagination
