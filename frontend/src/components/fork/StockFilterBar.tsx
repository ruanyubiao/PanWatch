import { type ReactNode } from 'react'
import { BOARD_OPTIONS, type BoardKey } from '@/lib/board-classify'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { MultiSelectFilter } from '@/components/fork/MultiSelectFilter'
import {
  CAP_FILTER_OPTIONS_ZH,
  CHANGE_FILTER_OPTIONS_ZH,
  EMPTY_MARKET_FILTERS,
  hasAnyFilterActive,
  type CapFilter,
  type ChangeFilter,
  type MarketTableFilters,
} from '@/lib/market-filters'

/**
 * fork：分析页的筛选行（四组）。
 *
 *   组1 市场   全部 | 上证 | 深证 | 创业 | 科创 | ST     pill（顺序按用户要求）
 *   组2 状态   全部状态 | 买入 | 回避 | 观望              多选下拉
 *   组3 涨跌   全部涨跌 | 上涨 | 下跌                      单选下拉
 *   组4 市值   全部市值 | 50亿 | 100亿 | … | 其他          多选下拉
 *
 * 第二轮用户要求：控件形式照「机会页」那一套（下拉 + 清空筛选），并且
 *   - 多选的下拉菜单要真的是多选（MultiSelectFilter）
 *   - 「清空筛选」连**市场**一起复位（hasAnyFilterActive 因此把 board 也算进来）
 *   - 名字用机会页的叫法「清空筛选」
 *
 * 与机会页的一点差别（报备过的）：机会页那颗「应用筛选」在这里没有意义 ——
 * 数据是一次全量取回、筛选在浏览器里即时生效，按下去不会有任何变化，
 * 所以不放一个空转的按钮。要加的话是一行的事。
 *
 * 组件是**受控**的：状态由页面持有，筛选结果与分页都在 StockMarketTable 里算
 * （数据是全市场一次取回的，所以这里不需要发任何请求）。
 */

const FILTER_BAR_TEXTS_ZH = {
  marketGroup: '市场',
  all: '全部',
  statusAll: '全部状态',
  changeAll: '全部涨跌',
  capAll: '全部市值',
  clear: '清空筛选',
  clearHint: '市场、状态、涨跌、市值一起复位',
  statusHint: (label: string) => `技术面：${label}`,
}

function FilterChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
        active ? 'bg-primary text-primary-foreground' : 'bg-accent/50 text-muted-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return <span className="text-[11px] text-muted-foreground/60">{children}</span>
}

function Divider() {
  return <div className="mx-1 h-4 w-px bg-border" />
}

export interface StockFilterBarProps {
  board: BoardKey
  onBoardChange: (board: BoardKey) => void
  /** 各板块计数（由 StockMarketTable 从全量数据里数出来回传） */
  counts: Partial<Record<BoardKey, number>>
  filters: MarketTableFilters
  onFiltersChange: (filters: MarketTableFilters) => void
  /** 组2 的候选动作文案（页面从 bizUi 的 kline.actions.* 取，与徽章同一套叫法） */
  statusOptions: { key: string; label: string }[]
  className?: string
}

export function StockFilterBar({
  board,
  onBoardChange,
  counts,
  filters,
  onFiltersChange,
  statusOptions,
  className,
}: StockFilterBarProps) {
  /** 「清空筛选」= 市场 + 其余三组一起回到「不限」（用户要求连市场一起复位）。 */
  const clearAll = () => {
    onBoardChange('all')
    onFiltersChange(EMPTY_MARKET_FILTERS)
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className || ''}`}>
      {/* 组1 市场：pill（顺序 = 全部 / 上证 / 深证 / 创业 / 科创 / ST） */}
      <GroupLabel>{FILTER_BAR_TEXTS_ZH.marketGroup}</GroupLabel>
      <FilterChip active={board === 'all'} onClick={() => onBoardChange('all')}>
        {FILTER_BAR_TEXTS_ZH.all} ({counts.all ?? '—'})
      </FilterChip>
      {BOARD_OPTIONS.map(option => (
        <FilterChip
          key={option.key}
          active={board === option.key}
          onClick={() => onBoardChange(option.key)}
        >
          {option.label} ({counts[option.key] ?? 0})
        </FilterChip>
      ))}

      <Divider />

      {/* 组2 状态：多选下拉 */}
      <MultiSelectFilter
        label={FILTER_BAR_TEXTS_ZH.statusAll}
        allLabel={FILTER_BAR_TEXTS_ZH.statusAll}
        options={statusOptions.map(option => ({
          key: option.key,
          label: option.label,
          hint: FILTER_BAR_TEXTS_ZH.statusHint(option.label),
        }))}
        value={filters.status}
        onChange={next => onFiltersChange({ ...filters, status: next })}
        className="w-[104px]"
      />

      {/* 组3 涨跌：单选下拉 */}
      <Select value={filters.change} onValueChange={value => onFiltersChange({ ...filters, change: value as ChangeFilter })}>
        <SelectTrigger aria-label={FILTER_BAR_TEXTS_ZH.changeAll} className="h-8 w-[104px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CHANGE_FILTER_OPTIONS_ZH.map(option => (
            <SelectItem key={option.key} value={option.key} className="text-[12px]">
              {option.key === 'all' ? FILTER_BAR_TEXTS_ZH.changeAll : option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* 组4 市值：多选下拉 */}
      <MultiSelectFilter
        label={FILTER_BAR_TEXTS_ZH.capAll}
        allLabel={FILTER_BAR_TEXTS_ZH.capAll}
        options={CAP_FILTER_OPTIONS_ZH.map(option => ({
          key: option.key,
          label: option.label,
          hint: option.hint,
        }))}
        value={filters.cap}
        onChange={next => onFiltersChange({ ...filters, cap: next as CapFilter[] })}
        className="w-[104px]"
      />

      {/* 清空筛选（含市场）——只在真有筛选生效时出现 */}
      {hasAnyFilterActive(board, filters) && (
        <button
          type="button"
          onClick={clearAll}
          title={FILTER_BAR_TEXTS_ZH.clearHint}
          className="ml-auto text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
        >
          {FILTER_BAR_TEXTS_ZH.clear}
        </button>
      )}
    </div>
  )
}

export default StockFilterBar
