import { lazy } from 'react'

export const pageLoaders = {
  login: () => import('@/pages/Login'),
  // fork 专用首页（只保留收盘复盘 + 交易日历）；上游 Dashboard 保留但不再挂在 "/"
  forkDashboard: () => import('@/pages/ForkDashboard'),
  // fork 专用分析页（上游 Stocks.tsx 的副本 + fork 改造）；上游 Stocks 保留但不再挂路由
  forkAnalysis: () => import('@/pages/ForkAnalysis'),
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
  ForkDashboardPage: lazy(pageLoaders.forkDashboard),
  ForkAnalysisPage: lazy(pageLoaders.forkAnalysis),
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
  // fork: "/" 预加载的是 ForkDashboard，不是上游 Dashboard
  { key: 'forkDashboard', matches: pathname => pathname === '/' },
  { key: 'gettingStarted', matches: pathname => pathname === '/getting-started' },
  // fork: "/analysis" = 分析页（上游 "/portfolio" 现在只是重定向到它）
  { key: 'forkAnalysis', matches: pathname => pathname === '/analysis' || pathname === '/portfolio' },
  // fork: 上游 stocks 页面不再挂任何路径（"/portfolio" 已重定向到 /analysis），
  // 因此这里不再为它登记预加载匹配；pageLoaders.stocks 保留以降低 merge 成本。
  { key: 'opportunities', matches: pathname => pathname === '/opportunities' },
  { key: 'paperTrading', matches: pathname => pathname === '/paper-trading' },
  { key: 'assistant', matches: pathname => pathname === '/assistant' || pathname.startsWith('/assistant/') },
  { key: 'alerts', matches: pathname => pathname === '/alerts' },
  { key: 'agents', matches: pathname => pathname === '/agents' },
  { key: 'evaluations', matches: pathname => pathname === '/evaluations' },
  { key: 'history', matches: pathname => pathname === '/history' },
  { key: 'dataSources', matches: pathname => pathname === '/datasources' },
  { key: 'settings', matches: pathname => pathname === '/settings' },
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
