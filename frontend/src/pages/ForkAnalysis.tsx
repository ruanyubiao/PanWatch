import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Trash2, Pencil, Search, X, TrendingUp, Bot, Play, RefreshCw, Wallet, PiggyBank, ArrowUpRight, ArrowDownRight, Building2, ChevronDown, ChevronLeft, ChevronRight, Cpu, Bell, Clock, Newspaper, ExternalLink, BarChart3, Brain, Loader2, Filter } from 'lucide-react'
import { fetchAPI, stocksApi, type AIService, type NotifyChannel } from '@panwatch/api'
import { klinesApi } from '@panwatch/api/klines'
import { formatDateTime } from '@/lib/utils'
import {
  buildPortfolioStockKeys,
  loadPortfolioPageBackgroundData,
  loadPortfolioPageCoreData,
} from '@/lib/portfolio-page-data'
import { SuggestionBadge, type SuggestionInfo, type KlineSummary } from '@panwatch/biz-ui/components/suggestion-badge'
import { KlineSummaryDialog } from '@panwatch/biz-ui/components/kline-summary-dialog'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import { Badge } from '@panwatch/base-ui/components/ui/badge'
import { Skeleton } from '@panwatch/base-ui/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@panwatch/base-ui/components/ui/dialog'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectLabel, SelectItem } from '@panwatch/base-ui/components/ui/select'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import StockInsightModal from '@panwatch/biz-ui/components/stock-insight-modal'
import { DeepAnalysisModal } from '@panwatch/biz-ui/components/deep-analysis-modal'
import StockPriceAlertPanel from '@panwatch/biz-ui/components/stock-price-alert-panel'
import { useTranslation } from 'react-i18next'
import { localizeAgentDescription, localizeAgentName } from '@/i18n/agent-labels'
import { getCurrentLocale } from '@/i18n'
import { browserTimezone } from '@panwatch/base-ui'
import { applyMarketStatuses, mergePortfolioQuotes, toQuoteMap, type Position, type PortfolioSummary, type QuoteResponse, type DisplayQuote } from '@/lib/portfolio-quotes'
import { type MarketStatus } from '@/components/MarketCalendarStatus'
import { marketSignTextClass } from '@/lib/market-colors'
// fork：本页是上游 Stocks.tsx 的副本，改动全部只发生在本文件里，
// 上游 Stocks.tsx 保持原样（「不修改项目原来的文件」）。
import {
  countByBoard,
  matchesBoard,
  onlyAShares,
  type BoardKey,
} from '@/lib/board-classify'
import { buildKlineSuggestion } from '@/lib/kline-scorer'
import {
  buildSummaryFromMarketRow,
  type MarketRow,
  type MarketBoardCounts,
} from '@/lib/fork-kline-summary'
import { normalizeSymbol, sameListingCode } from '@/lib/stock-tokens'
import {
  EMPTY_MARKET_FILTERS,
  INDICATOR_FILTER_KEYS,
  type MarketTableFilters,
} from '@/lib/market-filters'
import { StockFilterBar } from '@/components/fork/StockFilterBar'
import { TOOLBAR_GAP_PX } from '@/components/fork/TablePagination'
import { BuildMetaStrip, type BuildMeta } from '@/components/fork/BuildMetaStrip'
import {
  StockMarketTable,
  type MarketRowState,
} from '@/components/fork/StockMarketTable'
import { StockRichCard, type StockRichCardTexts } from '@/components/fork/StockRichCard'
import {
  FORK_PAGE_WIDTH_CLASS,
  STOCK_CARD_GRID_CLASS,
  STOCK_PAGE_SIZE,
} from '@/components/fork/stock-grid'
import { StockListToolbar } from '@/components/fork/StockListToolbar'
import { StockSearchBox } from '@/components/fork/StockSearchBox'
import { BatchAddStocksDialog } from '@/components/fork/BatchAddStocksDialog'
import { ScreenStocksDialog } from '@/components/fork/ScreenStocksDialog'
import { ScreenResultBanner } from '@/components/fork/ScreenResultBanner'
import { ScreenPresetMenu } from '@/components/fork/ScreenPresetMenu'
import { SaveConditionDialog } from '@/components/fork/SaveConditionDialog'
import { screenStocks } from '@/lib/screen-api'
import {
  SCREEN_PRESET_TEXTS_ZH,
  deletePreset,
  listPresets,
  savePreset,
  type ScreenPreset,
} from '@/lib/screen-presets'
import {
  SCREEN_TEXTS_ZH,
  fillDefaultParams,
  type ScreenRequest,
  type ScreenResponse,
} from '@/lib/screen-rule'

import { parseAssistantPortfolioTarget } from '@/lib/assistant-navigation'
import { useGuidedTour } from '@/components/onboarding/GuidedTour'
import FirstAnalysis from '@/components/onboarding/FirstAnalysis'

interface AgentResult {
  success?: boolean
  message?: string
  title: string
  content: string
  should_alert: boolean
  notified: boolean
  skipped?: boolean
}

interface StockAgentInfo {
  agent_name: string
  display_name?: string
  schedule: string
  ai_model_id: number | null
  notify_channel_ids: number[]
}

interface Stock {
  asset_type?: 'stock' | 'etf'
  id: number
  symbol: string
  name: string
  market: string
  sort_order?: number
  agents: StockAgentInfo[]
}

interface Account {
  id: number
  name: string
  available_funds: number
  enabled: boolean
}


interface AgentConfig {
  name: string
  display_name: string
  description: string
  enabled: boolean
  schedule: string
  execution_mode: string  // batch: 批量分析, single: 逐只分析
}

interface SchedulePreview {
  schedule: string
  timezone: string
  next_runs: string[]
}

interface SearchResult {
  asset_type?: 'stock' | 'etf'
  symbol: string
  name: string
  market: string
}

interface QuoteRequestItem {
  symbol: string
  market: string
}


interface StockForm {
  asset_type: 'stock' | 'etf'
  symbol: string
  name: string
  market: string
}

interface AccountForm {
  name: string
  available_funds: string
}

interface PositionForm {
  account_id: number
  stock_id: number
  cost_price: string
  quantity: string
  invested_amount: string
  trading_style: string
  // 搜索选中的股票信息（新增持仓时用）
  stock_symbol: string
  stock_name: string
  stock_market: string
  stock_asset_type: 'stock' | 'etf'
}

// 建议池中的建议（包含来源和时间信息）
interface PoolSuggestion extends Omit<SuggestionInfo, 'should_alert'> {
  id: number
  stock_symbol: string
  stock_market?: string
  stock_name: string
  action: string
  action_label: string
  signal: string
  reason: string
  agent_name: string
  agent_label: string
  created_at: string
  expires_at: string | null
  is_expired: boolean
  prompt_context: string
  ai_response: string
  meta?: Record<string, any>
  should_alert?: boolean
}

interface NewsItem {
  source: string
  source_label: string
  external_id: string
  title: string
  content: string
  publish_time: string
  symbols: string[]
  importance: number
  url: string
}

interface PriceAlertRuleSummary {
  stock_symbol: string
  market: string
  enabled: boolean
}

const emptyStockForm: StockForm = { symbol: '', name: '', market: 'CN', asset_type: 'stock' }
const emptyAccountForm: AccountForm = { name: '', available_funds: '0' }

const buildQuoteItemsFrom = (stockList: Stock[], portfolio: PortfolioSummary | null): QuoteRequestItem[] => {
  const items: QuoteRequestItem[] = []
  const seen = new Set<string>()
  const add = (symbol: string, market: string) => {
    const key = `${market}:${symbol}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ symbol, market })
  }

  for (const stock of stockList) add(stock.symbol, stock.market)
  for (const account of portfolio?.accounts || []) {
    for (const pos of account.positions) add(pos.symbol, pos.market)
  }
  return items
}


const toPriceAlertSummaryMap = (rows: PriceAlertRuleSummary[]): Record<string, { total: number; enabled: number }> => {
  const map: Record<string, { total: number; enabled: number }> = {}
  for (const row of rows || []) {
    const market = String(row.market || 'CN').toUpperCase()
    const raw = String(row.stock_symbol || '').toUpperCase()
    const bare = normalizeSymbol(raw)
    // 同一条提醒同时挂到「库里的写法」和「6 位代码」上，表格用 code 查得到。
    for (const symbol of new Set([raw, bare])) {
      if (!symbol) continue
      const key = `${market}:${symbol}`
      if (!map[key]) map[key] = { total: 0, enabled: 0 }
      map[key].total += 1
      if (row.enabled) map[key].enabled += 1
    }
  }
  return map
}


/** fork：「来源」列与「技术指标」口径的两段固定文案（变量名以 _ZH 结尾，check:i18n 放行）。 */
const MARKET_ROW_TEXTS_ZH = {
  expired: '（已过期）',
  technical: '技术指标',
}

/** fork：点股票代码复制时的提示文案（变量名以 _ZH 结尾，check:i18n 放行）。 */
const COPY_CODE_TEXTS_ZH = {
  done: (text: string) => `已复制 ${text}`,
  blocked: '当前浏览器不允许剪贴板写入（请用 https 或手动选择文本）',
  failed: '复制失败，请手动选择文本',
}

/**
 * fork：「状态」列（交易日状态）的兜底文案。
 *
 * 正常标签一般由后端 ``map_row`` 给出（``status_label``），这里只在老响应没有
 * 该字段时兜底 —— 没有状态记录就是正常交易。
 */
const TRADE_STATUS_TEXTS_ZH = {
  normal: '正常',
  group: (label: string, group: string) => `${label}（${group}）`,
}

/** fork：条件选股入口与列表页里直接写死的文案（变量名以 _ZH 结尾，check:i18n 放行）。 */
const FORK_ANALYSIS_TEXTS_ZH = {
  addStock: '添加股票',
  searchPlaceholder: '搜索代码或名称',
  noMatch: '没有匹配的股票',
  prevPage: '上一页',
  nextPage: '下一页',
  unfollow: '取消关注',
  unfollowDescription: '取消后该股票将从关注列表移除，关联的价格提醒也会一并清理。',
  /**
   * 指标列的空态文案（原来借用上游的「暂无技术面/AI 分析」）。
   * 用户要求缩成两个字：这列已经压到 120px，长句必被截断。
   */
  indicatorEmpty: '暂无',
  /** 指标列空态悬停说明（两个字看不出「没有什么」，鼠标悬停补全） */
  indicatorEmptyHint: '暂无技术面/AI 分析',
  /** 操作列里那颗「A」图标（配置监控 Agent）的悬停提示 */
  agentRunning: (name: string) => `执行中 · ${name}`,
}

/**
 * 操作列里的「A」图标（配置监控 Agent）。
 *
 * 为什么是文字字形而不是 lucide 图标：锁定的 lucide-react 0.300 里没有单字母 A
 * （``ALargeSmall``/``LetterA`` 都是 0.4x 才加的，只有 ``case-upper`` = 「AA」，
 * 14px 下两个字母挤在一起认不出来）。所以用一个 14px 盒子里的粗体 A —— 盒子尺寸
 * 与其他按钮里的 ``w-3.5 h-3.5`` 图标完全一致，视觉重量靠 font-bold 接近 2px 描边。
 */
function AgentGlyph({ className = '' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-3.5 w-3.5 items-center justify-center text-[13px] font-bold leading-none ${className}`}
    >
      A
    </span>
  )
}

