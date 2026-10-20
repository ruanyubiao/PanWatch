import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'

/**
 * fork：分析页表格的分页条（上、下各一条）。
 *
 * 2026-10-20 第 1 条要求把上面那条**拆成两行**：
 *
 *   第一行：左 = 条件选股 → 已保存条件下拉 → 编辑
 *           右 = 数据时间 / 代码版本 / 提交时间（页面注入的 ``meta``）
 *   第二行：刷新 → 添加股票 → 搜索框 → 五组筛选 → 「共 N 条 + 页码 + 每页条数」
 *
 * 拆成两行的原因：第一行那三个控件是**整套选股流程**的入口，第二行是行情表的
 * 日常操作；原来挤在一行里，条件多了以后搜索框和筛选会被挤到下一行、位置飘。
 *
 * 下面那条分页条只有页码区（用户明确说底部不要搜索框），所以不传 actions/meta
 * 时第一行整行不渲染。
 *
 * 每页条数给到 10000：数据是**一次性全量取回**的（见 StockMarketTable），
 * 所以「每页 10000 条」只是浏览器里切一刀，不会再打接口。
 */

/** 每页条数下拉的取值（用户指定）。 */
export const PAGE_SIZE_OPTIONS = [100, 200, 500, 1000, 2000, 5000, 10000] as const

/** 工具条里「按钮组」与「搜索框」之间的间距（用户指定 50px）。 */
export const TOOLBAR_GAP_PX = 50

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
  /** 第一行左侧的按钮组（条件选股 → 已保存条件下拉 → 编辑），只有上方那条分页条传 */
  actions?: ReactNode
  /** 第一行**右侧**的元信息（数据时间 / 代码版本 / 提交时间），只有上方那条分页条传 */
  meta?: ReactNode
  /** 第二行左端的按钮组 + 搜索框（刷新 / 添加股票 + 50px + 搜索框） */
  leading?: ReactNode
  /**
   * 第二行搜索框**后面**的筛选控件（市场 / 指标 / 涨跌 / 市值 / 状态 / 清空筛选）。
   * 只有上方那条分页条传。
   */
  filters?: ReactNode
}

export function TablePagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  disabled = false,
  actions,
  meta,
  leading,
  filters,
}: TablePaginationProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const arrowClass =
    'inline-flex h-6 w-6 items-center justify-center rounded border border-border/60 text-muted-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40'

  const showTopRow = Boolean(actions || meta)
  // 第二行：按钮组 + 50px + 搜索框，然后是筛选控件（紧跟搜索框，间距 8px）
  const showMainRow = Boolean(leading || filters)

  return (
    <div className="py-2 text-[11px] text-muted-foreground">
      {/* 第一行：左 = 选股流程（条件选股 / 已保存 / 编辑），右 = 数据时间与版本信息 */}
      {showTopRow ? (
        <div
          data-fork-toolbar-row="top"
          className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">{actions}</div>
          <div className="flex shrink-0 items-center">{meta}</div>
        </div>
      ) : null}

      {/* 第二行：日常操作 + 搜索 + 筛选，页码区靠右 */}
      <div
        data-fork-toolbar-row="main"
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${showMainRow ? '' : 'justify-end'}`}
      >
        {showMainRow ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {actions || leading ? (
              <div
                className="flex items-center"
                style={leading ? { columnGap: TOOLBAR_GAP_PX } : undefined}
              >
                {leading}
              </div>
            ) : null}
            {filters}
          </div>
        ) : null}

        {/* 页码与每页条数整块靠右；页码在下拉前面 */}
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2" data-fork-pager>
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
        <Select value={String(pageSize)} onValueChange={value => onPageSizeChange(Number(value))}>
          <SelectTrigger className="h-7 w-[126px] text-[11px]" disabled={disabled}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="min-w-[152px]">
            {PAGE_SIZE_OPTIONS.map(size => (
              <SelectItem key={size} value={String(size)} className="text-[11px]">
                {PAGINATION_TEXTS_ZH.perPage(size)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        </div>
      </div>
    </div>
  )
}

export default TablePagination
