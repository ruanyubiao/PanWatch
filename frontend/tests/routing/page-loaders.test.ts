import { describe, expect, it } from 'vitest'

import { pageLoaders, resolveRouteKey } from '@/router/page-loaders'

describe('route page loaders', () => {
  it('registers every route page exactly once', () => {
    expect(Object.keys(pageLoaders)).toEqual([
      'login',
      // fork: 分析页（A 股全市场行情表），挂在 /analysis
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

  it('resolves the fork analysis route to the fork page', () => {
    expect(resolveRouteKey('/analysis')).toBe('forkAnalysis')
    // 上游 /portfolio 仍然归 Stocks（fork 没有重定向它）
    expect(resolveRouteKey('/portfolio')).toBe('stocks')
  })
})
