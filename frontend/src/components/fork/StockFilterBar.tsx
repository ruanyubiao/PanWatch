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
 *   组1 市场   全部 | 上证 | 深证 | 创业 | 科创 | ST    单选下拉（带计数）
 *   组2 状态   全部状态 | 买入 | 回避 | 观望              多选下拉
 *   组3 涨跌   全部涨跌 | 上涨 | 下跌                      单选下拉
 *   组4 市值   全部市值 | 50亿 | 100亿 | … | 其他          多选下拉
 *
 * 第四轮用户要求：
 *   - 组1 从 pill 行**也改成下拉菜单**（和另外三组统一），所以 pill 那套
 *     FilterChip / 分组标题 / 竖分隔线都删了 —— 这一行现在就是四个下拉 + 清空筛选。
 *     计数跟着选项走，触发器上显示的也是带计数的那个文案。
 *   - 「清空筛选」**紧跟在下拉菜单后面**（原来有 ml-auto 被推到行尾，看着像和筛选无关）。
 *
 * 第五轮：组1 的「全部」选项文案改成「全部市场 (5574)」（触发器与选项同文案），
 * 触发器宽度**翻倍**（104 → 208，见 MARKET_TRIGGER_WIDTH）——原来是按 pill 时代的短文案留的，
 * 现在文案变长且用户反馈太窄。Radix 的 SelectContent 是 min-w-[var(--radix-select-trigger-width)]，
 * 所以面板宽度跟着触发器一起放大，不用单独调。
 * 另外三组（状态 / 涨跌 / 市值）文案没变，宽度保持 104。
 *
 * 顺序照旧：全部 / 上证 / 深证 / **创业** / **科创** / ST —— 即 BOARD_OPTIONS 的顺序。
 * 「清空筛选」连**市场**一起复位（hasAnyFilterActive 因此把 board 也算进来，
 * 名字用机会页的叫法）。
 *
 * 与机会页的一点差别（报备过的）：机会页那颗「应用筛选」在这里没有意义 ——
 * 数据是一次全量取回、筛选在浏览器里即时生效，按下去不会有任何变化，
 * 所以不放一个空转的按钮。要加的话是一行的事。
 *
 * 组件是**受控**的：状态由页面持有，筛选结果与分页都在 StockMarketTable 里算
 * （数据是全市场一次取回的，所以这里不需要发任何请求）。
 */

const FILTER_BAR_TEXTS_ZH = {
  /** 组1 的「不限市场」文案。第五轮从「全部」改成「全部市场」（更明确这是市场维度）。 */
  all: '全部市场',
  marketAll: '全部市场',
  statusAll: '全部状态',
  changeAll: '全部涨跌',
  capAll: '全部市值',
  clear: '清空筛选',
  clearHint: '市场、状态、涨跌、市值一起复位',
  statusHint: (label: string) => `技术面：${label}`,
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

/** 组1 下拉里每一行的文案：「全部市场 (5574)」「上证 (1632)」（计数与 pill 时代的写法一致）。 */
function marketOptionLabel(label: string, count: number | undefined): string {
  return `${label} (${count ?? (label === FILTER_BAR_TEXTS_ZH.all ? '—' : 0)})`
}

/**
 * 组1 触发器的宽度。第五轮用户反馈「太短」，按 104px **翻倍**到 208px；
 * 其余三组仍是 104。Radix 的 SelectContent 取 min-w = 触发器宽度，面板随之变宽。
 */
const MARKET_TRIGGER_WIDTH = 'w-[208px]'

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
      {/* 组1 市场：单选下拉（选项 = 全部 / 上证 / 深证 / 创业 / 科创 / ST，各带计数） */}
      <Select value={board} onValueChange={value => onBoardChange(value as BoardKey)}>
        <SelectTrigger aria-label={FILTER_BAR_TEXTS_ZH.marketAll} className={`h-8 ${MARKET_TRIGGER_WIDTH} text-[12px]`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" className="text-[12px]">
            {marketOptionLabel(FILTER_BAR_TEXTS_ZH.all, counts.all)}
          </SelectItem>
          {BOARD_OPTIONS.map(option => (
            <SelectItem key={option.key} value={option.key} className="text-[12px]">
              {marketOptionLabel(option.label, counts[option.key])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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

      {/* 清空筛选（含市场）——紧跟在下拉菜单后面，只在真有筛选生效时出现 */}
      {hasAnyFilterActive(board, filters) && (
        <button
          type="button"
          onClick={clearAll}
          title={FILTER_BAR_TEXTS_ZH.clearHint}
          className="text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
        >
          {FILTER_BAR_TEXTS_ZH.clear}
        </button>
      )}
    </div>
  )
}

export default StockFilterBar
