import { BOARD_OPTIONS, type BoardKey } from '@/lib/board-classify'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@panwatch/base-ui/components/ui/select'
import { MultiSelectFilter } from '@/components/fork/MultiSelectFilter'
import {
  CAP_FILTER_OPTIONS_ZH,
  CHANGE_FILTER_OPTIONS_ZH,
  EMPTY_MARKET_FILTERS,
  TRADE_STATUS_FILTER_OPTIONS_ZH,
  TURNOVER_FILTER_OPTIONS_ZH,
  hasAnyFilterActive,
  type CapFilter,
  type ChangeFilter,
  type MarketTableFilters,
  type TradeStatusFilter,
  type TurnoverFilter,
} from '@/lib/market-filters'

/**
 * fork：分析页的筛选行（六组）。
 *
 *   组1 市场   全部 | 上证 | 深证 | 创业 | 科创 | ST    单选下拉（带计数）
 *   组2 指标   全部指标 | 买入 | 回避 | 观望            多选下拉（技术面结论）
 *   组3 涨跌   全部涨跌 | 上涨 | 下跌                    单选下拉
 *   组4 市值   全部市值 | 50亿 | 100亿 | … | 其他        多选下拉
 *   组5 换手率 全部换手率 | 2% | 5% | 10% | 20% | 其他   多选下拉（排在市值后面）
 *   组6 状态   全部状态 | 正常 | 停牌 | ST | *ST | …     多选下拉（交易日状态）
 *
 * 2026-10-20 第四批反馈的改动：
 *   - 第 4 条：组2 从「状态」改名「指标」（表格里那一列的标题同步改成「指标」），
 *     腾出「状态」这个词给第 5 条新增的**交易日状态**（停牌 / 正常 / …）；
 *   - 第 6 条：新增组5「全部状态」，位置按用户要求放在「全部市值」后面；
 *   - 第 3 条：组1 触发器的宽度减 70px（208 → 138）—— 用户觉得市场那个下拉太宽。
 *     面板宽度跟着触发器走（Radix 的 SelectContent 取 min-w = 触发器宽度），
 *     选项文案不会因此被截断。
 *
 * 上一批（第五轮）留下的两点仍然有效：组1 的文案是「全部市场 (5574)」（触发器与
 * 选项同文案）；「清空筛选」紧跟在下拉后面，连**市场**一起复位。
 *
 * 组件是**受控**的：状态由页面持有，筛选结果与分页都在 StockMarketTable 里算
 * （数据是全市场一次取回的，所以这里不需要发任何请求）。
 *
 * 行尾的「代码版本 / 提交时间 / 数据同步时间」原先是这里的 ``trailing`` 槽位，
 * 2026-10-20 第 1 条要求把它挪到工具条**第一行靠右**（见 TablePagination 的
 * ``meta``），所以这里不再提供 trailing。
 */

const FILTER_BAR_TEXTS_ZH = {
  /** 组1 的「不限市场」文案。第五轮从「全部」改成「全部市场」（更明确这是市场维度）。 */
  all: '全部市场',
  marketAll: '全部市场',
  indicatorAll: '全部指标',
  changeAll: '全部涨跌',
  capAll: '全部市值',
  turnoverAll: '全部换手率',
  tradeStatusAll: '全部状态',
  clear: '清空筛选',
  clearHint: '市场、指标、涨跌、市值、换手率、状态一起复位',
  indicatorHint: (label: string) => `技术面：${label}`,
}

export interface StockFilterBarProps {
  board: BoardKey
  onBoardChange: (board: BoardKey) => void
  /** 各板块计数（由 StockMarketTable 从全量数据里数出来回传） */
  counts: Partial<Record<BoardKey, number>>
  filters: MarketTableFilters
  onFiltersChange: (filters: MarketTableFilters) => void
  /** 组2 的候选动作文案（页面从 bizUi 的 kline.actions.* 取，与徽章同一套叫法） */
  indicatorOptions: { key: string; label: string }[]
  className?: string
}

/** 组1 下拉里每一行的文案：「全部市场 (5574)」「上证 (1632)」（计数与 pill 时代的写法一致）。 */
function marketOptionLabel(label: string, count: number | undefined): string {
  return `${label} (${count ?? (label === FILTER_BAR_TEXTS_ZH.all ? '—' : 0)})`
}

/**
 * 组1 触发器的宽度。第五轮按 104px **翻倍**到 208；2026-10-20 第 3 条要求再减 70px →
 * 138。其余几组仍是 104。
 */
const MARKET_TRIGGER_WIDTH = 'w-[138px]'

export function StockFilterBar({
  board,
  onBoardChange,
  counts,
  filters,
  onFiltersChange,
  indicatorOptions,
  className,
}: StockFilterBarProps) {
  /** 「清空筛选」= 市场 + 其余四组一起回到「不限」（用户要求连市场一起复位）。 */
  const clearAll = () => {
    onBoardChange('all')
    onFiltersChange(EMPTY_MARKET_FILTERS)
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className || ''}`}>
      {/* 组1 市场：单选下拉（选项 = 全部 / 上证 / 深证 / 创业 / 科创 / ST，各带计数） */}
      <Select value={board} onValueChange={value => onBoardChange(value as BoardKey)}>
        <SelectTrigger
          aria-label={FILTER_BAR_TEXTS_ZH.marketAll}
          className={`h-8 ${MARKET_TRIGGER_WIDTH} px-2 text-[12px]`}
        >
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

      {/* 组2 指标：多选下拉（买入 / 回避 / 观望） */}
      <MultiSelectFilter
        label={FILTER_BAR_TEXTS_ZH.indicatorAll}
        allLabel={FILTER_BAR_TEXTS_ZH.indicatorAll}
        options={indicatorOptions.map(option => ({
          key: option.key,
          label: option.label,
          hint: FILTER_BAR_TEXTS_ZH.indicatorHint(option.label),
        }))}
        value={filters.indicator}
        onChange={next => onFiltersChange({ ...filters, indicator: next })}
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
        menuClassName="w-[288px]"
      />

      {/* 组5 换手率：多选下拉（排在「全部市值」后面，与市值同一种「标签 = 本档上界」的写法） */}
      <MultiSelectFilter
        label={FILTER_BAR_TEXTS_ZH.turnoverAll}
        allLabel={FILTER_BAR_TEXTS_ZH.turnoverAll}
        options={TURNOVER_FILTER_OPTIONS_ZH.map(option => ({
          key: option.key,
          label: option.label,
          hint: option.hint,
        }))}
        value={filters.turnover}
        onChange={next => onFiltersChange({ ...filters, turnover: next as TurnoverFilter[] })}
        // 「全部换手率」是 5 个字，104px 装不下（实测被压成「全部换…」）——只这一组给 120px
        className="w-[120px]"
        menuClassName="w-[248px]"
      />

      {/* 组6 状态：多选下拉（用户要求放在「全部市值」后面）—— 交易日状态，不是技术面结论 */}
      <MultiSelectFilter
        label={FILTER_BAR_TEXTS_ZH.tradeStatusAll}
        allLabel={FILTER_BAR_TEXTS_ZH.tradeStatusAll}
        options={TRADE_STATUS_FILTER_OPTIONS_ZH.map(option => ({
          key: option.key,
          label: option.label,
          hint: option.hint,
        }))}
        value={filters.tradeStatus}
        onChange={next => onFiltersChange({ ...filters, tradeStatus: next as TradeStatusFilter[] })}
        className="w-[104px]"
        menuClassName="w-[236px]"
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
