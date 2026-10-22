import { lazy } from 'react'

export const pageLoaders = {
  login: () => import('@/pages/Login'),
  // fork：分析页 —— A 股全市场行情表（读本机 MySQL），挂在 /analysis
  forkAnalysis: () => import('@/pages/ForkAnalysis'),
  // fork：数据分析完整报告（/analysis/report/:runId，弹窗里「查看完整报告」开在新标签页）
  forkAnalysisReport: () => import('@/pages/ForkAnalysisReport'),
  dashboard: () => import('@/pages/Dashboard'),
  gettingStarted: () => import('@/pages/GettingStarted'),
  stocks: () => import('@/pages/Stocks'),
  opportunities: () => import('@/pages/Opportunities'),
  paperTrading: () => import('@/pages/PaperTrading'),
  assistant: () => import('@/pages/Assistant'),
  alerts: () => import('@/pages/PriceAlerts'),
  agents: () => import('@/pages/Agents'),
  evaluations: () => import('@/pages/Evaluations'),
  history: () => import('@/pages/History'),
  dataSources: () => import('@/pages/DataSources'),
  settings: () => import('@/pages/Settings'),
  analysisDetail: () => import('@/pages/AnalysisDetail'),
} as const

export type RouteKey = keyof typeof pageLoaders

export const routePages = {
  LoginPage: lazy(pageLoaders.login),
  // fork：分析页
  ForkAnalysisPage: lazy(pageLoaders.forkAnalysis),
  ForkAnalysisReportPage: lazy(pageLoaders.forkAnalysisReport),
  DashboardPage: lazy(pageLoaders.dashboard),
  GettingStartedPage: lazy(pageLoaders.gettingStarted),
  StocksPage: lazy(pageLoaders.stocks),
  OpportunitiesPage: lazy(pageLoaders.opportunities),
  PaperTradingPage: lazy(pageLoaders.paperTrading),
  AssistantPage: lazy(pageLoaders.assistant),
  PriceAlertsPage: lazy(pageLoaders.alerts),
  AgentsPage: lazy(pageLoaders.agents),
  EvaluationsPage: lazy(pageLoaders.evaluations),
  HistoryPage: lazy(pageLoaders.history),
  DataSourcesPage: lazy(pageLoaders.dataSources),
  SettingsPage: lazy(pageLoaders.settings),
  AnalysisDetailPage: lazy(pageLoaders.analysisDetail),
} as const

const routeMatchers: Array<{ key: RouteKey; matches: (pathname: string) => boolean }> = [
  { key: 'login', matches: pathname => pathname === '/login' },
  { key: 'dashboard', matches: pathname => pathname === '/' },
  { key: 'gettingStarted', matches: pathname => pathname === '/getting-started' },
  { key: 'stocks', matches: pathname => pathname === '/portfolio' },
  // fork: /analysis 预加载的是分析页（不是上游 Stocks）
  { key: 'forkAnalysis', matches: pathname => pathname === '/analysis' },
  { key: 'opportunities', matches: pathname => pathname === '/opportunities' },
  { key: 'paperTrading', matches: pathname => pathname === '/paper-trading' },
  { key: 'assistant', matches: pathname => pathname === '/assistant' || pathname.startsWith('/assistant/') },
  { key: 'alerts', matches: pathname => pathname === '/alerts' },
  { key: 'agents', matches: pathname => pathname === '/agents' },
  { key: 'evaluations', matches: pathname => pathname === '/evaluations' },
  { key: 'history', matches: pathname => pathname === '/history' },
  { key: 'dataSources', matches: pathname => pathname === '/datasources' },
  { key: 'settings', matches: pathname => pathname === '/settings' },
  // fork：报告页必须排在 analysisDetail 前面 —— 后者吃所有 /analysis/ 前缀
  { key: 'forkAnalysisReport', matches: pathname => pathname.startsWith('/analysis/report/') },
  { key: 'analysisDetail', matches: pathname => pathname.startsWith('/analysis/') },
]

export function resolveRouteKey(pathname: string): RouteKey | null {
  return routeMatchers.find(({ matches }) => matches(pathname))?.key || null
}

export function preloadRoute(pathname: string): void {
  const key = resolveRouteKey(pathname)
  if (!key) return
  void pageLoaders[key]().catch(() => {})
}
