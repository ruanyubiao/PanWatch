import { describe, expect, it } from 'vitest'

import { pageLoaders, resolveRouteKey } from '@/router/page-loaders'

describe('route page loaders', () => {
  it('registers every route page exactly once', () => {
    expect(Object.keys(pageLoaders)).toEqual([
      'login',
      // fork: 首页由 ForkDashboard 加载器提供（上游 dashboard 保留但不再挂 "/"）
      'forkDashboard',
      // fork: 分析页由 ForkAnalysis 加载器提供（上游 stocks 保留但不再挂路由）
      'forkAnalysis',
      'dashboard',
      'gettingStarted',
      'stocks',
      'opportunities',
      'paperTrading',
      'assistant',
      'alerts',
      'agents',
      'evaluations',
      'history',
      'dataSources',
      'settings',
      'analysisDetail',
    ])
  })

  it('resolves both assistant routes to the same page loader', () => {
    expect(resolveRouteKey('/assistant')).toBe('assistant')
    expect(resolveRouteKey('/assistant/123')).toBe('assistant')
  })

  it('does not preload an unknown route', () => {
    expect(resolveRouteKey('/missing')).toBeNull()
  })

  it('resolves the recoverable setup page', () => {
    expect(resolveRouteKey('/getting-started')).toBe('gettingStarted')
  })
})