export default function StocksPage() {
  const tour = useGuidedTour()
  const tourQuoteBusy = useRef(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const { t } = useTranslation('configuration')
  // fork：技术面打分器的文案在 bizUi 命名空间的 kline.* 下（与上游徽章同源）。
  // 表里的技术面徽章要复算一遍分数来核对库里的 tech_score，所以需要同一个 translator。
  const { t: bizT } = useTranslation('bizUi')
  const confirmAction = useConfirm()
  const stockT = t as unknown as (key: string, options?: Record<string, unknown>) => string
  const agentName = (name: string, fallback?: string) => localizeAgentName(name, fallback, stockT)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [services, setServices] = useState<AIService[]>([])
  const [channels, setChannels] = useState<NotifyChannel[]>([])
  const [loading, setLoading] = useState(true)

  // Portfolio
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [portfolioRaw, setPortfolioRaw] = useState<PortfolioSummary | null>(null)
  const [portfolioLoading, setPortfolioLoading] = useState(false)
  const [expandedAccounts, setExpandedAccounts] = useState<Set<number>>(new Set())

  // Quotes for all stocks (used in stock list)
  const [quotes, setQuotes] = useState<Record<string, DisplayQuote>>({})
  // Keyed by `${market}:${symbol}` to avoid cross-market symbol collisions
  const [klineSummaries, setKlineSummaries] = useState<Record<string, KlineSummary>>({})

  // fork：自动刷新整块按用户要求移除（开关 + 时间戳 + 定时器 + 持久化的两个 key）。
  // 是「整块」而不是只删界面：localStorage 里上次打开的值会让定时器继续跑，
  // 而页面上已经没有开关能关掉它了。

  type ViewTab = 'positions' | 'watchlist'
  // fork：上游默认打开「持仓」视图，本页只保留关注列表（+ 全市场浏览），
  // 所以固定为 watchlist —— 依赖 viewTab 的「持仓/账户」区块因此永不渲染。
  // 上游那行 useLocalStorage('panwatch_stocks_viewTab') 已移除（切换器也删了）。
  const viewTab = 'watchlist' as ViewTab

  // 建议池建议（来自 /suggestions API）
  const [poolSuggestions, setPoolSuggestions] = useState<Record<string, PoolSuggestion>>({})
  const [priceAlertSummaryMap, setPriceAlertSummaryMap] = useState<Record<string, { total: number; enabled: number }>>({})

  // News Dialog
  const [newsDialogOpen, setNewsDialogOpen] = useState(false)
  const [newsDialogSymbol, setNewsDialogSymbol] = useState<string>('')  // 空=全部, 否则=指定股票
  const [news, setNews] = useState<NewsItem[]>([])
  const [newsLoading, setNewsLoading] = useState(false)

  // Kline Dialog
  const [klineDialogOpen, setKlineDialogOpen] = useState(false)
  const [klineDialogSymbol, setKlineDialogSymbol] = useState('')
  const [klineDialogMarket, setKlineDialogMarket] = useState('CN')
  const [klineDialogName, setKlineDialogName] = useState<string | undefined>(undefined)
  const [klineDialogHasPosition, setKlineDialogHasPosition] = useState<boolean>(false)
  const [klineDialogInitialSummary, setKlineDialogInitialSummary] = useState<KlineSummary | null>(null)
  const [insightOpen, setInsightOpen] = useState(false)
  const [insightSymbol, setInsightSymbol] = useState('')
  const [insightMarket, setInsightMarket] = useState('CN')
  const [insightName, setInsightName] = useState<string | undefined>(undefined)
  const [insightHasPosition, setInsightHasPosition] = useState(false)

  // Market status
  const [marketStatus, setMarketStatus] = useState<MarketStatus[]>([])
  const initialLoadPromiseRef = useRef<Promise<void> | null>(null)
  const configLoadPromiseRef = useRef<Promise<void> | null>(null)
  const configLoadedRef = useRef(false)

  // Stock form
  const [showStockForm, setShowStockForm] = useState(false)
  const [stockForm, setStockForm] = useState<StockForm>(emptyStockForm)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMarket, setSearchMarket] = useState('')  // 搜索市场筛选
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [showDropdown, setShowDropdown] = useState(false)
  const [searching, setSearching] = useState(false)
  const [refreshingStockList, setRefreshingStockList] = useState(false)

  // Account form
  const [accountDialogOpen, setAccountDialogOpen] = useState(false)
  const [accountForm, setAccountForm] = useState<AccountForm>(emptyAccountForm)
  const [editAccountId, setEditAccountId] = useState<number | null>(null)

  // Position form
  const [positionDialogOpen, setPositionDialogOpen] = useState(false)
  const [positionForm, setPositionForm] = useState<PositionForm>({ account_id: 0, stock_id: 0, cost_price: '', quantity: '', invested_amount: '', trading_style: '', stock_symbol: '', stock_name: '', stock_market: 'CN', stock_asset_type: 'stock' })
  const [editPositionId, setEditPositionId] = useState<number | null>(null)
  const [positionDialogAccountId, setPositionDialogAccountId] = useState<number | null>(null)
  const [positionSearchQuery, setPositionSearchQuery] = useState('')
  const [positionSearchMarket, setPositionSearchMarket] = useState('')  // 搜索市场筛选
  const [positionSearchResults, setPositionSearchResults] = useState<SearchResult[]>([])
  const [positionSearching, setPositionSearching] = useState(false)
  const [showPositionDropdown, setShowPositionDropdown] = useState(false)
  const positionSearchTimer = useRef<ReturnType<typeof setTimeout>>()
  const positionDropdownRef = useRef<HTMLDivElement>(null)

  // Agent dialog
  const [agentDialogStock, setAgentDialogStock] = useState<Stock | null>(null)

  // 深度分析(TradingAgents)弹窗
  // fork：stockId<=0 表示该股票未关注 —— 后端走无绑定通道（不落库、不写自选），
  // 因此「全部」列表里未关注的股票同样能做 AI 深度分析。
  const [deepAnalysisTarget, setDeepAnalysisTarget] = useState<{
    stockId: number
    symbol: string
    name: string
    market: string
  } | null>(null)
  const openDeepAnalysis = useCallback(
    (stockId: number, symbol: string, name: string, market = 'CN') => {
      setDeepAnalysisTarget({ stockId, symbol, name, market })
    },
    [],
  )
  const [triggeringAgent, setTriggeringAgent] = useState<string | null>(null)
  const [schedulePreviewCache, setSchedulePreviewCache] = useState<Record<string, SchedulePreview | { error: string }>>({})
  const [schedulePreviewLoading, setSchedulePreviewLoading] = useState<Record<string, boolean>>({})
  // 运行中的单只股票 Agent（按股票标记具体 Agent 名称）
  const [runningAgents, setRunningAgents] = useState<Record<number, string | null>>({})
  const [agentResultDialog, setAgentResultDialog] = useState<{ title: string; content: string; should_alert: boolean; notified: boolean } | null>(null)

  // Stock list filter（fork：板块维度 上证/深证/科创/创业/ST）
  const [stockListFilter, setStockListFilter] = useState<BoardKey>('all')
  // fork：分析页只服务 A 股全市场。上游那套「关注 / 全部」范围切换已去掉
  // （用户要求：本页不再有「关注」），所以范围固定成 'market' —— 保留下面的
  // watch 分支只是为了让 merge upstream 时的 diff 尽量小，界面上够不到它。
  const stockScope = 'market' as 'watch' | 'market'
  // fork：全市场各板块总数（由 StockMarketTable 拉取后回传，用于市场下拉的计数）
  const [marketCounts, setMarketCounts] = useState<MarketBoardCounts | null>(null)
  // 递增后让行情表重新向本机 MySQL 取全量。「刷新」只动这个，不再打外网行情。
  const [marketReloadToken, setMarketReloadToken] = useState(0)
  const [tableLoading, setTableLoading] = useState(false)
  // fork：批量添加弹窗
  const [showBatchAdd, setShowBatchAdd] = useState(false)
  /* fork：条件选股（需求规格 §5）。三件状态：
       screenOpen      弹窗开关
       screenResult    已生效的选股结果（含当次请求，供「修改条件」「重新选股」复用）
       marketAsof      表格最近一次加载的数据截止日（弹窗 footer 显示「数据截至」）
     「退出选股」只把 screenResult 置空 —— 表格自己留着全量数据，不重新请求。 */
  const [screenOpen, setScreenOpen] = useState(false)
  const [screenResult, setScreenResult] = useState<{
    request: ScreenRequest
    response: ScreenResponse
  } | null>(null)
  const [screenRerunning, setScreenRerunning] = useState(false)
  /* fork：弹窗打开时用的初始请求。普通「条件选股」= 上次的请求（没有就是空）；
     从「已保存条件 → 编辑」打开 = 那个条件存下来的完整请求。 */
  const [screenInitial, setScreenInitial] = useState<ScreenRequest | null>(null)
  /* fork：已保存条件（用户反馈 2026-10-20 第 1 / 2 条）。
       presets          服务器上现有的条件（名字 = 文件名）
       presetName       下拉里选中的那个
       screenPresetName 弹窗是从哪个已保存条件打开的（有值时弹窗多一个「删除」）
       saveOpen         保存条件弹窗 */
  const [presets, setPresets] = useState<ScreenPreset[]>([])
  const [presetName, setPresetName] = useState<string | null>(null)
  const [screenPresetName, setScreenPresetName] = useState<string | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  /* 要保存的那份请求：弹窗底部「保存」交出的是**当前草稿**（第 5 条），
     所以不能再像横幅时代那样直接读 screenResult.request。 */
  const [saveRequest, setSaveRequest] = useState<ScreenRequest | null>(null)
  const [marketAsof, setMarketAsof] = useState<string | null>(null)
  /* fork：搜索词由页面持有，StockMarketTable 受控（搜索框在分页条左侧，上下各一个）。 */
  const [stockQuery, setStockQuery] = useState('')
  /* fork：除板块以外的三组筛选（状态/涨跌/市值），见 lib/market-filters.ts */
  const [marketFilters, setMarketFilters] = useState<MarketTableFilters>(EMPTY_MARKET_FILTERS)
  /* fork：筛选行右端那三项元信息 —— 数据时间/版本/提交时间全部来自
     /stocks/market-meta（数据时间＝行情库最后一次同步，不是页面载入时刻） */
  const [buildMeta, setBuildMeta] = useState<BuildMeta | null>(null)
  /* fork：数据时间/提交时间只取一次（部署产物与同步记录是库里的状态，
     进入页面时取一次足够；要看最新就重新载入页面）。拿不到就算了 ——
     这一行是给人对版本用，失败不该影响表格。 */
  useEffect(() => {
    let alive = true
    fetchAPI<BuildMeta>('/stocks/market-meta')
      .then(value => {
        if (alive) setBuildMeta(value || null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  /* fork：关注范围的前端分页（与全部范围同样的 100 上限） */
  const [watchScopeOffset, setWatchScopeOffset] = useState(0)
  useEffect(() => {
    if (!tour?.active || !['stock', 'quote', 'analysis'].includes(tour.step || '')) return
    setStockListFilter('all')
  }, [tour?.active, tour?.step])

  // Remove watchlist modal
  const [removeWatchStock, setRemoveWatchStock] = useState<Stock | null>(null)
  const [removingWatchStock, setRemovingWatchStock] = useState(false)
  const [draggingWatchStockId, setDraggingWatchStockId] = useState<number | null>(null)
  const [draggingPositionId, setDraggingPositionId] = useState<number | null>(null)
  const [draggingPositionAccountId, setDraggingPositionAccountId] = useState<number | null>(null)
  const watchDragSnapshotRef = useRef<Stock[] | null>(null)
  const positionDragSnapshotRef = useRef<PortfolioSummary | null>(null)

  const { toast } = useToast()

  const moveById = <T extends { id: number }>(list: T[], fromId: number, toId: number): T[] => {
    const fromIdx = list.findIndex(x => x.id === fromId)
    const toIdx = list.findIndex(x => x.id === toId)
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return list
    const next = [...list]
    const [moved] = next.splice(fromIdx, 1)
    next.splice(toIdx, 0, moved)
    return next
  }

  const persistWatchlistOrder = useCallback(async (ordered: Stock[]) => {
    const payload = ordered.map((s, idx) => ({ id: s.id, sort_order: idx + 1 }))
    await fetchAPI('/stocks/reorder', {
      method: 'PUT',
      body: JSON.stringify({ items: payload }),
    })
  }, [])

  const previewWatchlistReorder = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return
    setStocks(prev => {
      const ordered = [...prev].sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
      const moved = moveById(ordered, fromId, toId)
      return moved.map((s, idx) => ({ ...s, sort_order: idx + 1 }))
    })
  }, [])

  const commitWatchlistReorder = useCallback(async () => {
    const current = stocks
    if (!current || current.length === 0) return
    try {
      await persistWatchlistOrder(current)
    } catch (e) {
      if (watchDragSnapshotRef.current) setStocks(watchDragSnapshotRef.current)
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.saveWatchOrderFailed'), 'error')
    }
  }, [persistWatchlistOrder, stocks, toast])

  const persistPositionOrder = useCallback(async (ordered: Position[]) => {
    const payload = ordered.map((p, idx) => ({ id: p.id, sort_order: idx + 1 }))
    await fetchAPI('/positions/reorder/batch', {
      method: 'PUT',
      body: JSON.stringify({ items: payload }),
    })
  }, [])

  const previewPositionReorder = useCallback((accountId: number, fromId: number, toId: number) => {
    if (fromId === toId) return
    setPortfolioRaw(prev => {
      if (!prev) return prev
      const accountsNext = prev.accounts.map(acc => {
        if (acc.id !== accountId) return acc
        const moved = moveById(acc.positions || [], fromId, toId).map((p, idx) => ({ ...p, sort_order: idx + 1 }))
        return { ...acc, positions: moved }
      })
      return { ...prev, accounts: accountsNext }
    })
  }, [])

  const commitPositionReorder = useCallback(async (accountId: number) => {
    const acc = portfolioRaw?.accounts?.find(a => a.id === accountId)
    const ordered = acc?.positions || []
    if (!ordered.length) return
    try {
      await persistPositionOrder(ordered)
    } catch (e) {
      if (positionDragSnapshotRef.current) setPortfolioRaw(positionDragSnapshotRef.current)
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.savePositionOrderFailed'), 'error')
    }
  }, [persistPositionOrder, portfolioRaw, toast])

  const isSuppressCardClick = () => {
    try {
      const until = (window as any).__panwatch_suppress_card_click_until
      return typeof until === 'number' && Date.now() < until
    } catch {
      return false
    }
  }
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const dropdownRef = useRef<HTMLDivElement>(null)

  const buildQuoteItems = useCallback((): QuoteRequestItem[] => {
    return buildQuoteItemsFrom(stocks, portfolioRaw)
  }, [stocks, portfolioRaw])

  const requestQuotes = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<QuoteResponse[]> => {
    if (items.length === 0) return []
    try {
      return await fetchAPI<QuoteResponse[]>('/quotes/batch', {
        method: 'POST',
        body: JSON.stringify({ items }),
        signal,
      })
    } catch (e) {
      console.warn('刷新行情失败:', e)
      return []
    }
  }, [])

  const requestSuggestions = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<Record<string, PoolSuggestion>> => {
    if (items.length === 0) return {}
    try {
      const params = new URLSearchParams({
        include_expired: 'true',
        stock_keys: buildPortfolioStockKeys(items),
      })
      return await fetchAPI<Record<string, PoolSuggestion>>(`/suggestions?${params.toString()}`, { signal })
    } catch (e) {
      console.warn('加载建议池失败:', e)
      return {}
    }
  }, [])

  const requestPriceAlerts = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<PriceAlertRuleSummary[]> => {
    if (items.length === 0) return []
    try {
      return await fetchAPI<PriceAlertRuleSummary[]>('/price-alerts', { signal })
    } catch (e) {
      console.warn('加载提醒摘要失败:', e)
      return []
    }
  }, [])

  const requestKlineSummaries = useCallback(async (items: QuoteRequestItem[], signal?: AbortSignal): Promise<Record<string, KlineSummary>> => {
    if (items.length === 0) return {}
    try {
      const data = await klinesApi.summaryBatch(items, signal)
      const map: Record<string, KlineSummary> = {}
      for (const item of data || []) {
        if (item && item.summary && !('error' in item.summary)) {
          map[`${item.market}:${item.symbol}`] = item.summary as unknown as KlineSummary
        }
      }
      return map
    } catch {
      // 批量请求失败时保留旧摘要，避免技术徽章整体闪断。
      return {}
    }
  }, [])

  const loadNewStockSummary = useCallback(async (item: QuoteRequestItem) => {
    const map = await requestKlineSummaries([item])
    setKlineSummaries(prev => ({ ...prev, ...map }))
  }, [requestKlineSummaries])

  const refreshMarketStatus = useCallback(async (signal?: AbortSignal): Promise<MarketStatus[]> => {
    try {
      const data = await fetchAPI<MarketStatus[]>('/stocks/markets/status', { signal })
      if (!signal?.aborted) setMarketStatus(data)
      return data
    } catch (error) {
      if (!signal?.aborted) console.warn('获取市场状态失败:', error)
      return []
    }
  }, [])

  useEffect(() => {
    if (!portfolioRaw) return
    setPortfolio(mergePortfolioQuotes(portfolioRaw, applyMarketStatuses(quotes, marketStatus)))
  }, [portfolioRaw, quotes, marketStatus])

  // 从建议池加载建议（包含历史建议和多来源建议）
  const loadPoolSuggestions = useCallback(async (itemsOverride?: QuoteRequestItem[]) => {
    const data = await requestSuggestions(itemsOverride || buildQuoteItems())
    setPoolSuggestions(data)
  }, [buildQuoteItems, requestSuggestions])

  const loadPriceAlertSummaries = useCallback(async () => {
    const rows = await requestPriceAlerts(buildQuoteItems())
    setPriceAlertSummaryMap(toPriceAlertSummaryMap(rows))
  }, [buildQuoteItems, requestPriceAlerts])

  const loadConfigAsync = useCallback((signal?: AbortSignal): Promise<void> => {
    if (configLoadedRef.current) return Promise.resolve()
    if (configLoadPromiseRef.current) return configLoadPromiseRef.current

    const run = (async () => {
      try {
        const [agentData, servicesData, channelsData] = await Promise.all([
          fetchAPI<AgentConfig[]>('/agents', { signal }),
          fetchAPI<AIService[]>('/providers/services', { signal }),
          fetchAPI<NotifyChannel[]>('/channels', { signal }),
        ])
        setAgents(agentData)
        setServices(servicesData)
        setChannels(channelsData)
        configLoadedRef.current = true
      } catch (e) {
        console.warn('加载配置数据失败:', e)
      }
    })()
    configLoadPromiseRef.current = run
    void run.finally(() => {
      configLoadPromiseRef.current = null
    })
    return run
  }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const stockData = await fetchAPI<Stock[]>('/stocks', { signal })
      setStocks(stockData)
    } catch (e) {
      if (!signal?.aborted) console.error(e)
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  const loadPortfolio = useCallback(async () => {
    try {
      // Mutation refresh is local metadata only; render using the quotes already on screen.
      const portfolioData = await fetchAPI<PortfolioSummary>('/portfolio/summary?include_quotes=false&refresh_exchange_rates=false')
      setPortfolioRaw(portfolioData)
      setAccounts(portfolioData.accounts.map(account => ({
        id: account.id,
        name: account.name,
        available_funds: account.available_funds,
        enabled: true,
      })))
      setExpandedAccounts(prev => new Set([...prev, ...portfolioData.accounts.map(account => account.id)]))
      setPortfolio(mergePortfolioQuotes(portfolioData, quotes))

      // New symbols may need a quote; cost/quantity/account edits need no market-data fetch.
      const missing = buildQuoteItemsFrom(stocks, portfolioData).filter(item => !quotes[`${item.market}:${item.symbol}`])
      if (missing.length > 0) {
        void requestQuotes(missing).then(rows => {
          setQuotes(prev => ({ ...prev, ...toQuoteMap(rows) }))
        })
      }
    } catch (e) {
      console.error(e)
    }
  }, [requestQuotes, quotes, stocks])

  const loadInitialData = useCallback((signal: AbortSignal): Promise<void> => {
    if (initialLoadPromiseRef.current) return initialLoadPromiseRef.current
    setLoading(true)
    setPortfolioLoading(true)

    const run = (async () => {
      const coreData = await loadPortfolioPageCoreData({
        loadStocks: requestSignal => fetchAPI<Stock[]>('/stocks', { signal: requestSignal }),
        loadPortfolio: requestSignal => fetchAPI<PortfolioSummary>('/portfolio/summary?include_quotes=false&refresh_exchange_rates=false', { signal: requestSignal }),
      }, signal)

      if (signal.aborted) return

      // Publish local metadata immediately; market-data lanes update independently.
      const quoteMap: Record<string, QuoteResponse> = {}
      setStocks(coreData.stocks)
      setPortfolioRaw(coreData.portfolio)
      setQuotes(quoteMap)
      setKlineSummaries({})
      setPoolSuggestions({})
      setPriceAlertSummaryMap({})
      setPortfolio(mergePortfolioQuotes(coreData.portfolio, quoteMap))
      const nextAccounts = coreData.portfolio.accounts.map(account => ({
        id: account.id,
        name: account.name,
        available_funds: account.available_funds,
        enabled: true,
      }))
      setAccounts(nextAccounts)
      setExpandedAccounts(new Set(nextAccounts.map(account => account.id)))
      setLoading(false)
      setPortfolioLoading(false)

      // fork：表格的现价和技术面来自本机 MySQL，这里不再打 /quotes/batch
      // 和 /klines/summary/batch。那两条会把自选批量打到外网数据源上，
      // 正是分析页要避开的限流路径。建议池和价格提醒仍走本机接口。

      // FX refresh also runs independently of the metadata shell and quotes.
      void fetchAPI<PortfolioSummary>('/portfolio/summary?include_quotes=false', { signal }).then(data => {
        if (!signal.aborted) setPortfolioRaw(previous => previous ? { ...previous, exchange_rates: data.exchange_rates } : previous)
      }).catch(error => {
        if (!signal.aborted) console.warn('Portfolio exchange rates unavailable:', error)
      })

      void loadPortfolioPageBackgroundData({
        loadMarketStatus: refreshMarketStatus,
        buildQuoteItems: buildQuoteItemsFrom,
        loadSuggestions: requestSuggestions,
        loadPriceAlerts: requestPriceAlerts,
        loadKlines: async () => ({}),
      }, coreData.stocks, coreData.portfolio, signal, {
        suggestions: setPoolSuggestions,
        priceAlerts: data => setPriceAlertSummaryMap(toPriceAlertSummaryMap(data)),
      }).catch(error => {
        if (!signal.aborted) console.warn('加载持仓页后台数据失败:', error)
      })
    })().catch(error => {
      if (!signal.aborted) console.error('加载持仓页面数据失败:', error)
    }).finally(() => {
      if (!signal.aborted) { setLoading(false); setPortfolioLoading(false) }
      initialLoadPromiseRef.current = null
    })

    initialLoadPromiseRef.current = run
    return run
  }, [refreshMarketStatus, requestPriceAlerts, requestSuggestions])

  // Load news for specific stock or all watchlist
  const loadNews = useCallback(async (stockName?: string) => {
    setNewsLoading(true)
    try {
      const params = new URLSearchParams({ hours: '168', limit: '50' })  // 7天
      if (stockName) {
        // 直接传递股票名称，比代码更稳定
        params.set('names', stockName)
      }
      const newsData = await fetchAPI<NewsItem[]>(`/news?${params}`)
      setNews(newsData)
    } catch (e) {
      console.error('加载新闻失败:', e)
    } finally {
      setNewsLoading(false)
    }
  }, [])

  const openKlineDialog = useCallback((symbol: string, market: string, name?: string, hasPosition?: boolean) => {
    setKlineDialogSymbol(symbol)
    setKlineDialogMarket(market || 'CN')
    setKlineDialogName(name)
    setKlineDialogHasPosition(!!hasPosition)
    const m = market || 'CN'
    setKlineDialogInitialSummary(klineSummaries[`${m}:${symbol}`] || null)
    setKlineDialogOpen(true)
  }, [klineSummaries])

  const handledAssistantTargetRef = useRef<string | null>(null)
  useEffect(() => {
    const target = parseAssistantPortfolioTarget(searchParams)
    if (!target) {
      handledAssistantTargetRef.current = null
      return
    }
    const key = `${target.market}:${target.symbol}`
    if (handledAssistantTargetRef.current === key) return
    handledAssistantTargetRef.current = key
    openKlineDialog(target.symbol, target.market)
    const next = new URLSearchParams(searchParams)
    next.delete('view')
    next.delete('symbol')
    next.delete('market')
    setSearchParams(next, { replace: true })
  }, [openKlineDialog, searchParams, setSearchParams])

  // Open news dialog - pass stock name for more stable search
  const openNewsDialog = useCallback((stockName?: string) => {
    setNewsDialogSymbol(stockName || '')  // 存储名称用于 UI 显示
    setNewsDialogOpen(true)
    loadNews(stockName)
  }, [loadNews])

  const openStockDetail = useCallback((stockSymbol: string, stockMarket: string, stockName?: string, hasPosition?: boolean) => {
    setInsightSymbol(stockSymbol)
    setInsightMarket(stockMarket || 'CN')
    setInsightName(stockName)
    setInsightHasPosition(!!hasPosition)
    setInsightOpen(true)
  }, [])

  const formatPreviewTime = (iso: string): string => {
    try {
      const d = new Date(iso)
      if (isNaN(d.getTime())) return iso
      return d.toLocaleString(getCurrentLocale(), {
        timeZone: browserTimezone(),
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    } catch {
      return iso
    }
  }

  const effectiveSchedule = (agent: AgentConfig, stockAgent?: StockAgentInfo | null): string => {
    const local = (stockAgent?.schedule || '').trim()
    if (local) return local
    return (agent.schedule || '').trim()
  }

  /* fork：条件选股 —— 用同一份请求重跑（横幅的「重新选股」与工具条的「刷新」共用）。
     失败时只 toast，**保留旧结果**（把表格清空成空列表是最坏的选择：用户会以为
     条件真的没有命中，而不是「这次没跑成功」）。 */
  const rerunScreen = useCallback(async () => {
    if (!screenResult || screenRerunning) return
    setScreenRerunning(true)
    try {
      const response = await screenStocks(screenResult.request)
      setScreenResult({ request: screenResult.request, response })
      toast(SCREEN_TEXTS_ZH.success(response.total), 'success')
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      toast(SCREEN_TEXTS_ZH.rerunFailed(message), 'error')
    } finally {
      setScreenRerunning(false)
    }
  }, [screenResult, screenRerunning, toast])

  /* fork：重新读一次「已保存条件」（进页面 / 保存后 / 删除后）。
     失败只 toast —— 这是辅助功能，不该影响表格与选股。 */
  const reloadPresets = useCallback(async () => {
    try {
      const items = await listPresets()
      setPresets(items)
      // 删掉/改名之后，下拉里那个已经不存在的选中项要清掉
      setPresetName(current => (current && items.some(item => item.name === current) ? current : null))
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      toast(SCREEN_PRESET_TEXTS_ZH.loadFailed(message), 'error')
    }
  }, [toast])

  useEffect(() => {
    void reloadPresets()
  }, [reloadPresets])

  /**
   * 打开条件选股弹窗。
   *
   * `fromPreset` 有值 = 从「已保存条件 → 编辑」进来：把那条件存下来的**完整请求**
   * 填回去（窗口 / 市场 / 市值 / 条件树），并让弹窗显示「覆盖保存 / 删除」。
   * 没有值 = 普通「条件选股」：沿用上一次跑过的请求（没有就是空）。
   *
   * 老文件里的条件可能缺参数（上一版前端把「连续上涨」的 start/days 丢了），
   * 所以进来先 `fillDefaultParams` 补默认值 —— 否则摘要会显示 undefined、
   * 提交时被校验拦下。
   */
  const openScreenDialog = useCallback(
    (fromPreset?: string) => {
      const preset = fromPreset ? presets.find(item => item.name === fromPreset) : null
      const base = preset ? preset.request : screenResult?.request ?? null
      setScreenInitial(base ? { ...base, rule: fillDefaultParams(base.rule) } : null)
      setScreenPresetName(preset ? preset.name : null)
      setScreenOpen(true)
    },
    [presets, screenResult],
  )

  /** 「保存条件」：同名先问一句「覆盖？」，存成功后在下拉里选中它。 */
  const handleSavePreset = useCallback(
    async (name: string): Promise<boolean> => {
      const request = saveRequest ?? screenResult?.request
      if (!request) return false
      const exists = presets.some(item => item.name === name)
      if (exists) {
        const ok = await confirmAction(SCREEN_PRESET_TEXTS_ZH.overwriteConfirm(name), {
          destructive: true,
          title: SCREEN_PRESET_TEXTS_ZH.overwriteTitle,
        })
        // 用户选了「不覆盖」：留在保存弹窗里，名字可以再改
        if (!ok) return false
      }
      await savePreset(name, request, exists)
      await reloadPresets()
      setPresetName(name)
      // 弹窗还开着时把它切成「已保存」状态：按钮变「覆盖保存」、删除可用
      setScreenPresetName(name)
      toast(SCREEN_PRESET_TEXTS_ZH.saved(name), 'success')
      return true
    },
    [confirmAction, presets, reloadPresets, saveRequest, screenResult, toast],
  )

  /**
   * 条件选股弹窗底部的「保存」（第 5 条）。
   *
   * 有名字（从已保存条件打开）= 直接覆盖那个文件，不再弹名字、也不再问一遍「覆盖？」——
   * 用户点的就是「覆盖保存」。没名字 = 弹输入框（名字即文件名）。
   */
  const handleSaveFromDialog = useCallback(
    async (request: ScreenRequest, name: string | null) => {
      setSaveRequest(request)
      if (!name) {
        setSaveOpen(true)
        return
      }
      try {
        await savePreset(name, request, true)
        await reloadPresets()
        setPresetName(name)
        setScreenPresetName(name)
        toast(SCREEN_PRESET_TEXTS_ZH.saved(name), 'success')
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc)
        toast(SCREEN_PRESET_TEXTS_ZH.saveFailed(message), 'error')
      }
    },
    [reloadPresets, toast],
  )

  /** 弹窗里的「删除」：按钮一直在，没保存过时禁用（第 5 条），点了先确认。 */
  const handleDeletePreset = useCallback(
    async (name: string) => {
      const ok = await confirmAction(SCREEN_PRESET_TEXTS_ZH.deleteConfirm(name), {
        destructive: true,
        title: SCREEN_PRESET_TEXTS_ZH.deleteTitle,
      })
      if (!ok) return
      try {
        await deletePreset(name)
        setScreenOpen(false)
        toast(SCREEN_PRESET_TEXTS_ZH.deleted(name), 'success')
        await reloadPresets()
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc)
        toast(SCREEN_PRESET_TEXTS_ZH.deleteFailed(message), 'error')
      }
    },
    [confirmAction, reloadPresets, toast],
  )

  // 刷新 = 重新读本机行情库 + 建议池 + 价格提醒。不打外网批量行情/K 线。
  // 选股结果生效时，「刷新」等同于「重新选股」（用户要求）。
  const handleRefresh = useCallback(async () => {
    if (tourQuoteBusy.current) return
    tourQuoteBusy.current = true
    try {
      await tour?.observeQuote()
      if (screenResult) await rerunScreen()
      else setMarketReloadToken(token => token + 1)
      await Promise.all([
        loadPoolSuggestions(),
        loadPriceAlertSummaries(),
      ])
    } finally { tourQuoteBusy.current = false }
  }, [tour, loadPoolSuggestions, loadPriceAlertSummaries, screenResult, rerunScreen])

  useEffect(() => {
    const controller = new AbortController()
    void loadInitialData(controller.signal)
    return () => {
      controller.abort()
      initialLoadPromiseRef.current = null
    }
  }, [loadInitialData])

  useEffect(() => {
    if (agentDialogStock) void loadConfigAsync()
  }, [agentDialogStock, loadConfigAsync])

  // Agent 配置弹窗：预览未来触发时间（用于自检工作日/周末语义）
  useEffect(() => {
    if (!agentDialogStock) return
    if (!agents || agents.length === 0) return

    const stockAgentMap = new Map((agentDialogStock.agents || []).map(a => [a.agent_name, a]))
    const schedules = new Map<string, { schedule: string; agent: string }>()
    for (const agent of agents) {
      if (agent.execution_mode === 'batch') continue
      const sa = stockAgentMap.get(agent.name)
      if (!sa) continue
      const eff = effectiveSchedule(agent, sa)
      if (eff) schedules.set(`${agent.name}|${agentDialogStock?.market}|${eff}`, { schedule: eff, agent: agent.name })
    }

    const toFetch = Array.from(schedules.keys()).filter(s => !schedulePreviewCache[s] && !schedulePreviewLoading[s])
    if (toFetch.length === 0) return

    let cancelled = false
    ;(async () => {
      // Mark loading
      setSchedulePreviewLoading(prev => {
        const next = { ...prev }
        for (const s of toFetch) next[s] = true
        return next
      })
      try {
        const pairs = await Promise.all(toFetch.map(async s => {
          try {
            const plan = schedules.get(s)!
            const p = await fetchAPI<SchedulePreview>(`/agents/schedule/preview?schedule=${encodeURIComponent(plan.schedule)}&agent_name=${encodeURIComponent(plan.agent)}&market=${agentDialogStock.market}&count=5`)
            return [s, p] as const
          } catch (e) {
            const msg = e instanceof Error ? e.message : stockT('stocksPage.messages.previewFailed')
            return [s, { error: msg }] as const
          }
        }))
        if (cancelled) return
        setSchedulePreviewCache(prev => ({ ...prev, ...Object.fromEntries(pairs) }))
      } finally {
        if (cancelled) return
        setSchedulePreviewLoading(prev => {
          const next = { ...prev }
          for (const s of toFetch) next[s] = false
          return next
        })
      }
    })()

    return () => { cancelled = true }
  }, [agentDialogStock, agents, schedulePreviewCache, schedulePreviewLoading])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
      if (positionDropdownRef.current && !positionDropdownRef.current.contains(e.target as Node)) {
        setShowPositionDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ========== Stock handlers ==========
  const doSearch = async (q: string, market: string = searchMarket) => {
    if (q.length < 1) { setSearchResults([]); setShowDropdown(false); return }
    setSearching(true)
    try {
      const marketParam = market ? `&market=${market}` : ''
      const results = await fetchAPI<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}${marketParam}`)
      setSearchResults(results)
      setShowDropdown(results.length > 0)
    } catch { setSearchResults([]) }
    finally { setSearching(false) }
  }

  const handleSearchInput = (value: string) => {
    setSearchQuery(value)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => doSearch(value), 500)
  }

  const handleSearchMarketChange = (market: string) => {
    setSearchMarket(market)
    if (searchQuery) {
      doSearch(searchQuery, market)
    }
  }

  const refreshStockListCache = async () => {
    setRefreshingStockList(true)
    try {
      const result = await fetchAPI<{ count: number }>('/stocks/refresh-list', { method: 'POST' })
      toast(stockT('stocksPage.messages.refreshListDone', { count: result.count }), 'success')
      if (searchQuery) {
        doSearch(searchQuery)
      }
    } catch (e) {
      toast(stockT('stocksPage.messages.refreshFailed'), 'error')
    } finally {
      setRefreshingStockList(false)
    }
  }

  const selectStock = (item: SearchResult) => {
    setStockForm({ symbol: item.symbol, name: item.name, market: item.market, asset_type: item.asset_type || 'stock' })
    setSearchQuery(`${item.symbol} ${item.name}`)
    setShowDropdown(false)
  }

  const handleStockSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const created = await stocksApi.create(stockForm)
      const item = { symbol: created.symbol, market: created.market }
      void requestQuotes([item]).then(rows => setQuotes(prev => ({ ...prev, ...toQuoteMap(rows) })))
      void loadNewStockSummary(item)
      setStockForm(emptyStockForm)
      setSearchQuery('')
      setShowStockForm(false)
      load()
      toast(stockT('stocksPage.messages.stockAdded'), 'success')
      await tour?.selectStock(created.id)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.addStockFailed'), 'error')
    }
  }

  const hasAnyPositionForStockId = (id: number): boolean => {
    return (portfolio?.accounts || []).some(acc => (acc.positions || []).some(p => p.stock_id === id))
  }

  const removeFromWatchlist = async (stock: Stock) => {
    if (hasAnyPositionForStockId(stock.id)) {
      toast(stockT('stocksPage.messages.stockHasPosition'), 'error')
      return
    }

    setRemovingWatchStock(true)
    try {
      await stocksApi.remove(stock.id)
      toast(stockT('stocksPage.messages.stockDeleted'), 'success')
      setRemoveWatchStock(null)
      load()
      // 价格提醒/关联配置会随股票删除，刷新一次避免 UI 残留。
      loadPortfolio()
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.deleteFailed'), 'error')
    } finally {
      setRemovingWatchStock(false)
    }
  }

  // ========== Account handlers ==========
  const openAccountDialog = (account?: Account) => {
    if (account) {
      setAccountForm({ name: account.name, available_funds: account.available_funds.toString() })
      setEditAccountId(account.id)
    } else {
      setAccountForm(emptyAccountForm)
      setEditAccountId(null)
    }
    setAccountDialogOpen(true)
  }

  const handleAccountSubmit = async () => {
    try {
      const payload = {
        name: accountForm.name,
        available_funds: parseFloat(accountForm.available_funds) || 0,
      }
      if (editAccountId) {
        await fetchAPI(`/accounts/${editAccountId}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await fetchAPI('/accounts', { method: 'POST', body: JSON.stringify(payload) })
      }
      setAccountDialogOpen(false)
      load()
      loadPortfolio()
      toast(editAccountId ? stockT('stocksPage.messages.accountUpdated') : stockT('stocksPage.messages.accountCreated'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.saveAccountFailed'), 'error')
    }
  }

  const handleDeleteAccount = async (id: number) => {
    if (!(await confirmAction(stockT('stocksPage.messages.deleteAccountConfirm'), { destructive: true }))) return
    try {
      await fetchAPI(`/accounts/${id}`, { method: 'DELETE' })
      load()
      loadPortfolio()
      toast(stockT('stocksPage.messages.accountDeleted'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.deleteAccountFailed'), 'error')
    }
  }

  // ========== Position handlers ==========
  const openPositionDialog = (accountId: number, position?: Position) => {
    setPositionDialogAccountId(accountId)
    setPositionSearchQuery('')
    setPositionSearchResults([])
    setShowPositionDropdown(false)
    if (position) {
      setPositionForm({
        account_id: accountId,
        stock_id: position.stock_id,
        cost_price: position.cost_price.toString(),
        quantity: position.quantity.toString(),
        invested_amount: position.invested_amount?.toString() || '',
        trading_style: position.trading_style || '',
        stock_symbol: position.symbol,
        stock_name: position.name,
        stock_market: position.market,
        stock_asset_type: position.asset_type || 'stock',
      })
      setEditPositionId(position.id)
    } else {
      setPositionForm({
        account_id: accountId,
        stock_id: 0,
        cost_price: '',
        quantity: '',
        invested_amount: '',
        trading_style: '',
        stock_symbol: '',
        stock_name: '',
        stock_market: 'CN',
        stock_asset_type: 'stock',
      })
      setEditPositionId(null)
    }
    setPositionDialogOpen(true)
  }

  const doPositionSearch = async (q: string, market: string = positionSearchMarket) => {
    if (q.length < 1) { setPositionSearchResults([]); setShowPositionDropdown(false); return }
    setPositionSearching(true)
    try {
      const marketParam = market ? `&market=${market}` : ''
      const results = await fetchAPI<SearchResult[]>(`/stocks/search?q=${encodeURIComponent(q)}${marketParam}`)
      setPositionSearchResults(results)
      setShowPositionDropdown(results.length > 0)
    } catch { setPositionSearchResults([]) }
    finally { setPositionSearching(false) }
  }

  const handlePositionSearchInput = (value: string) => {
    setPositionSearchQuery(value)
    clearTimeout(positionSearchTimer.current)
    positionSearchTimer.current = setTimeout(() => doPositionSearch(value), 500)
  }

  const handlePositionSearchMarketChange = (market: string) => {
    setPositionSearchMarket(market)
    if (positionSearchQuery) {
      doPositionSearch(positionSearchQuery, market)
    }
  }

  const selectPositionStock = (item: SearchResult) => {
    // 检查是否已有此股票
    const existing = stocks.find(s => s.symbol === item.symbol && s.market === item.market)
    setPositionForm({
      ...positionForm,
      stock_id: existing?.id || 0,
      stock_symbol: item.symbol,
      stock_name: item.name,
      stock_market: item.market,
      stock_asset_type: existing?.asset_type || item.asset_type || 'stock',
    })
    setPositionSearchQuery(`${item.symbol} ${item.name}`)
    setShowPositionDropdown(false)
  }

  const handlePositionSubmit = async () => {
    try {
      let stockId = positionForm.stock_id
      let createdStock: QuoteRequestItem | undefined

      // 如果是新增且股票不在自选中，先添加到自选
      if (!editPositionId && !stockId && positionForm.stock_symbol) {
        try {
          const newStock = await fetchAPI<Stock>('/stocks', {
            method: 'POST',
            body: JSON.stringify({
              symbol: positionForm.stock_symbol,
              name: positionForm.stock_name,
              market: positionForm.stock_market,
              asset_type: positionForm.stock_asset_type,
            })
          })
          stockId = newStock.id
          createdStock = { symbol: newStock.symbol, market: newStock.market }
          load() // 刷新股票列表
        } catch {
          // 股票可能已存在，尝试获取（兼容并发创建/历史数据）。
          try {
            const existingStocks = await fetchAPI<Stock[]>('/stocks')
            const existing = existingStocks.find(s => s.symbol === positionForm.stock_symbol && s.market === positionForm.stock_market)
            if (existing) {
              stockId = existing.id
            } else {
              toast(stockT('stocksPage.messages.addStockFailed'), 'error')
              return
            }
          } catch (e) {
            toast(e instanceof Error ? e.message : stockT('stocksPage.messages.addStockFailed'), 'error')
            return
          }
        }
      }

      const payload = {
        account_id: positionForm.account_id,
        stock_id: stockId,
        cost_price: parseFloat(positionForm.cost_price),
        quantity: parseInt(positionForm.quantity),
        invested_amount: positionForm.invested_amount ? parseFloat(positionForm.invested_amount) : null,
        trading_style: positionForm.trading_style,  // 空字符串表示清空
      }
      if (editPositionId) {
        await fetchAPI(`/positions/${editPositionId}`, { method: 'PUT', body: JSON.stringify(payload) })
      } else {
        await fetchAPI('/positions', { method: 'POST', body: JSON.stringify(payload) })
      }
      const existingStock = stocks.find(stock => stock.id === stockId)
      if (existingStock && (existingStock.asset_type || 'stock') !== positionForm.stock_asset_type) {
        const updatedStock = await fetchAPI<Stock>(`/stocks/${stockId}`, {
          method: 'PUT', body: JSON.stringify({ asset_type: positionForm.stock_asset_type }),
        })
        setStocks(previous => previous.map(stock => stock.id === stockId ? updatedStock : stock))
      }
      setPositionDialogOpen(false)
      if (createdStock) void loadNewStockSummary(createdStock)
      loadPortfolio()
      toast(editPositionId ? stockT('stocksPage.messages.positionUpdated') : stockT('stocksPage.messages.positionAdded'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.savePositionFailed'), 'error')
    }
  }

  const handleDeletePosition = async (id: number) => {
    if (!(await confirmAction(stockT('stocksPage.messages.deletePositionConfirm'), { destructive: true }))) return
    try {
      await fetchAPI(`/positions/${id}`, { method: 'DELETE' })
      loadPortfolio()
      toast(stockT('stocksPage.messages.positionDeleted'), 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.deletePositionFailed'), 'error')
    }
  }

  // ========== Agent handlers ==========
  const toggleAgent = async (stock: Stock, agentName: string) => {
    try {
      const current = stock.agents || []
      const isAssigned = current.some(a => a.agent_name === agentName)
      const newAgents = isAssigned
        ? current.filter(a => a.agent_name !== agentName)
        : [...current, { agent_name: agentName, schedule: '', ai_model_id: null, notify_channel_ids: [] }]
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentBindingFailed'), 'error')
    }
  }

  const triggerStockAgent = async (stockId: number, agentName: string) => {
    setTriggeringAgent(agentName)
    setRunningAgents(prev => ({ ...prev, [stockId]: agentName }))
    // 触发后立即关闭配置弹窗，避免多层弹窗干扰
    setAgentDialogStock(null)
    try {
      // 手动触发时跳过节流，方便测试
      const resp = await fetchAPI<{ result: AgentResult; success?: boolean; message?: string }>(
        `/stocks/${stockId}/agents/${agentName}/trigger?bypass_throttle=true`,
        { method: 'POST' }
      )
      const result = resp?.result
      if (result) {
        // 仅提示，不再弹出结果弹窗，避免干扰
        if (result.success === false) {
          toast(result.message || result.content || stockT('stocksPage.messages.notExecuted'), 'info')
          return
        }
        const isSkipped = !!result.skipped || /已跳过执行|非交易时段/.test(result.content || '')
        if (isSkipped) {
          toast(result.content || stockT('stocksPage.messages.nonTradingSkipped'), 'info')
        } else {
          toast(result.should_alert ? stockT('stocksPage.messages.suggested') : stockT('stocksPage.messages.noNeedAttention'), result.should_alert ? 'success' : 'info')
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : stockT('stocksPage.messages.triggerFailed')
      if (/非交易时段|跳过执行/.test(msg)) {
        toast(msg, 'info')
      } else {
        toast(msg, 'error')
      }
    } finally {
      setTriggeringAgent(null)
      setRunningAgents(prev => ({ ...prev, [stockId]: null }))
    }
  }

  const updateStockAgentModel = async (stock: Stock, agentName: string, modelId: number | null) => {
    try {
      const newAgents = (stock.agents || []).map(a =>
        a.agent_name === agentName ? { ...a, ai_model_id: modelId } : a
      )
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentModelFailed'), 'error')
    }
  }

  const toggleStockAgentChannel = async (stock: Stock, agentName: string, channelId: number) => {
    try {
      const newAgents = (stock.agents || []).map(a => {
        if (a.agent_name !== agentName) return a
        const current = a.notify_channel_ids || []
        const newIds = current.includes(channelId)
          ? current.filter(id => id !== channelId)
          : [...current, channelId]
        return { ...a, notify_channel_ids: newIds }
      })
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentChannelFailed'), 'error')
    }
  }

  const updateStockAgentSchedule = async (stock: Stock, agentName: string, schedule: string) => {
    try {
      const newAgents = (stock.agents || []).map(a =>
        a.agent_name === agentName ? { ...a, schedule } : a
      )
      await fetchAPI(`/stocks/${stock.id}/agents`, { method: 'PUT', body: JSON.stringify({ agents: newAgents }) })
      load()
      setAgentDialogStock(prev => prev ? { ...prev, agents: newAgents } : null)
    } catch (e) {
      toast(e instanceof Error ? e.message : stockT('stocksPage.messages.agentScheduleFailed'), 'error')
    }
  }

  // ========== Helpers ==========
  const formatMoney = (value: number) => {
    if (Math.abs(value) >= 10000) {
      return `${(value / 10000).toFixed(2)}${stockT('stocksPage.largeUnit')}`
    }
    return value.toFixed(2)
  }

  const marketLabel = (m: string) => m === 'CN' ? stockT('stocksPage.markets.cn') : m === 'HK' ? stockT('stocksPage.markets.hk') : m === 'US' ? stockT('stocksPage.markets.us') : m
  const quoteHint = (quote: { daily_move_status?: string; quote_date?: string | null }) => {
    const status = quote.daily_move_status
    const label = status && status !== 'current' ? stockT(`stocksPage.quoteStatus.${status}`) : ''
    const date = quote.quote_date ? stockT('stocksPage.quoteStatus.asOf', { date: quote.quote_date }) : ''
    return [label, date].filter(Boolean).join(' · ')
  }

  // 市场徽章样式和短标签
  const marketBadge = (m: string) => {
    if (m === 'HK') return { style: 'bg-orange-500/10 text-orange-600', label: stockT('stocksPage.markets.hkShort') }
    if (m === 'US') return { style: 'bg-green-500/10 text-green-600', label: stockT('stocksPage.markets.usShort') }
    return { style: 'bg-blue-500/10 text-blue-600', label: 'A' }
  }

  // 保留原始精度显示价格（不强制截断小数位）
  const formatPrice = (value: number) => {
    // 最多显示4位小数，去除末尾的0
    const formatted = value.toFixed(4).replace(/\.?0+$/, '')
    return formatted
  }

  const formatQuotePrice = (value: number, assetType?: 'stock' | 'etf', market?: string) => value.toFixed(assetType === 'etf' && market !== 'US' ? 3 : 2)

  // 获取股票的行情信息
  const getStockQuote = (quoteKey: string) => {
    return quotes[quoteKey] || null
  }

  const getPriceAlertSummary = (symbol: string, market: string) => {
    const m = String(market || 'CN').toUpperCase()
    const raw = String(symbol || '').toUpperCase()
    const bare = normalizeSymbol(raw)
    return priceAlertSummaryMap[`${m}:${raw}`]
      || priceAlertSummaryMap[`${m}:${bare}`]
      || { total: 0, enabled: 0 }
  }

  // 获取股票的建议信息（优先使用建议池，包含来源和时间信息）
  const getSuggestionForStock = (symbol: string, market: string): { suggestion: SuggestionInfo | null; kline: KlineSummary | null } => {
    const m = market || 'CN'
    const bare = normalizeSymbol(symbol)
    const key = [`${m}:${symbol}`, `${m}:${bare}`, `${m}:sh${bare}`, `${m}:sz${bare}`, `${m}:bj${bare}`]
      .find(candidate => poolSuggestions[candidate]) || `${m}:${symbol}`
    // 优先使用建议池的建议（包含来源和时间信息）
    const poolSug =
      poolSuggestions[key] ||
      (() => {
        const fallback = poolSuggestions[symbol] || poolSuggestions[bare]
        if (!fallback) return null
        const fm = String(fallback.stock_market || '').toUpperCase()
        return fm && fm !== String(market || 'CN').toUpperCase() ? null : fallback
      })()
    if (poolSug) {
      const preloadedKline = klineSummaries[key] || null
      return {
        suggestion: {
          ...poolSug,
          id: poolSug.id,
          action: poolSug.action,
          action_label: poolSug.action_label,
          signal: poolSug.signal,
          reason: poolSug.reason,
          should_alert: poolSug.should_alert ?? (['alert', 'avoid', 'sell', 'reduce'].includes(poolSug.action)),
          agent_name: poolSug.agent_name,
          agent_label: poolSug.agent_label,
          created_at: poolSug.created_at,
          is_expired: poolSug.is_expired,
          prompt_context: poolSug.prompt_context,
          ai_response: poolSug.ai_response,
          meta: poolSug.meta,
        },
        // 优先使用本页并发预取的 kline 摘要，确保徽章与弹窗一致且免加载
        kline: preloadedKline,
      }
    }

    const ks = klineSummaries[key]
    if (ks) return { suggestion: null, kline: ks }

    return { suggestion: null, kline: null }
  }

  const unpricedAccountIds = new Set(
    (portfolio?.accounts || []).filter(account => account.positions.some(position => position.current_price == null)).map(account => account.id),
  )
  const portfolioTotalsReady = unpricedAccountIds.size === 0

  const positionRatio = useMemo(() => {
    if (!portfolio || !portfolioTotalsReady) return null
    const mv = portfolio.total.total_market_value || 0
    const assets = portfolio.total.total_assets || 0
    const pct = assets > 0 ? (mv / assets * 100) : 0
    return { mv, assets, pct }
  }, [portfolio, portfolioTotalsReady])

  // fork：上游在这里算 positionsCount / watchlistCount 给「持仓 / 关注」切换器用，
  // 切换器已删除（见下方 Watchlist 区块），计数改由 pill 行直接计算，故移除。

  // ===== fork：分析页新增的派生数据与动作 =====
  /** 「关注」范围只含 A 股股票（ETF 与港美股都不参与本页）。 */
  const watchStocks = useMemo(() => onlyAShares(stocks), [stocks])
  /** 关注的代码集合，用于「全部」列表里显示「已关注」。 */
  const watchSymbolSet = useMemo(() => {
    const set = new Set<string>()
    for (const stock of watchStocks) {
      const raw = String(stock.symbol || '')
      set.add(raw)
      const bare = normalizeSymbol(raw)
      if (bare) set.add(bare)
    }
    return set
  }, [watchStocks])
  const findWatchedStock = useCallback(
    (row: { code: string; symbol?: string | null }) =>
      watchStocks.find(
        stock => sameListingCode(stock.symbol, row.code) || sameListingCode(stock.symbol, row.symbol),
      ),
    [watchStocks],
  )
  /** 当前范围下各板块的计数：关注范围用自选算，全部范围用后端返回的全市场数。 */
  const boardCounts = useMemo(
    () => (stockScope === 'market' ? marketCounts ?? countByBoard([]) : countByBoard(watchStocks)),
    [marketCounts, stockScope, watchStocks],
  )
  /** fork：表格里点「关注」：走和上游一样的 POST /stocks，然后刷新自选。 */
  const handleQuickAdd = useCallback(
    async (row: MarketRow) => {
      try {
        await stocksApi.create({ symbol: row.code, name: row.name, market: 'CN', asset_type: 'stock' })
        // fork：用户要求「点击关注，提示关注」，这里给明确的反馈文案
        toast(`已关注 ${row.name}`, 'success')
        load()
      } catch (e) {
        toast(e instanceof Error ? e.message : stockT('stocksPage.messages.addStockFailed'), 'error')
      }
    },
    // stockT 来自 i18n hook，随语言变化；load 是稳定的（useCallback）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  )

  /** fork：表格里点 X（已关注的标的）→ 与关注列表同一套「取消关注」确认流程。 */
  const handleQuickRemove = useCallback(
    (row: MarketRow) => {
      const found = findWatchedStock(row)
      if (found) setRemoveWatchStock(found)
    },
    [findWatchedStock],
  )

  /**
   * fork：关注范围的当前页数据（前端过滤 + 前端分页，与「全部」同样的 100 上限）。
   * 搜索词与「全部」范围共用，所以切换范围是「换数据」而不是「换界面」。
   */
  const watchFiltered = useMemo(() => {
    const q = stockQuery.trim().toLowerCase()
    return watchStocks
      .filter(s => matchesBoard(s, stockListFilter))
      .sort((a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0) || a.id - b.id)
      .filter(
        s =>
          !q ||
          String(s.symbol || '').toLowerCase().includes(q) ||
          String(s.name || '').toLowerCase().includes(q),
      )
  }, [watchStocks, stockListFilter, stockQuery])

  const watchPageItems = useMemo(
    () => watchFiltered.slice(watchScopeOffset, watchScopeOffset + STOCK_PAGE_SIZE),
    [watchFiltered, watchScopeOffset],
  )

  // 换搜索词 / 换板块时回到第一页
  useEffect(() => {
    setWatchScopeOffset(0)
  }, [stockQuery, stockListFilter, stockScope])

  /**
   * fork：表格「状态」列的技术面摘要 —— 从库里 tech_* 复原（零外网）。
   *
   * 「全部」列表以前是给当前页批量打 ``POST /api/klines/summary/batch`` 拿摘要的，
   * 那正是被数据源限流的那条路，已彻底删除。现在改为把库里日终算好的状态字符串
   * （``tech_trend`` / ``tech_macd`` … 与 ``tech_score``）还原成上游徽章吃的
   * KlineSummary —— 口径与库里一致，且不发任何请求。详见 lib/fork-kline-summary.ts。
   */
  const klineTr = useCallback(
    (key: string, options?: Record<string, unknown>) =>
      (bizT as unknown as (key: string, options?: Record<string, unknown>) => string)(
        `kline.${key}`,
        options,
      ),
    [bizT],
  )

  const summaryCacheRef = useRef(new Map<string, KlineSummary | null>())
  const rowSummary = useCallback(
    (row: MarketRow): KlineSummary | null => {
      const key = `${row.code}:${row.trade_date ?? ''}:${row.tech?.score ?? 'na'}:${row.close ?? ''}`
      const cache = summaryCacheRef.current
      if (!cache.has(key)) cache.set(key, buildSummaryFromMarketRow(row, klineTr))
      return cache.get(key) ?? null
    },
    [klineTr],
  )

  /**
   * fork：「指标」筛选组的候选动作文案 —— 与指标列那颗技术面徽章取同一个 i18n 键
   * （bizUi 的 kline.actions.*），所以筛选项的文字与徽章上的文字不可能不一致。
   * （2026-10-20 第 4 条：这一组原名「状态」，改名「指标」，否则和新增的交易日
   * 状态列混在一起分不清。）
   */
  const indicatorFilterOptions = useMemo(
    () => INDICATOR_FILTER_KEYS.map(key => ({ key, label: klineTr(`actions.${key}`) })),
    [klineTr],
  )

  /**
   * fork：一行 → 技术面动作（buy/avoid/watch），喂给表格的「状态」筛选。
   * 走的就是徽章那条路径（rowSummary → buildKlineSuggestion），所以「筛出来的」与「看到的」是同一批。
   */
  const marketRowActionOf = useCallback(
    (row: MarketRow) => {
      const summary = rowSummary(row)
      if (!summary) return null
      return buildKlineSuggestion(summary as never, false, klineTr).action
    },
    [klineTr, rowSummary],
  )

  /**
   * fork：点表格里的代码 → 复制「代码 + 名称」（空格隔开的纯文本），
   * 名称本身点击仍然是打开详情弹窗（用户要求）。
   */
  const handleCopyRowCode = useCallback(
    (row: MarketRow) => {
      const text = `${row.code} ${row.name}`
      const write = navigator.clipboard?.writeText(text)
      if (!write) {
        toast(COPY_CODE_TEXTS_ZH.blocked, 'error')
        return
      }
      void write.then(
        () => toast(COPY_CODE_TEXTS_ZH.done(text), 'success'),
        () => toast(COPY_CODE_TEXTS_ZH.failed, 'error'),
      )
    },
    [toast],
  )

  /** fork：表格里点 K 线图标 —— 弹窗直接用库里复原的摘要，不触发外网取数。 */
  const openMarketKline = useCallback(
    (row: MarketRow) => {
      setKlineDialogSymbol(row.code)
      setKlineDialogMarket('CN')
      setKlineDialogName(row.name)
      setKlineDialogHasPosition(false)
      setKlineDialogInitialSummary(rowSummary(row) as KlineSummary | null)
      setKlineDialogOpen(true)
    },
    [rowSummary],
  )

  /** 指标列：AI 建议徽章（建议池里有才有）+ 技术面徽章（库里 tech_*，零外网）。
   *
   *  ``hideSourceLine``：表格里「来源」是**独立一列**，徽章再自带一行来源就是同一份
   *  信息出现两次（用户截图反馈的 bug）。弹窗里的来源不变。
   *
   *  2026-10-20 第 4 条：这一列原名「状态」，改名「指标」；「状态」这个词留给下面
   *  那颗交易日状态标签（停牌 / 正常 / ST）。 */
  const renderMarketIndicator = (row: MarketRow) => {
    const { suggestion } = getSuggestionForStock(row.code, 'CN')
    const kline = rowSummary(row)
    if (!suggestion && !kline) {
      return (
        <span
          className="text-[11px] text-muted-foreground/70"
          title={FORK_ANALYSIS_TEXTS_ZH.indicatorEmptyHint}
        >
          {FORK_ANALYSIS_TEXTS_ZH.indicatorEmpty}
        </span>
      )
    }
    return (
      <SuggestionBadge
        suggestion={suggestion}
        stockName={row.name}
        stockSymbol={row.code}
        kline={kline}
        market="CN"
        hasPosition={false}
        hideSourceLine
      />
    )
  }

  /**
   * 状态列：交易日状态（2026-10-20 第 5 条新增，紧跟在「总市值」后面，固定列宽）。
   *
   * 数据来自行情库的 ``stock_status_daily``（短标签由后端 ``map_row`` 给：
   * 正常 / 停牌 / ST / *ST / 退市 / 新股），不是技术面结论 —— 技术面结论在「指标」列。
   * 「正常」不上色（一屏全是彩色标签反而看不出异常），异常类才给颜色：
   * 停牌琥珀、风险警示红、退市红、新股蓝。
   */
  const renderMarketTradeStatus = (row: MarketRow) => {
    const code = String(row.status_code || 'NORMAL').toUpperCase()
    const label = row.status_label || TRADE_STATUS_TEXTS_ZH.normal
    const tone =
      code === 'SUSPENDED'
        ? 'text-amber-600 bg-amber-500/10'
        : code === 'ST' || code === 'STAR_ST' || code === 'DELISTING' || code === 'DELIST_PENDING'
          ? 'text-destructive bg-destructive/10'
          : code === 'NEW_LISTING'
            ? 'text-primary bg-primary/10'
            : 'text-muted-foreground bg-accent/40'
    return (
      <span
        data-fork-trade-status={code}
        title={row.status_group ? TRADE_STATUS_TEXTS_ZH.group(label, row.status_group) : label}
        className={`inline-flex items-center whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium ${tone}`}
      >
        {label}
      </span>
    )
  }

  /**
   * Agent 配置入口（本轮第 2 条）：原来那一整列「Agent 状态」删掉，收敛成操作列里
   * 一颗「A」图标，点它弹上游那个「配置监控 Agent」弹窗（本页早已有一份完整实现）。
   *
   * 未关注的行也能点：agent 绑定挂在自选行上（PUT /stocks/{id}/agents），所以这里先
   * 把股票加进自选（与点「+」同一个 POST /stocks），再打开弹窗 —— 否则弹窗能打开、
   * 存不进任何配置。加入自选会 toast 明说，不做静默变更。
   */
  const openMarketAgent = useCallback(
    async (row: MarketRow) => {
      const found = findWatchedStock(row)
      if (found) {
        setAgentDialogStock(found)
        return
      }
      try {
        const created = await stocksApi.create({
          symbol: row.code,
          name: row.name,
          market: 'CN',
          asset_type: 'stock',
        })
        toast(`已关注 ${row.name}（配置 Agent 需先加入自选）`, 'success')
        load()
        setAgentDialogStock({ ...created, agents: created.agents ?? [] })
      } catch (e) {
        toast(e instanceof Error ? e.message : stockT('stocksPage.messages.addStockFailed'), 'error')
      }
    },
    // stockT 来自 i18n hook，随语言变化；load 是稳定的（useCallback）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [findWatchedStock, load],
  )

  /** 建议时间（本地时区，只到分）—— 与上游 suggestion-badge 里的格式一致。 */
  const suggestionTimeText = (isoTime?: string | null): string => {
    if (!isoTime) return ''
    const date = new Date(isoTime)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  }

  /**
   * 来源列：
   *   有 AI 建议 → 与徽章同一套口径「来源：盘中监测 · 19:08（已过期）」
   *   没有       → 「技术指标 · 10-14」（库里的日终口径 + 交易日）
   * 交易所收盘后这一列是判断「这份数据是哪天的」的唯一依据 —— 现价不是实时价。
   */
  const renderMarketSource = (row: MarketRow) => {
    const { suggestion } = getSuggestionForStock(row.code, 'CN')
    if (suggestion?.agent_label || suggestion?.created_at) {
      const time = suggestionTimeText(suggestion.created_at)
      return (
        <span>
          {suggestion.agent_label || 'AI'}
          {time && ` · ${time}`}
          {suggestion.is_expired && (
            <span className="ml-1 text-amber-600">{MARKET_ROW_TEXTS_ZH.expired}</span>
          )}
        </span>
      )
    }
    const date = row.trade_date ? row.trade_date.slice(5) : ''
    return (
      <span title={`${row.source || ''} ${row.trade_date || ''}`.trim()}>
        {MARKET_ROW_TEXTS_ZH.technical}
        {date && ` · ${date}`}
      </span>
    )
  }

  /** 操作列：原来那张卡片右下角的整套按钮，一项不少。 */
  const renderMarketActions = (row: MarketRow, state: MarketRowState) => {
    const found = findWatchedStock(row)
    const alert = getPriceAlertSummary(row.code, 'CN')
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => openMarketKline(row)}
          title={cardTexts.klineIndicator}
        >
          <BarChart3 className="w-3.5 h-3.5" />
        </Button>
        <StockPriceAlertPanel
          mode="icon"
          stockId={found?.id}
          symbol={row.code}
          market="CN"
          stockName={row.name}
          initialTotal={alert.total}
          initialEnabled={alert.enabled}
          onChanged={loadPriceAlertSummaries}
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => openNewsDialog(row.name)}
          title={cardTexts.relatedNews}
        >
          <Newspaper className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 hover:text-primary"
          title={cardTexts.deepAnalysis}
          aria-label={cardTexts.deepAnalysis}
          onClick={() => openDeepAnalysis(found?.id ?? 0, row.code, row.name, 'CN')}
        >
          <Brain className="w-3.5 h-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => openStockDetail(row.code, 'CN', row.name, false)}
          title={cardTexts.detail}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </Button>
        {/*
          Agent 配置（本轮第 2 条）：原「Agent 状态」列整列删掉，改成这一颗「A」图标。
          亮/暗按是否已配置：已配置 → text-primary（与表里其他可点图标同色），
          未配置 → text-muted-foreground/40（暗一档，但仍可点）。执行中额外变琥珀 + 呼吸，
          补回删列时丢掉的「正在跑哪个 Agent」这一条信息。悬停提示：未配置 Agent /
          N 个 Agent / 执行中 · 名字。
        */}
        {(() => {
          const runningAgent = found ? runningAgents[found.id] : null
          const assigned = found?.agents?.length ?? 0
          const tip = runningAgent
            ? FORK_ANALYSIS_TEXTS_ZH.agentRunning(
                agentName(runningAgent, agents.find(a => a.name === runningAgent)?.display_name),
              )
            : assigned > 0
              ? stockT('stocksPage.messages.agentCount', { count: assigned })
              : stockT('stocksPage.messages.notConfigured')
          return (
            <Button
              variant="ghost"
              size="icon"
              className={`h-7 w-7 ${
                runningAgent
                  ? 'text-amber-600'
                  : assigned > 0
                    ? 'text-primary'
                    : 'text-muted-foreground/40 hover:text-foreground'
              }`}
              onClick={() => void openMarketAgent(row)}
              title={tip}
              aria-label={tip}
              data-fork-market-agent={assigned}
            >
              <AgentGlyph className={runningAgent ? 'animate-pulse' : ''} />
            </Button>
          )
        })()}
        {state.followed ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hover:text-destructive"
            onClick={() => state.onUnfollow()}
            title={cardTexts.unfollow}
            aria-label={cardTexts.unfollow}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 hover:text-primary"
            onClick={() => state.onFollow()}
            title={cardTexts.follow}
            aria-label={cardTexts.follow}
            disabled={state.busy}
          >
            {state.busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Plus className="w-3.5 h-3.5" />
            )}
          </Button>
        )}
      </>
    )
  }

  /** fork：两个列表共用同一张卡片的文案（StockRichCard 不依赖 i18n，文案由这里注入） */
  const cardTexts: StockRichCardTexts = {
    etf: stockT('stocksPage.assetTypes.etf'),
    notConfigured: stockT('stocksPage.messages.notConfigured'),
    noAnalysis: stockT('stocksPage.messages.noAnalysis'),
    klineIndicator: stockT('stocksPage.messages.klineIndicator'),
    relatedNews: stockT('stocksPage.messages.relatedNews'),
    deepAnalysis: stockT('stocksPage.messages.deepAnalysis'),
    detail: stockT('stocksPage.messages.detail'),
    follow: '关注',
    unfollow: '取消关注',
    agentCount: (count: number) => stockT('stocksPage.messages.agentCount', { count }),
  }

  /**
   * fork：表格里点「关注」的文案与状态由 StockMarketTable 通过 renderActions 注入，
   * 原来那张「全部」卡片（renderCatalogCard）已随表格化删除。
   */

  const toggleAccountExpanded = (id: number) => {
    setExpandedAccounts(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // fork：不再用持仓页的整页骨架挡住分析表。行情表自己有加载态，
  // 而且要和自选列表并行取数，不能等 /stocks 与组合汇总回来才开始。

  /**
   * fork：工具条**第一行**（2026-10-20 第 1 条要求拆成两行）。
   *
   *   第一行左：条件选股 → 已保存条件下拉 → 编辑
   *   第一行右：数据时间 / 代码版本 / 提交时间（``tableToolbarMeta``）
   *   第二行：刷新 → 添加股票 → 搜索框 → 五组筛选 → 页码
   *
   * 这样选股那三个控件不会再被「刷新 / 添加股票 / 搜索 / 筛选」挤得换行位置乱跳。
   */
  const tableToolbarActions = (
    <div className="flex items-center gap-1.5">
      {/* fork：条件选股入口（需求规格 §5.1），排在工具条最左边。
          结果生效时显示激活态 —— 否则用户看不出「现在看到的不是全市场」。 */}
      <Button
        data-tour="screen-stocks"
        size="sm"
        variant="secondary"
        className={`h-7 px-2 text-[12px] ${
          screenResult ? 'border border-primary/60 bg-primary/10 text-primary' : ''
        }`}
        aria-pressed={Boolean(screenResult)}
        onClick={() => openScreenDialog()}
      >
        <Filter className="h-3.5 w-3.5" />
        {screenResult ? SCREEN_TEXTS_ZH.buttonActive : SCREEN_TEXTS_ZH.button}
      </Button>
      {/* 已保存条件下拉 + 编辑：一个条件都没有时两个控件都不可操作 */}
      <ScreenPresetMenu
        presets={presets}
        value={presetName}
        onChange={setPresetName}
        onEdit={name => openScreenDialog(name)}
      />
    </div>
  )

  /** 第一行右侧：数据同步时间 / 代码版本 / 代码提交时间（原先是筛选行的 trailing）。 */
  const tableToolbarMeta = <BuildMetaStrip build={buildMeta} />

  /** 第二行左端：「刷新」「添加股票」+ 50px + 搜索框（原来和条件选股挤在同一行）。 */
  const tableToolbarLeading = (
    <div className="flex items-center" style={{ columnGap: TOOLBAR_GAP_PX }}>
      <div className="flex items-center gap-1.5">
        <Button
          data-tour="refresh-quotes"
          variant="secondary"
          size="sm"
          className="h-7 px-2 text-[12px]"
          onClick={handleRefresh}
          disabled={loading || tableLoading || tour?.busy}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${tableLoading ? 'animate-spin' : ''}`} />
          {stockT('stocksPage.messages.refreshed')}
        </Button>
        <Button
          data-tour="add-stock"
          size="sm"
          className="h-7 px-2 text-[12px]"
          onClick={() => setShowBatchAdd(true)}
        >
          <Plus className="h-3.5 w-3.5" /> {FORK_ANALYSIS_TEXTS_ZH.addStock}
        </Button>
      </div>
      <div className="w-[260px] shrink-0">
        <StockSearchBox value={stockQuery} onChange={setStockQuery} />
      </div>
    </div>
  )

  return (
    <div className={FORK_PAGE_WIDTH_CLASS}>
      <FirstAnalysis />
      {/* fork：整块页头已删除（标题、A股/港股/美股 市场状态、自动刷新开关与时间戳）。
          「刷新」「添加股票」两个按钮移到了表格上方那条工具条上，位置在搜索框前面。 */}

      {/* Portfolio Total Summary */}
      {/* fork：组合汇总（总市值/盈亏/可用资金/仓位）属于已移除的持仓视图，
          viewTab 固定为 watchlist，所以下面整块永不渲染（骨架屏也一样）。 */}
      {viewTab === 'positions' && (portfolioLoading && !portfolio ? (
        // 首次加载时显示骨架屏
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="card p-4">
              <div className="flex items-center gap-2 mb-2">
                <Skeleton className="h-4 w-4 rounded" />
                <Skeleton className="h-3 w-12" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
          ))}
        </div>
      ) : portfolio ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <TrendingUp className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.totalMarketValue')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {portfolioTotalsReady ? formatMoney(portfolio.total.total_market_value) : '--'}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              {portfolio.total.total_pnl >= 0 ? (
                <ArrowUpRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? portfolio.total.total_pnl : null)}`} />
              ) : (
                <ArrowDownRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? portfolio.total.total_pnl : null)}`} />
              )}
              <span className="text-[12px]">{stockT('stocksPage.messages.totalPnl')}</span>
            </div>
            <div className={`text-[20px] font-bold font-mono ${marketSignTextClass(portfolioTotalsReady ? portfolio.total.total_pnl : null)}`}>
              {portfolioTotalsReady ? `${portfolio.total.total_pnl >= 0 ? '+' : ''}${formatMoney(portfolio.total.total_pnl)}` : '--'}
              {portfolioTotalsReady && <span className="block text-[13px] md:inline md:ml-1.5">
                ({portfolio.total.total_pnl_pct >= 0 ? '+' : ''}{portfolio.total.total_pnl_pct.toFixed(2)}%)
              </span>}
            </div>
          </div>

          {(() => {
            const dayPnl = portfolio.total.total_daily_pnl
            const totalMv = portfolio.total.total_market_value
            const prevMv = totalMv - dayPnl
            const pct = prevMv > 0 ? (dayPnl / prevMv * 100) : 0
            const isUp = dayPnl >= 0
            return (
              <div className="card p-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  {isUp ? (
                    <ArrowUpRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? dayPnl : null)}`} />
                  ) : (
                    <ArrowDownRight className={`w-4 h-4 ${marketSignTextClass(portfolioTotalsReady ? dayPnl : null)}`} />
                  )}
                  <span className="text-[12px]">{stockT('stocksPage.messages.todayPnl')}</span>
                </div>
                <div className={`text-[20px] font-bold font-mono ${marketSignTextClass(portfolioTotalsReady ? dayPnl : null)}`}>
                  {portfolioTotalsReady ? `${isUp ? '+' : ''}${formatMoney(dayPnl)}` : '--'}
                  {portfolioTotalsReady && <span className="block text-[13px] md:inline md:ml-1.5">({pct >= 0 ? '+' : ''}{pct.toFixed(2)}%)</span>}
                </div>
              </div>
            )
          })()}

          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Wallet className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.availableFundsShort')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {formatMoney(portfolio.total.available_funds)}
            </div>
          </div>
          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <PiggyBank className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.totalAssets')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {portfolioTotalsReady ? formatMoney(portfolio.total.total_assets) : '--'}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center gap-2 text-muted-foreground mb-1">
              <Bell className="w-4 h-4" />
              <span className="text-[12px]">{stockT('stocksPage.messages.positionRatio')}</span>
            </div>
            <div className="text-[20px] font-bold text-foreground font-mono">
              {positionRatio ? `${positionRatio.pct.toFixed(1)}%` : '--'}
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground line-clamp-1">
              {positionRatio ? stockT('stocksPage.messages.positionValueSummary', { value: formatMoney(positionRatio.mv), assets: formatMoney(positionRatio.assets) }) : stockT('stocksPage.messages.empty')}
            </div>
          </div>
        </div>
      ) : null)}

      {/* fork：上游「持仓 / 关注」切换器已删除。
          本页只有「关注列表 + A 股全市场浏览」，范围切换放在列表自己的 pill 行里；
          「持仓」相关区块（账户、组合汇总）因此永不渲染，代码保留以降低 merge 成本。 */}

      {/* fork：批量添加股票（替代下方上游单只弹窗） */}
      <BatchAddStocksDialog
        open={showBatchAdd}
        onOpenChange={setShowBatchAdd}
        existingSymbols={watchSymbolSet}
        onAdded={load}
      />

      {/* fork：条件选股弹窗。「修改条件」时把上次的请求原样带回（不持久化，
          只活在页面内存里 —— 需求规格 §14-Q9）；从「已保存条件 → 编辑」打开时
          带回那个条件存下来的完整请求，并在底部多一个「删除」按钮。 */}
      <ScreenStocksDialog
        open={screenOpen}
        onOpenChange={setScreenOpen}
        initialRequest={screenInitial}
        asof={marketAsof}
        presetName={screenPresetName}
        onDeletePreset={name => void handleDeletePreset(name)}
        onSavePreset={(request, name) => void handleSaveFromDialog(request, name)}
        onResult={(response, request) => setScreenResult({ request, response })}
      />

      {/* fork：保存条件（名字 = 服务器上的文件名，最长 10 个字符） */}
      <SaveConditionDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        defaultName={presetName ?? ''}
        onSave={handleSavePreset}
      />

      {/* 上游「添加股票 / ETF」弹窗：fork 版已不可达（没有任何按钮会
          setShowStockForm(true)）。保留 JSX 是为了让相关的 state / handler
          仍是「被引用」状态，否则 noUnusedLocals 会报一批编译错误。 */}
      {/* Add Stock Dialog */}
      <Dialog open={showStockForm} onOpenChange={(open) => { setShowStockForm(open); if (!open) { setSearchQuery(''); setSearchMarket('') } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{stockT('stocksPage.messages.addToWatchlistTitle')}</DialogTitle>
            <DialogDescription>{stockT('stocksPage.messages.addToWatchlistDescription')}</DialogDescription>
          </DialogHeader>
          <div data-tour-instructions />
          <form data-tour="stock-form" onSubmit={handleStockSubmit}>
            <div className="relative" ref={dropdownRef}>
              <div className="flex items-center gap-2 mb-2">
                <Label className="mb-0">{stockT('stocksPage.messages.searchStock')}</Label>
                <div className="flex items-center gap-1">
                  {[
                    { value: '', label: stockT('stocksPage.markets.all') },
                    { value: 'CN', label: stockT('stocksPage.markets.cn') },
                    { value: 'HK', label: stockT('stocksPage.markets.hk') },
                    { value: 'US', label: stockT('stocksPage.markets.us') },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleSearchMarketChange(opt.value)}
                      className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                        searchMarket === opt.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={refreshStockListCache}
                  disabled={refreshingStockList}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-2"
                  title={stockT('stocksPage.messages.searchRefreshHint')}
                >
                  {refreshingStockList ? (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="w-3 h-3 animate-spin" /> {stockT('stocksPage.messages.refreshing')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <RefreshCw className="w-3 h-3" /> {stockT('stocksPage.messages.refreshList')}
                    </span>
                  )}
                </button>
              </div>
              <div className="relative">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                <Input
                  value={searchQuery}
                  onChange={e => handleSearchInput(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
                  placeholder={stockT('stocksPage.messages.searchPlaceholder', { example: searchMarket === 'HK' ? '00700 / 02800' : searchMarket === 'US' ? 'AAPL / SPY' : '600519 / 510300' })}
                  className="pl-10"
                  autoComplete="off"
                />
                {searching && <span className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />}
              </div>
              {showDropdown && (
                <div className="relative w-full mt-2 max-h-64 overflow-auto overscroll-contain scrollbar card shadow-lg">
                  {searchResults.map(item => (
                    <button
                      key={`${item.market}-${item.symbol}`}
                      type="button"
                      onClick={() => selectStock(item)}
                      className="w-full flex items-center gap-3 px-4 py-3 text-[13px] hover:bg-accent/50 text-left transition-colors"
                    >
                      <span className="font-mono text-muted-foreground text-[12px] w-14">{item.symbol}</span>
                      <span className="flex-1 font-medium text-foreground">{item.name}</span>
                      {item.asset_type === 'etf' && <Badge variant="secondary">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                      <Badge variant="secondary">{marketLabel(item.market)}</Badge>
                    </button>
                  ))}
                </div>
              )}
              {stockForm.symbol && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Badge><span className="font-mono">{stockForm.symbol}</span> {stockForm.name}</Badge>
                  <Badge variant="secondary">{marketLabel(stockForm.market)}</Badge>
                  <Select value={stockForm.asset_type} onValueChange={value => setStockForm({ ...stockForm, asset_type: value as 'stock' | 'etf' })}>
                    <SelectTrigger aria-label={stockT('stocksPage.assetTypes.label')} className="w-28 h-8"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stock">{stockT('stocksPage.assetTypes.stock')}</SelectItem>
                      <SelectItem value="etf">{stockT('stocksPage.assetTypes.etf')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <div className="mt-6 flex items-center gap-3 justify-end">
              <Button type="button" variant="ghost" onClick={() => { setShowStockForm(false); setSearchQuery('') }}>{stockT('stocksPage.messages.cancel')}</Button>
              <Button type="submit" disabled={!stockForm.symbol}>{stockT('stocksPage.messages.confirmAdd')}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Accounts & Positions */}
      {viewTab === 'positions' && (
        portfolio && portfolio.accounts.length === 0 ? (
          <div className="card flex flex-col items-center justify-center py-20">
            <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
              <Building2 className="w-6 h-6 text-primary" />
            </div>
            <p className="text-[15px] font-semibold text-foreground">{stockT('stocksPage.messages.noAccount')}</p>
            <p className="text-[13px] text-muted-foreground mt-1.5">{stockT('stocksPage.messages.createFirstAccount')}</p>
          </div>
        ) : (
          <div className="space-y-4">
            {portfolio?.accounts.map(account => (
              <div key={account.id} className="card overflow-hidden">
              {/* Account Header */}
              <div
                className="flex flex-col md:flex-row md:items-center justify-between p-3 md:p-4 cursor-pointer hover:bg-accent/30 transition-colors gap-2"
                onClick={() => toggleAccountExpanded(account.id)}
              >
                <div className="flex items-center gap-2 md:gap-3">
                  {expandedAccounts.has(account.id) ? (
                    <ChevronDown className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  )}
                  <Building2 className="w-4 h-4 text-primary" />
                  <span className="text-[14px] md:text-[15px] font-semibold text-foreground">{account.name}</span>
                  <span className="text-[11px] md:text-[12px] text-muted-foreground">
                    {stockT('stocksPage.messages.positionCount', { count: account.positions.length })}
                  </span>
                </div>
                <div className="flex items-center justify-between md:justify-end gap-2 md:gap-6 pl-6 md:pl-0">
                  <div className="flex items-center gap-2.5 md:gap-6 min-w-0">
                    <div className="text-left md:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.marketValue')}</div>
                      <div className="text-[12px] md:text-[13px] font-mono font-medium whitespace-nowrap">{unpricedAccountIds.has(account.id) ? '--' : formatMoney(account.total_market_value)}</div>
                    </div>
                    <div className="text-left md:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.pnl')}</div>
                      <div className={`text-[12px] md:text-[13px] font-mono font-medium whitespace-nowrap ${marketSignTextClass(unpricedAccountIds.has(account.id) ? null : account.total_pnl)}`}>
                        {unpricedAccountIds.has(account.id) ? '--' : `${account.total_pnl >= 0 ? '+' : ''}${formatMoney(account.total_pnl)}`}
                        {!unpricedAccountIds.has(account.id) && <span className="text-[10px] md:text-[11px] ml-1 hidden md:inline">({account.total_pnl_pct >= 0 ? '+' : ''}{account.total_pnl_pct.toFixed(2)}%)</span>}
                      </div>
                    </div>
                    <div className="text-left md:text-right">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.today')}</div>
                      <div className={`text-[12px] md:text-[13px] font-mono font-medium whitespace-nowrap ${marketSignTextClass(unpricedAccountIds.has(account.id) ? null : account.total_daily_pnl)}`}>
                        {unpricedAccountIds.has(account.id) ? '--' : `${account.total_daily_pnl >= 0 ? '+' : ''}${formatMoney(account.total_daily_pnl)}`}
                      </div>
                    </div>
                    <div className="text-left md:text-right hidden sm:block">
                      <div className="text-[10px] md:text-[11px] text-muted-foreground">{stockT('stocksPage.messages.availableFundsShort')}</div>
                      <div className="text-[12px] md:text-[13px] font-mono whitespace-nowrap">{formatMoney(account.available_funds)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-0 md:gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8" onClick={() => openPositionDialog(account.id)} aria-label={stockT('stocksPage.messages.addPosition')}>
                      <Plus className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8" aria-label={stockT('stocksPage.messages.editAccount')} onClick={() => openAccountDialog(accounts.find(a => a.id === account.id))}>
                      <Pencil className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 md:h-8 md:w-8 hover:text-destructive" onClick={() => handleDeleteAccount(account.id)}>
                      <Trash2 className="w-3 md:w-3.5 h-3 md:h-3.5" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Positions */}
              {expandedAccounts.has(account.id) && (
                <div className="border-t border-border/30">
                  {account.positions.length === 0 ? (
                    <p className="text-[13px] text-muted-foreground text-center py-8">{stockT('stocksPage.messages.noPositions')}</p>
                  ) : (
                    <>
                      {/* Desktop Table */}
                      <div className="hidden md:block overflow-x-auto scrollbar">
                        <table className="w-full">
                          <thead>
                            <tr className="border-b border-border/30 bg-accent/20">
                              <th className="text-left px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.stock')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.currentPrice')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.change')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.cost')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.holding')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.marketValue')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.pnl')}</th>
                              <th className="text-right px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.today')}</th>
                              <th className="text-center px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.style')}</th>
                              <th className="text-left px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.agent')}</th>
                              <th className="text-center px-4 py-2 text-[11px] font-semibold text-muted-foreground">{stockT('stocksPage.messages.actions')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {account.positions.map((pos, i) => {
                              const stock = stocks.find(s => s.id === pos.stock_id)
                              const badge = marketBadge(pos.market)
                              const isForeign = pos.market === 'HK' || pos.market === 'US'
                              const changeColor = marketSignTextClass(pos.change_pct)
                              const pnlColor = marketSignTextClass(pos.pnl)
                              return (
                                <tr
                                  key={pos.id}
                                  draggable
                                  onDragStart={(e) => {
                                    positionDragSnapshotRef.current = portfolioRaw ? JSON.parse(JSON.stringify(portfolioRaw)) : null
                                    setDraggingPositionId(pos.id)
                                    setDraggingPositionAccountId(account.id)
                                    e.dataTransfer.effectAllowed = 'move'
                                  }}
                                  onDragOver={(e) => {
                                    e.preventDefault()
                                    e.dataTransfer.dropEffect = 'move'
                                    if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                      previewPositionReorder(account.id, draggingPositionId, pos.id)
                                    }
                                  }}
                                  onDrop={(e) => {
                                    e.preventDefault()
                                    if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                      commitPositionReorder(account.id)
                                    }
                                    setDraggingPositionId(null)
                                    setDraggingPositionAccountId(null)
                                    positionDragSnapshotRef.current = null
                                  }}
                                  onDragEnd={() => {
                                    setDraggingPositionId(null)
                                    setDraggingPositionAccountId(null)
                                    positionDragSnapshotRef.current = null
                                  }}
                                  className={`group hover:bg-accent/30 transition-colors ${i > 0 ? 'border-t border-border/20' : ''} ${draggingPositionId === pos.id ? 'opacity-60' : ''}`}
                                >
                                  <td className="px-4 py-2.5">
                                    <span className={`text-[9px] px-1 py-0.5 rounded mr-1.5 ${badge.style}`}>{badge.label}</span>
                                    <span className="font-mono text-[12px] font-semibold text-foreground">
                                      {pos.symbol}
                                    </span>
                                    <button
                                      className="ml-1.5 text-[12px] text-muted-foreground hover:text-primary"
                                      onClick={() => openStockDetail(pos.symbol, pos.market, pos.name, true)}
                                    >
                                      {pos.name}
                                      {pos.asset_type === 'etf' && <Badge variant="secondary" className="ml-1">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                                    </button>
                                    {(() => {
                                      const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market)
                                      return (suggestion || kline) ? (
                                        <span className="ml-2">
                                          <SuggestionBadge
                                            suggestion={suggestion}
                                            stockName={pos.name}
                                            stockSymbol={pos.symbol}
                                            kline={kline}
                                            market={pos.market}
                                            hasPosition={true}
                                          />
                                        </span>
                                      ) : null
                                    })()}
                                  </td>
                                  <td title={quoteHint(pos)} className={`px-4 py-2.5 text-right font-mono text-[12px] ${changeColor}`}>
                                    {pos.current_price != null ? <span>{formatQuotePrice(pos.current_price, pos.asset_type, pos.market)}{isForeign ? (pos.market === 'HK' ? ' HKD' : ' USD') : ''}</span> : '—'}
                                  </td>
                                  <td title={quoteHint(pos)} className={`px-4 py-2.5 text-right font-mono text-[12px] ${changeColor}`}>
                                    {pos.change_pct != null ? `${pos.change_pct >= 0 ? '+' : ''}${pos.change_pct.toFixed(2)}%` : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{formatPrice(pos.cost_price)}</td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">{pos.quantity}</td>
                                  <td className="px-4 py-2.5 text-right font-mono text-[12px] text-muted-foreground">
                                    {pos.market_value != null ? (
                                      <div className="flex flex-col items-end">
                                        {isForeign ? (
                                          <>
                                            <span>{formatMoney(pos.market_value)} {pos.market === 'HK' ? 'HKD' : 'USD'}</span>
                                            {pos.market_value_cny && <span className="text-[10px] text-muted-foreground/60">≈{formatMoney(pos.market_value_cny)}</span>}
                                          </>
                                        ) : <span>{formatMoney(pos.market_value)}</span>}
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${pnlColor}`}>
                                    {pos.pnl != null ? (
                                      <div className="flex flex-col items-end">
                                        <span>{pos.pnl >= 0 ? '+' : ''}{formatMoney(pos.pnl)}</span>
                                        <span className="text-[10px] opacity-70">{pos.pnl_pct != null ? `${pos.pnl_pct >= 0 ? '+' : ''}${pos.pnl_pct.toFixed(2)}%` : ''}{isForeign && ' CNY'}</span>
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className={`px-4 py-2.5 text-right font-mono text-[12px] ${marketSignTextClass(pos.daily_pnl)}`}>
                                    {pos.daily_pnl != null ? (
                                      <div className="flex flex-col items-end">
                                        <span>{pos.daily_pnl >= 0 ? '+' : ''}{formatMoney(pos.daily_pnl)}</span>
                                        <span className="text-[10px] opacity-70">{pos.daily_pnl_pct != null ? `${pos.daily_pnl_pct >= 0 ? '+' : ''}${pos.daily_pnl_pct.toFixed(2)}%` : ''}</span>
                                      </div>
                                    ) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    {pos.trading_style ? (
                                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${pos.trading_style === 'short' ? 'bg-rose-500/10 text-rose-600' : pos.trading_style === 'long' ? 'bg-blue-500/10 text-blue-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                        {pos.trading_style === 'short' ? stockT('stocksPage.messages.shortStyle') : pos.trading_style === 'long' ? stockT('stocksPage.messages.longStyle') : stockT('stocksPage.messages.swingStyle')}
                                      </span>
                                    ) : (
                                      <span className="text-[10px] text-muted-foreground/50">-</span>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {stock && (
                                      <button onClick={() => setAgentDialogStock(stock)} className="flex items-center gap-1.5 hover:opacity-70 transition-opacity">
                                        {stock.agents && stock.agents.length > 0 ? (
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            {stock.agents.map(sa => {
                                              const agent = agents.find(a => a.name === sa.agent_name)
                                              const isRunning = runningAgents[stock.id] === sa.agent_name
                                              return (
                                                <span key={sa.agent_name} className="inline-flex items-center gap-1">
                                                  <Badge variant="default" className="text-[10px]">{agentName(sa.agent_name, sa.display_name || agent?.display_name)}</Badge>
                                                  {isRunning && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                                      <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                                      {stockT('stocksPage.messages.executing')}
                                                    </span>
                                                  )}
                                                </span>
                                              )
                                            })}
                                          </div>
                                        ) : (
                                          <span className="text-[11px] text-muted-foreground/50 flex items-center gap-1"><Bot className="w-3 h-3" /> {stockT('stocksPage.messages.notConfigured')}</span>
                                        )}
                                      </button>
                                    )}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <div className="flex items-center justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                      {(() => { const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market); return (!suggestion && !kline) ? (
                                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(pos.symbol, pos.market, pos.name, true)} title={stockT('stocksPage.messages.klineIndicator')}><BarChart3 className="w-3 h-3" /></Button>
                                      ) : null })()}
                                      <StockPriceAlertPanel
                                        mode="icon"
                                        stockId={pos.stock_id}
                                        symbol={pos.symbol}
                                        market={pos.market}
                                        stockName={pos.name}
                                        initialTotal={getPriceAlertSummary(pos.symbol, pos.market).total}
                                        initialEnabled={getPriceAlertSummary(pos.symbol, pos.market).enabled}
                                        onChanged={loadPriceAlertSummaries}
                                      />
                                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openNewsDialog(pos.name)} title={stockT('stocksPage.messages.relatedNews')}><Newspaper className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-primary" title={stockT('stocksPage.messages.deepAnalysis')} onClick={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)}><Brain className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={stockT('stocksPage.messages.editPosition')} onClick={() => openPositionDialog(account.id, pos)}><Pencil className="w-3 h-3" /></Button>
                                      <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDeletePosition(pos.id)}><Trash2 className="w-3 h-3" /></Button>
                                    </div>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Mobile Cards */}
                      <div className="md:hidden divide-y divide-border/30">
                        {account.positions.map(pos => {
                          const stock = stocks.find(s => s.id === pos.stock_id)
                          const badge = marketBadge(pos.market)
                          const changeColor = marketSignTextClass(pos.change_pct)
                          const pnlColor = marketSignTextClass(pos.pnl)
                          return (
                            <div
                              key={pos.id}
                              draggable
                              onDragStart={(e) => {
                                positionDragSnapshotRef.current = portfolioRaw ? JSON.parse(JSON.stringify(portfolioRaw)) : null
                                setDraggingPositionId(pos.id)
                                setDraggingPositionAccountId(account.id)
                                e.dataTransfer.effectAllowed = 'move'
                              }}
                              onDragOver={(e) => {
                                e.preventDefault()
                                e.dataTransfer.dropEffect = 'move'
                                if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                  previewPositionReorder(account.id, draggingPositionId, pos.id)
                                }
                              }}
                              onDrop={(e) => {
                                e.preventDefault()
                                if (draggingPositionId != null && draggingPositionAccountId === account.id) {
                                  commitPositionReorder(account.id)
                                }
                                setDraggingPositionId(null)
                                setDraggingPositionAccountId(null)
                                positionDragSnapshotRef.current = null
                              }}
                              onDragEnd={() => {
                                setDraggingPositionId(null)
                                setDraggingPositionAccountId(null)
                                positionDragSnapshotRef.current = null
                              }}
                              className={`p-3 hover:bg-accent/30 transition-colors ${draggingPositionId === pos.id ? 'opacity-60' : ''}`}
                            >
                              {/* Row 1: Stock info + Current price */}
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded ${badge.style}`}>{badge.label}</span>
                                  <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">
                                    {pos.symbol}
                                  </span>
                                  <button
                                    className="text-[12px] text-muted-foreground hover:text-primary truncate"
                                    onClick={() => openStockDetail(pos.symbol, pos.market, pos.name, true)}
                                  >
                                    {pos.name}
                                    {pos.asset_type === 'etf' && <Badge variant="secondary" className="ml-1">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                                  </button>
                                  {pos.trading_style && (
                                    <span className={`shrink-0 text-[9px] px-1 py-0.5 rounded ${pos.trading_style === 'short' ? 'bg-rose-500/10 text-rose-600' : pos.trading_style === 'long' ? 'bg-blue-500/10 text-blue-600' : 'bg-amber-500/10 text-amber-600'}`}>
                                      {pos.trading_style === 'short' ? stockT('stocksPage.messages.shortStyleLabel') : pos.trading_style === 'long' ? stockT('stocksPage.messages.longStyleLabel') : stockT('stocksPage.messages.swingStyleLabel')}
                                    </span>
                                  )}
                                </div>
                                <div title={quoteHint(pos)} className={`font-mono text-[13px] font-medium whitespace-nowrap shrink-0 ${changeColor}`}>
                                  {pos.current_price != null ? formatQuotePrice(pos.current_price, pos.asset_type, pos.market) : '—'}
                                  <span className="text-[11px] ml-1">{pos.change_pct != null ? `${pos.change_pct >= 0 ? '+' : ''}${pos.change_pct.toFixed(2)}%` : '—'}</span>
                                </div>
                              </div>
                              {/* Row 2 (Suggestion badge, dedicated row to avoid wrapping mess) */}
                              {(() => {
                                const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market)
                                return (suggestion || kline) ? (
                                  <div className="mb-2">
                                    <SuggestionBadge
                                      suggestion={suggestion}
                                      stockName={pos.name}
                                      stockSymbol={pos.symbol}
                                      kline={kline}
                                      market={pos.market}
                                      hasPosition={true}
                                    />
                                  </div>
                                ) : null
                              })()}
                              {/* Row 3: Stats grid (4 cols, whitespace-nowrap to prevent "万" wrapping) */}
                              <div className="grid grid-cols-4 gap-2 text-[11px]">
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.cost')}</div>
                                  <div className="font-mono text-foreground truncate" title={String(pos.cost_price)}>{formatPrice(pos.cost_price)}</div>
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.quantity')}</div>
                                  <div className="font-mono text-foreground truncate" title={String(pos.quantity)}>{pos.quantity}</div>
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.pnl')}</div>
                                  <div className={`font-mono whitespace-nowrap ${pnlColor}`}>
                                    {pos.pnl != null ? `${pos.pnl >= 0 ? '+' : ''}${formatMoney(pos.pnl)}` : '—'}
                                  </div>
                                  {pos.pnl_pct != null && (
                                    <div className={`text-[10px] font-mono ${pnlColor} opacity-80`}>
                                      {pos.pnl_pct >= 0 ? '+' : ''}{pos.pnl_pct.toFixed(2)}%
                                    </div>
                                  )}
                                </div>
                                <div className="min-w-0">
                                  <div className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.today')}</div>
                                  <div className={`font-mono whitespace-nowrap ${marketSignTextClass(pos.daily_pnl)}`}>
                                    {pos.daily_pnl != null ? `${pos.daily_pnl >= 0 ? '+' : ''}${formatMoney(pos.daily_pnl)}` : '—'}
                                  </div>
                                </div>
                              </div>
                              {/* Row 4: Actions */}
                              <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/20">
                                <div>
                                  {stock && stock.agents && stock.agents.length > 0 ? (
                                    <button onClick={() => setAgentDialogStock(stock)} className="flex items-center gap-1">
                                      {stock.agents.slice(0, 2).map(sa => {
                                        const agent = agents.find(a => a.name === sa.agent_name)
                                        const isRunning = runningAgents[stock.id] === sa.agent_name
                                        return (
                                          <span key={sa.agent_name} className="inline-flex items-center gap-1">
                                          <Badge variant="secondary" className="text-[9px]">{agentName(sa.agent_name, sa.display_name || agent?.display_name)}</Badge>
                                            {isRunning && (
                                              <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
                                                <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                                                {stockT('stocksPage.messages.executing')}
                                              </span>
                                            )}
                                          </span>
                                        )
                                      })}
                                    </button>
                                  ) : (
                                    <button onClick={() => stock && setAgentDialogStock(stock)} className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                                      <Bot className="w-3 h-3" /> {stockT('stocksPage.messages.agent')}
                                    </button>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  {(() => { const { suggestion, kline } = getSuggestionForStock(pos.symbol, pos.market); return (!suggestion && !kline) ? (
                                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openKlineDialog(pos.symbol, pos.market, pos.name, true)} title={stockT('stocksPage.messages.klineIndicator')}><BarChart3 className="w-3 h-3" /></Button>
                                  ) : null })()}
                                  <StockPriceAlertPanel
                                    mode="icon"
                                    stockId={pos.stock_id}
                                    symbol={pos.symbol}
                                    market={pos.market}
                                    stockName={pos.name}
                                    initialTotal={getPriceAlertSummary(pos.symbol, pos.market).total}
                                    initialEnabled={getPriceAlertSummary(pos.symbol, pos.market).enabled}
                                    onChanged={loadPriceAlertSummaries}
                                  />
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openNewsDialog(pos.name)}><Newspaper className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-primary" title={stockT('stocksPage.messages.deepAnalysis')} onClick={() => openDeepAnalysis(pos.stock_id, pos.symbol, pos.name)}><Brain className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={stockT('stocksPage.messages.editPosition')} onClick={() => openPositionDialog(account.id, pos)}><Pencil className="w-3 h-3" /></Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-destructive" onClick={() => handleDeletePosition(pos.id)}><Trash2 className="w-3 h-3" /></Button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        )
      )}

      {/* Watchlist（fork：合并了「A 股全市场」范围） */}
      {viewTab === 'watchlist' && (
        <div data-tour="watchlist" className="card p-4">
          {/* fork：筛选行（板块 + 状态 + 涨跌 + 市值四组）。
              用户反馈 2026-10-20 第 2 条：整行从「表格上方独立一行」挪到**搜索框后面**，
              所以它现在通过 filtersSlot 交给表格上方的工具条渲染，这里不再单独排队。
              全部筛选都在前端做（数据是一次全量取回的），不发任何请求。 */}

          {/* fork：选股结果横幅（需求规格 §5.5）不放这里 —— 用户要求它出现在
              「条件选股」按钮那一行的**下面**，所以经由 belowToolbar 塞进表格里。
              「退出选股」只清空 sourceRows，表格的全量数据一直留着，不重新请求。 */}

          {/* fork：全部 = A 股全市场（后端 /stocks/market-table，读本机 MySQL，分页）。
              行情/市值/技术面全部来自库，**一个外网请求都不发** —— 这是
              「查外网次数太多被屏蔽」的解法。范围固定为全市场，「关注」范围已移除。 */}
          {stockScope === 'market' ? (
            <StockMarketTable
              board={stockListFilter}
              query={stockQuery}
              filters={marketFilters}
              existingSymbols={watchSymbolSet}
              onCounts={setMarketCounts}
              onAdd={handleQuickAdd}
              onRemove={handleQuickRemove}
              onCopyCode={handleCopyRowCode}
              onOpenDetail={row => openStockDetail(row.code, 'CN', row.name, false)}
              getRowAction={marketRowActionOf}
              reloadToken={marketReloadToken}
              onLoadingChange={setTableLoading}
              sourceRows={screenResult?.response.items ?? null}
              emptyTextOverride={SCREEN_TEXTS_ZH.noMatch}
              onAsof={setMarketAsof}
              toolbarActions={tableToolbarActions}
              toolbarMeta={tableToolbarMeta}
              searchSlot={tableToolbarLeading}
              filtersSlot={
                <StockFilterBar
                  board={stockListFilter}
                  onBoardChange={setStockListFilter}
                  counts={boardCounts}
                  filters={marketFilters}
                  onFiltersChange={setMarketFilters}
                  indicatorOptions={indicatorFilterOptions}
                />
              }
              belowToolbar={
                screenResult ? (
                  <ScreenResultBanner
                    response={screenResult.response}
                    request={screenResult.request}
                    savedName={screenPresetName}
                    onEdit={() => openScreenDialog()}
                    onExit={() => setScreenResult(null)}
                  />
                ) : null
              }
              renderIndicator={renderMarketIndicator}
              renderTradeStatus={renderMarketTradeStatus}
              renderSource={renderMarketSource}
              renderActions={renderMarketActions}
            />
          ) : (
            <>
              <StockListToolbar
                value={stockQuery}
                onChange={setStockQuery}
                placeholder={FORK_ANALYSIS_TEXTS_ZH.searchPlaceholder}
                status={`共 ${watchFiltered.length} 只${
                  watchFiltered.length > STOCK_PAGE_SIZE
                    ? `，当前 ${watchScopeOffset + 1}-${Math.min(watchScopeOffset + STOCK_PAGE_SIZE, watchFiltered.length)}`
                    : ''
                }`}
              />
              {watchFiltered.length === 0 ? (
                <div className="py-12 text-center">
                  {watchStocks.length === 0 ? (
                    <>
                      <div className="text-[13px] text-muted-foreground">{stockT('stocksPage.messages.noWatchlist')}</div>
                      <div className="mt-2 text-[11px] text-muted-foreground/70">{stockT('stocksPage.messages.startAddWatchlist')}</div>
                    </>
                  ) : (
                    <div className="text-[13px] text-muted-foreground">{FORK_ANALYSIS_TEXTS_ZH.noMatch}</div>
                  )}
                </div>
              ) : (
                <div className={STOCK_CARD_GRID_CLASS}>
              {watchPageItems.map((stock) => {
                const quote = getStockQuote(`${stock.market}:${stock.symbol}`)
                const { suggestion, kline } = getSuggestionForStock(stock.symbol, stock.market)
                const running = runningAgents[stock.id]
                const alert = getPriceAlertSummary(stock.symbol, stock.market)
                return (
                  /* fork：与「全部」列表渲染同一个 StockRichCard ——
                     用户两次反馈两个列表 UI 不一致，抽成一个组件后不可能再不一致 */
                  <StockRichCard
                    key={stock.id}
                    dataTourStock={stock.id}
                    cardProps={{
                      role: tour?.active && tour.step === 'stock' ? 'button' : undefined,
                      tabIndex: tour?.active && tour.step === 'stock' ? 0 : undefined,
                      onKeyDown: e => { if (tour?.active && tour.step === 'stock' && ['Enter', ' '].includes(e.key)) { e.preventDefault(); void tour.selectStock(stock.id) } },
                      draggable: stockListFilter === 'all',
                      onDragStart: (e) => {
                        if (stockListFilter !== 'all') return
                        watchDragSnapshotRef.current = stocks
                        setDraggingWatchStockId(stock.id)
                        e.dataTransfer.effectAllowed = 'move'
                      },
                      onDragOver: (e) => {
                        if (stockListFilter !== 'all') return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                        if (draggingWatchStockId != null) {
                          previewWatchlistReorder(draggingWatchStockId, stock.id)
                        }
                      },
                      onDrop: (e) => {
                        if (stockListFilter !== 'all') return
                        e.preventDefault()
                        if (draggingWatchStockId != null) commitWatchlistReorder()
                        setDraggingWatchStockId(null)
                        watchDragSnapshotRef.current = null
                      },
                      onDragEnd: () => {
                        setDraggingWatchStockId(null)
                        watchDragSnapshotRef.current = null
                      },
                    }}
                    className={`cursor-pointer ${draggingWatchStockId === stock.id ? 'opacity-60' : ''}`}
                    symbol={stock.symbol}
                    name={stock.name}
                    market={stock.market}
                    assetType={stock.asset_type}
                    badge={marketBadge(stock.market)}
                    followed
                    quote={quote}
                    quoteTitle={quoteHint(quote || {})}
                    priceText={quote?.current_price != null ? formatQuotePrice(quote.current_price, stock.asset_type, stock.market) : '--'}
                    suggestion={suggestion}
                    kline={kline}
                    agentCount={stock.agents?.length ?? 0}
                    runningAgentName={running ? agentName(running, agents.find(a => a.name === running)?.display_name) : null}
                    texts={cardTexts}
                    onCardClick={() => {
                      if (isSuppressCardClick()) return
                      if (tour?.active && tour.step === 'stock') { void tour.selectStock(stock.id); return }
                      setAgentDialogStock(stock)
                    }}
                    onOpenSymbol={() => { if (tour?.active && tour.step === 'stock') { void tour.selectStock(stock.id); return }; openStockDetail(stock.symbol, stock.market, stock.name, false) }}
                    onOpenDetail={() => openStockDetail(stock.symbol, stock.market, stock.name, false)}
                    onOpenKline={() => openKlineDialog(stock.symbol, stock.market, stock.name, false)}
                    onOpenNews={() => openNewsDialog(stock.name)}
                    onDeepAnalysis={() => openDeepAnalysis(stock.id, stock.symbol, stock.name)}
                    alertPanel={(
                      <StockPriceAlertPanel
                        mode="icon"
                        stockId={stock.id}
                        symbol={stock.symbol}
                        market={stock.market}
                        stockName={stock.name}
                        initialTotal={alert.total}
                        initialEnabled={alert.enabled}
                        onChanged={loadPriceAlertSummaries}
                      />
                    )}
                    onUnfollow={() => setRemoveWatchStock(stock)}
                  />
                )
              })}
                </div>
              )}
              {watchFiltered.length > STOCK_PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-[11px]"
                    disabled={watchScopeOffset === 0}
                    onClick={() => setWatchScopeOffset(Math.max(0, watchScopeOffset - STOCK_PAGE_SIZE))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    {FORK_ANALYSIS_TEXTS_ZH.prevPage}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 px-2 text-[11px]"
                    disabled={watchScopeOffset + STOCK_PAGE_SIZE >= watchFiltered.length}
                    onClick={() => setWatchScopeOffset(watchScopeOffset + STOCK_PAGE_SIZE)}
                  >
                    {FORK_ANALYSIS_TEXTS_ZH.nextPage}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Kline Dialog */}
      <KlineSummaryDialog
        open={klineDialogOpen}
        onOpenChange={setKlineDialogOpen}
        symbol={klineDialogSymbol}
        market={klineDialogMarket}
        stockName={klineDialogName}
        hasPosition={klineDialogHasPosition}
        initialSummary={klineDialogInitialSummary as any}
      />

      <StockInsightModal
        open={insightOpen}
        onOpenChange={setInsightOpen}
        symbol={insightSymbol}
        market={insightMarket}
        stockName={insightName}
        hasPosition={insightHasPosition}
      />

      {/* TradingAgents 深度分析弹窗 */}
      {deepAnalysisTarget && (
        <DeepAnalysisModal
          open={!!deepAnalysisTarget}
          onOpenChange={(open) => { if (!open) setDeepAnalysisTarget(null) }}
          stockId={deepAnalysisTarget.stockId}
          stockSymbol={deepAnalysisTarget.symbol}
          stockName={deepAnalysisTarget.name}
          stockMarket={deepAnalysisTarget.market}
        />
      )}

      {/* Remove Watchlist Dialog（fork：文案从「删除股票」改为「取消关注」） */}
      <Dialog open={!!removeWatchStock} onOpenChange={(open) => { if (!open) setRemoveWatchStock(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{FORK_ANALYSIS_TEXTS_ZH.unfollow}</DialogTitle>
            <DialogDescription>{FORK_ANALYSIS_TEXTS_ZH.unfollowDescription}</DialogDescription>
          </DialogHeader>
          {removeWatchStock && (
            <div className="space-y-4 mt-2">
              <div className="rounded-lg border border-border/40 bg-accent/20 p-3">
                <div className="text-[13px] font-semibold text-foreground">
                  {removeWatchStock.name}
                  <span className="ml-2 font-mono text-[12px] text-muted-foreground">{removeWatchStock.symbol}</span>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">
                  {hasAnyPositionForStockId(removeWatchStock.id)
                    ? stockT('stocksPage.messages.deleteStockWithPosition')
                    : stockT('stocksPage.messages.deleteStockWithoutPosition')}
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRemoveWatchStock(null)} disabled={removingWatchStock}>{stockT('stocksPage.messages.cancel')}</Button>
                <Button
                  variant="destructive"
                  onClick={() => removeFromWatchlist(removeWatchStock)}
                  disabled={removingWatchStock || hasAnyPositionForStockId(removeWatchStock.id)}
                >
                  {hasAnyPositionForStockId(removeWatchStock.id) ? stockT('stocksPage.messages.deleteStockFirst') : (removingWatchStock ? stockT('stocksPage.messages.processing') : FORK_ANALYSIS_TEXTS_ZH.unfollow)}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Account Dialog */}
      <Dialog open={accountDialogOpen} onOpenChange={setAccountDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editAccountId ? stockT('stocksPage.messages.editAccount') : stockT('stocksPage.messages.addAccountTitle')}</DialogTitle>
            <DialogDescription>{stockT('stocksPage.messages.accountInfo')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <Label>{stockT('stocksPage.messages.accountName')}</Label>
              <Input
                value={accountForm.name}
                onChange={e => setAccountForm({ ...accountForm, name: e.target.value })}
                placeholder={stockT('stocksPage.messages.accountName')}
              />
            </div>
            <div>
              <Label>{stockT('stocksPage.messages.availableFunds')}</Label>
              <Input
                value={accountForm.available_funds}
                onChange={e => setAccountForm({ ...accountForm, available_funds: e.target.value })}
                placeholder="0"
                className="font-mono"
                inputMode="decimal"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setAccountDialogOpen(false)}>{stockT('stocksPage.messages.cancel')}</Button>
              <Button onClick={handleAccountSubmit} disabled={!accountForm.name}>
                {editAccountId ? stockT('stocksPage.messages.save') : stockT('stocksPage.messages.create')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Position Dialog */}
      <Dialog
        open={positionDialogOpen}
        onOpenChange={(open) => {
          setPositionDialogOpen(open)
          if (!open) {
            setPositionSearchQuery('')
            setPositionSearchResults([])
            setShowPositionDropdown(false)
            setPositionSearchMarket('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editPositionId ? stockT('stocksPage.messages.editPosition') : stockT('stocksPage.messages.addPosition')}</DialogTitle>
            <DialogDescription>
              {accounts.find(a => a.id === positionDialogAccountId)?.name} {stockT('stocksPage.messages.positionInfo')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {editPositionId ? (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg bg-accent/30">
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${marketBadge(positionForm.stock_market).style}`}>
                  {marketBadge(positionForm.stock_market).label}
                </span>
                <span className="font-mono text-[12px] text-muted-foreground">{positionForm.stock_symbol}</span>
                <span className="text-[13px] text-foreground">{positionForm.stock_name}</span>
                <Select value={positionForm.stock_asset_type} onValueChange={value => setPositionForm({ ...positionForm, stock_asset_type: value as 'stock' | 'etf' })}>
                  <SelectTrigger aria-label={stockT('stocksPage.assetTypes.label')} className="w-28 h-8 shrink-0"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">{stockT('stocksPage.assetTypes.stock')}</SelectItem>
                    <SelectItem value="etf">{stockT('stocksPage.assetTypes.etf')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Label className="mb-0">{stockT('stocksPage.messages.searchStock')}</Label>
                  <div className="flex items-center gap-1">
                    {[
                      { value: '', label: stockT('stocksPage.markets.all') },
                      { value: 'CN', label: stockT('stocksPage.markets.cn') },
                      { value: 'HK', label: stockT('stocksPage.markets.hk') },
                      { value: 'US', label: stockT('stocksPage.markets.us') },
                    ].map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handlePositionSearchMarketChange(opt.value)}
                        className={`text-[11px] px-2 py-0.5 rounded transition-colors ${
                          positionSearchMarket === opt.value
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="relative" ref={positionDropdownRef}>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
                    <Input
                      value={positionSearchQuery}
                      onChange={e => handlePositionSearchInput(e.target.value)}
                      onFocus={() => positionSearchResults.length > 0 && setShowPositionDropdown(true)}
                      placeholder={stockT('stocksPage.messages.searchPlaceholder', { example: positionSearchMarket === 'HK' ? '00700 / 02800' : positionSearchMarket === 'US' ? 'AAPL / SPY' : positionSearchMarket === 'CN' ? '600519 / 510300' : '510300 / 02800 / SPY' })}
                      className="pl-9"
                      autoComplete="off"
                    />
                    {positionSearching && <span className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />}
                  </div>
                  {showPositionDropdown && positionSearchResults.length > 0 && (
                    <div className="relative w-full mt-1 max-h-48 overflow-auto overscroll-contain scrollbar card shadow-lg">
                      {positionSearchResults.map(item => (
                        <button
                          key={`${item.market}-${item.symbol}`}
                          type="button"
                          onClick={() => selectPositionStock(item)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-accent/50 text-left transition-colors"
                        >
                          <span className={`text-[9px] px-1 py-0.5 rounded ${marketBadge(item.market).style}`}>
                            {marketBadge(item.market).label}
                          </span>
                          <span className="font-mono text-muted-foreground text-[12px]">{item.symbol}</span>
                          <span className="flex-1 text-foreground">{item.name}</span>
                          {item.asset_type === 'etf' && <Badge variant="secondary">{stockT('stocksPage.assetTypes.etf')}</Badge>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {positionForm.stock_symbol && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${marketBadge(positionForm.stock_market).style}`}>
                      {marketBadge(positionForm.stock_market).label}
                    </span>
                    <span className="font-mono text-[12px] text-muted-foreground">{positionForm.stock_symbol}</span>
                    <span className="text-[13px] text-foreground">{positionForm.stock_name}</span>
                    <Select value={positionForm.stock_asset_type} onValueChange={value => setPositionForm({ ...positionForm, stock_asset_type: value as 'stock' | 'etf' })}>
                      <SelectTrigger aria-label={stockT('stocksPage.assetTypes.label')} className="w-28 h-8 shrink-0"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stock">{stockT('stocksPage.assetTypes.stock')}</SelectItem>
                        <SelectItem value="etf">{stockT('stocksPage.assetTypes.etf')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      onClick={() => {
                        setPositionForm({ ...positionForm, stock_id: 0, stock_symbol: '', stock_name: '', stock_market: '' })
                        setPositionSearchQuery('')
                      }}
                      className="ml-1 text-muted-foreground hover:text-destructive"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{stockT('stocksPage.messages.costPrice')}</Label>
                <Input
                  value={positionForm.cost_price}
                  onChange={e => setPositionForm({ ...positionForm, cost_price: e.target.value })}
                  placeholder="0.00"
                  className="font-mono"
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label>{stockT('stocksPage.messages.quantity')}</Label>
                <Input
                  value={positionForm.quantity}
                  onChange={e => setPositionForm({ ...positionForm, quantity: e.target.value })}
                  placeholder="0"
                  className="font-mono"
                  inputMode="numeric"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{stockT('stocksPage.messages.investedAmount')} <span className="text-muted-foreground/60 text-[11px]">({stockT('stocksPage.messages.optional')})</span></Label>
                <Input
                  value={positionForm.invested_amount}
                  onChange={e => setPositionForm({ ...positionForm, invested_amount: e.target.value })}
                  placeholder={stockT('stocksPage.messages.optional')}
                  className="font-mono"
                  inputMode="decimal"
                />
              </div>
              <div>
                <Label>{stockT('stocksPage.messages.tradingStyle')} <span className="text-muted-foreground font-normal">({stockT('stocksPage.messages.optional')})</span></Label>
                <Select
                  value={positionForm.trading_style}
                  onValueChange={val => setPositionForm({ ...positionForm, trading_style: val === '__none__' ? '' : val })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={stockT('stocksPage.messages.unset')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{stockT('stocksPage.messages.unset')}</SelectItem>
                    <SelectItem value="short">{stockT('stocksPage.messages.shortStyle')}</SelectItem>
                    <SelectItem value="swing">{stockT('stocksPage.messages.swingStyle')}</SelectItem>
                    <SelectItem value="long">{stockT('stocksPage.messages.longStyle')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setPositionDialogOpen(false)}>{stockT('stocksPage.messages.cancel')}</Button>
              <Button
                onClick={handlePositionSubmit}
                disabled={!positionForm.cost_price || !positionForm.quantity || (!editPositionId && !positionForm.stock_id && !positionForm.stock_symbol)}
              >
                {editPositionId ? stockT('stocksPage.messages.save') : stockT('stocksPage.messages.add')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Agent Assignment Dialog */}
      <Dialog open={!!agentDialogStock} onOpenChange={open => !open && setAgentDialogStock(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{stockT('stocksPage.messages.configureAgent')}</DialogTitle>
            <DialogDescription>
              {agentDialogStock?.name} ({agentDialogStock?.symbol})
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {agents.length === 0 ? (
              <p className="text-[13px] text-muted-foreground py-4 text-center">{stockT('stocksPage.messages.noAvailableAgents')}</p>
            ) : (
              agents.map(agent => {
                const stockAgent = agentDialogStock?.agents?.find(a => a.agent_name === agent.name)
                const isAssigned = !!stockAgent
                const isBatchMode = agent.execution_mode === 'batch'
                return (
                  <div key={agent.name} className="rounded-xl bg-accent/30 hover:bg-accent/50 transition-colors overflow-hidden">
                    <div className="flex items-center justify-between p-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full ${agent.enabled ? 'bg-emerald-500' : 'bg-border'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-foreground">{agentName(agent.name, agent.display_name)}</span>
                            <Badge variant="secondary" className="text-[9px]">
                              {isBatchMode ? stockT('stocksPage.messages.batch') : stockT('stocksPage.messages.single')}
                            </Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5">{localizeAgentDescription(agent.name, agent.description, stockT)}</p>
                        </div>
                      </div>
                      <Switch
                        checked={isAssigned}
                        onCheckedChange={() => agentDialogStock && toggleAgent(agentDialogStock, agent.name)}
                        disabled={!agent.enabled}
                      />
                    </div>
                    {isAssigned && isBatchMode && (
                      <div className="px-3.5 pb-3.5 pt-0">
                        <p className="text-[11px] text-muted-foreground">
                          {stockT('stocksPage.messages.agentConfigHint')}
                          <a href="/agents" className="text-primary hover:underline">{stockT('stocksPage.messages.configureAgent')}</a>
                        </p>
                      </div>
                    )}
                    {isAssigned && !isBatchMode && (
                      <div className="px-3.5 pb-3.5 pt-0 space-y-2.5">
                        {/* Schedule/Interval Select */}
                        <div className="flex items-center gap-2">
                          <Clock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <Select
                            value={stockAgent?.schedule || '__default__'}
                            onValueChange={val => agentDialogStock && updateStockAgentSchedule(agentDialogStock, agent.name, val === '__default__' ? '' : val)}
                          >
                            <SelectTrigger className="h-7 text-[11px] w-auto min-w-[140px] px-2.5 bg-accent/50 border-border/50">
                              <SelectValue placeholder={stockT('stocksPage.messages.executionInterval')} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">{stockT('stocksPage.messages.followGlobal')}</SelectItem>
                              <SelectItem value="*/1 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 1 })}</SelectItem>
                              <SelectItem value="*/3 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 3 })}</SelectItem>
                              <SelectItem value="*/5 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 5 })}</SelectItem>
                              <SelectItem value="*/10 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 10 })}</SelectItem>
                              <SelectItem value="*/15 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 15 })}</SelectItem>
                              <SelectItem value="*/30 9-15 * * 1-5">{stockT('stocksPage.messages.everyMinutes', { minutes: 30 })}</SelectItem>
                            </SelectContent>
                          </Select>
                          <span className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.tradingHours')}</span>
                        </div>

                        {/* Schedule Preview */}
                        {(() => {
                          const eff = effectiveSchedule(agent, stockAgent)
                          const isFollowingGlobal = !(stockAgent?.schedule || '').trim() && !!(agent.schedule || '').trim()
                          const previewKey = `${agent.name}|${agentDialogStock?.market}|${eff}`
                          const preview = eff ? schedulePreviewCache[previewKey] : null
                          const isLoading = eff ? !!schedulePreviewLoading[previewKey] : false
                          if (!eff) return null
                          return (
                            <div className="ml-[22px] rounded-lg border border-border/40 bg-background/30 px-2.5 py-2">
                              <div className="flex items-center justify-between">
                                <div className="text-[11px] text-muted-foreground">
                                  {stockT('stocksPage.messages.nextRunPreview')}{isFollowingGlobal ? <span className="ml-1 opacity-70">({stockT('stocksPage.messages.followGlobalShort')})</span> : null}
                                </div>
                                {isLoading && (
                                  <span className="w-3 h-3 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                                )}
                              </div>
                              {'error' in (preview || {}) ? (
                                <div className="mt-1 text-[11px] text-muted-foreground">{(preview as any).error}</div>
                              ) : (preview as SchedulePreview | undefined)?.next_runs?.length ? (
                                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                                  {(preview as SchedulePreview).next_runs.map((t, i) => (
                                    <span key={i} className="px-1.5 py-0.5 rounded border border-border/60 bg-accent/20 font-mono" title={t}>
                                      {formatPreviewTime(t)}
                                    </span>
                                  ))}
                                  {(preview as SchedulePreview).timezone ? (
                                    <span className="opacity-60">({browserTimezone()})</span>
                                  ) : null}
                                </div>
                              ) : (
                                <div className="mt-1 text-[11px] text-muted-foreground">—</div>
                              )}
                              <div className="mt-1 text-[10px] text-muted-foreground/70 font-mono">schedule: {eff}<br />{stockT('configuration:agentsPage.schedule.timezoneHint', { timezone: (preview as SchedulePreview | null)?.timezone || '…' })}</div>
                            </div>
                          )
                        })()}

                        {/* AI Model Select */}
                        <div className="flex items-center gap-2">
                          <Cpu className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                          <Select
                            value={stockAgent?.ai_model_id?.toString() ?? '__default__'}
                            onValueChange={val => agentDialogStock && updateStockAgentModel(agentDialogStock, agent.name, val === '__default__' ? null : parseInt(val))}
                          >
                            <SelectTrigger className="h-7 text-[11px] w-auto min-w-[140px] px-2.5 bg-accent/50 border-border/50">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__default__">{stockT('stocksPage.messages.systemDefault')}</SelectItem>
                              {services.map(svc => (
                                <SelectGroup key={svc.id}>
                                  <SelectLabel>{svc.name}</SelectLabel>
                                  {svc.models.map(m => (
                                    <SelectItem key={m.id} value={m.id.toString()}>
                                      {m.name}{m.name !== m.model ? ` (${m.model})` : ''}
                                    </SelectItem>
                                  ))}
                                </SelectGroup>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {/* Notification Channels */}
                        {channels.length > 0 && (
                          <div className="flex items-center gap-2 flex-wrap">
                            <Bell className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                            {channels.map(ch => {
                              const isSelected = (stockAgent?.notify_channel_ids || []).includes(ch.id)
                              return (
                                <button
                                  key={ch.id}
                                  onClick={() => agentDialogStock && toggleStockAgentChannel(agentDialogStock, agent.name, ch.id)}
                                  className={`text-[10px] px-2 py-0.5 rounded-md border transition-colors ${
                                    isSelected
                                      ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                                      : 'bg-accent/30 border-border/50 text-muted-foreground hover:border-primary/30'
                                  }`}
                                >
                                  {ch.name}
                                </button>
                              )
                            })}
                            {(stockAgent?.notify_channel_ids || []).length === 0 && (
                              <span className="text-[10px] text-muted-foreground">{stockT('stocksPage.messages.systemDefault')}</span>
                            )}
                          </div>
                        )}
                        {/* Trigger Button */}
                        <div className="flex items-center gap-2 pt-1">
                          <Button
                            variant="secondary" size="sm" className="h-7 text-[11px] px-2.5"
                            disabled={triggeringAgent === agent.name}
                            onClick={() => agentDialogStock && triggerStockAgent(agentDialogStock.id, agent.name)}
                          >
                            {triggeringAgent === agent.name ? (
                              <span className="w-3 h-3 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                            ) : (
                              <Play className="w-3 h-3" />
                            )}
                              {stockT('stocksPage.messages.deepAnalysis')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Agent 分析结果弹窗 */}
      <Dialog open={!!agentResultDialog} onOpenChange={open => !open && setAgentResultDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{agentResultDialog?.title}</DialogTitle>
            <DialogDescription className="flex items-center gap-2 pt-1">
              {agentResultDialog?.should_alert ? (
                <Badge variant="default" className="text-[10px]">{stockT('stocksPage.messages.suggestedWatch')}</Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">{stockT('stocksPage.messages.noAttention')}</Badge>
              )}
              {agentResultDialog?.notified && (
                <Badge variant="outline" className="text-[10px]">{stockT('stocksPage.messages.notificationSent')}</Badge>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 p-3 bg-accent/30 rounded-lg">
            <pre className="text-[13px] whitespace-pre-wrap font-sans leading-relaxed">
              {agentResultDialog?.content}
            </pre>
          </div>
          <div className="flex justify-end mt-2">
            <Button variant="outline" size="sm" onClick={() => setAgentResultDialog(null)}>
              {stockT('stocksPage.messages.cancel')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 相关资讯弹窗 */}
      <Dialog open={newsDialogOpen} onOpenChange={setNewsDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Newspaper className="w-5 h-5 text-blue-500" />
              {stockT('stocksPage.messages.relatedNews')}
            </DialogTitle>
            <DialogDescription>
              {newsDialogSymbol
                ? stockT('stocksPage.messages.newsTitleForStock', { name: newsDialogSymbol })
                : stockT('stocksPage.messages.newsTitleAll')
              }
            </DialogDescription>
          </DialogHeader>

          {/* 股票筛选器 */}
          <div className="flex items-center gap-2 flex-wrap py-2 border-b">
            <span className="text-[12px] text-muted-foreground">{stockT('stocksPage.messages.newsFilter')}</span>
            <button
              onClick={() => { setNewsDialogSymbol(''); loadNews() }}
              className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                !newsDialogSymbol
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-accent/50 text-muted-foreground hover:bg-accent'
              }`}
            >
              {stockT('stocksPage.markets.all')}
            </button>
            {stocks.slice(0, 10).map(stock => (
              <button
                key={stock.symbol}
                onClick={() => { setNewsDialogSymbol(stock.name); loadNews(stock.name) }}
                className={`text-[11px] px-2.5 py-1 rounded-md transition-colors ${
                  newsDialogSymbol === stock.name
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-accent/50 text-muted-foreground hover:bg-accent'
                }`}
              >
                {stock.name}
                {stock.asset_type === 'etf' && <Badge variant="secondary" className="ml-1">{stockT('stocksPage.assetTypes.etf')}</Badge>}
              </button>
            ))}
            {stocks.length > 10 && (
              <span className="text-[10px] text-muted-foreground">+{stocks.length - 10}</span>
            )}
          </div>

          {/* 新闻列表 */}
          <div className="flex-1 overflow-y-auto min-h-0 py-2 scrollbar">
            {newsLoading ? (
              <div className="flex items-center justify-center py-12">
                <span className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                <span className="ml-2 text-[13px] text-muted-foreground">{stockT('stocksPage.messages.loading')}</span>
              </div>
            ) : news.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-[13px]">
                {stockT('stocksPage.messages.noAnalysis')}
              </div>
            ) : (
              <div className="space-y-2">
                {news.map((item, idx) => (
                  <div
                    key={`${item.source}-${item.external_id}-${idx}`}
                    className="p-3 rounded-lg bg-accent/30 hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            item.source === 'eastmoney' ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400' :
                            item.source === 'eastmoney_news' ? 'bg-blue-500/10 text-blue-500' :
                            'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          }`}>
                            {item.source_label}
                          </span>
                          {item.importance >= 2 && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-500">
                              {stockT('stocksPage.messages.announcement')}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground">
                            {formatDateTime(item.publish_time)}
                          </span>
                        </div>
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[13px] font-medium text-foreground hover:text-primary transition-colors block"
                        >
                          {item.title}
                        </a>
                        {item.symbols.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-2">
                            {item.symbols.slice(0, 5).map(sym => {
                              const stockInfo = stocks.find(s => s.symbol === sym)
                              const stockName = stockInfo?.name || sym
                              return (
                                <button
                                  key={sym}
                                  onClick={() => { setNewsDialogSymbol(stockName); loadNews(stockName) }}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-mono hover:bg-primary/20 transition-colors"
                                >
                                  {stockName}
                                </button>
                              )
                            })}
                            {item.symbols.length > 5 && (
                              <span className="text-[10px] text-muted-foreground">+{item.symbols.length - 5}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-shrink-0 p-1.5 rounded-md hover:bg-accent transition-colors"
                        title={stockT('stocksPage.messages.viewOriginal')}
                      >
                        <ExternalLink className="w-4 h-4 text-muted-foreground" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 底部刷新按钮 */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-[11px] text-muted-foreground">
              {news.length} {stockT('stocksPage.messages.amountUnit')} {stockT('stocksPage.messages.stockNews')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => loadNews(newsDialogSymbol || undefined)} disabled={newsLoading}>
              <RefreshCw className={`w-3 h-3 ${newsLoading ? 'animate-spin' : ''}`} />
              {stockT('stocksPage.messages.refreshed')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
