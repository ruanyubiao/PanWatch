import type { ReactNode } from 'react'
import { BOARD_OPTIONS, type BoardKey } from '@/lib/board-classify'
import {
  CAP_FILTER_OPTIONS_ZH,
  CHANGE_FILTER_OPTIONS_ZH,
  EMPTY_MARKET_FILTERS,
  hasActiveFilters,
  type MarketTableFilters,
} from '@/lib/market-filters'

/**
 * fork：分析页的筛选行（板块 pill 那一行，改成四组）。
 *
 *   组1 市场   全部 | 上证 | 深证 | 科创 | 创业 | ST
 *   组2 状态   全部 | 买入 | 回避 | 观望          多选
 *   组3 涨跌   全部 | 上涨 | 下跌                  单选
 *   组4 市值   全部 | 50亿 | 100亿 | … | 其他      单选
 *
 * 用户最初只说了「在 pill 那一行加筛选」，没给控件形状 —— 这里统一用 chip：
 * 四种控件（单选/多选/分档/带说明）长得一致，和原来的板块 pill 也一致，
 * 不会出现「两行控件风格不一样」（这个坑在本页已经踩过一次）。
 *
 * 组件是**受控**的：状态由页面持有，筛选结果与分页都在 StockMarketTable 里算
 * （数据是全市场一次取回的，所以这里不需要发任何请求）。
 */

const FILTER_BAR_TEXTS_ZH = {
  marketGroup: '市场',
  statusGroup: '状态',
  changeGroup: '涨跌',
  capGroup: '市值',
  all: '全部',
  clear: '清除筛选',
  statusHintAll: '不限技术面动作',
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
  /** 多选：点已选中的动作 = 取消它；取消空了就等于「全部」。 */
  const toggleStatus = (key: string) => {
    const next = filters.status.includes(key)
      ? filters.status.filter(item => item !== key)
      : [...filters.status, key]
    onFiltersChange({ ...filters, status: next })
  }

  return (
    <div className={`flex flex-wrap items-center gap-x-1 gap-y-2 ${className || ''}`}>
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
      <GroupLabel>{FILTER_BAR_TEXTS_ZH.statusGroup}</GroupLabel>
      <FilterChip
        active={filters.status.length === 0}
        title={FILTER_BAR_TEXTS_ZH.statusHintAll}
        onClick={() => onFiltersChange({ ...filters, status: [] })}
      >
        {FILTER_BAR_TEXTS_ZH.all}
      </FilterChip>
      {statusOptions.map(option => (
        <FilterChip
          key={option.key}
          active={filters.status.includes(option.key)}
          title={`技术面：${option.label}`}
          onClick={() => toggleStatus(option.key)}
        >
          {option.label}
        </FilterChip>
      ))}

      <Divider />
      <GroupLabel>{FILTER_BAR_TEXTS_ZH.changeGroup}</GroupLabel>
      {CHANGE_FILTER_OPTIONS_ZH.map(option => (
        <FilterChip
          key={option.key}
          active={filters.change === option.key}
          title={option.hint}
          onClick={() => onFiltersChange({ ...filters, change: option.key })}
        >
          {option.label}
        </FilterChip>
      ))}

      <Divider />
      <GroupLabel>{FILTER_BAR_TEXTS_ZH.capGroup}</GroupLabel>
      {CAP_FILTER_OPTIONS_ZH.map(option => (
        <FilterChip
          key={option.key}
          active={filters.cap === option.key}
          title={option.hint}
          onClick={() => onFiltersChange({ ...filters, cap: option.key })}
        >
          {option.label}
        </FilterChip>
      ))}

      {hasActiveFilters(filters) && (
        <button
          type="button"
          onClick={() => onFiltersChange(EMPTY_MARKET_FILTERS)}
          className="ml-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-primary hover:underline"
        >
          {FILTER_BAR_TEXTS_ZH.clear}
        </button>
      )}
    </div>
  )
}

export default StockFilterBar
