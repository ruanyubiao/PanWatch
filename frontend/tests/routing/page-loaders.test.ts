import { describe, expect, it } from 'vitest'

import { pageLoaders, resolveRouteKey } from '@/router/page-loaders'

describe('route page loaders', () => {
  it('registers every route page exactly once', () => {
    expect(Object.keys(pageLoaders)).toEqual([
      'login',
      // fork: 分析页（A 股全市场行情表），挂在 /analysis
      'forkAnalysis',
    'forkAnalysisReport',
      // fork: 任务详情独立页（/analysis/task/:kind/:runId）
      'forkAnalysisTask',
      // fork: 深度分析2（/dsa2/:symbol，DSA 风格决策报告）
      'forkDsa2',
      // fork: 模型预测（/predict 列表 + /predict/:code 详情）
      'forkPredict',
      'forkPredictDetail',
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

  it('resolves the fork predict routes', () => {
    expect(resolveRouteKey('/predict')).toBe('forkPredict')
    // 详情要排在列表前面：/predict/000975 也满足 /predict 前缀
    expect(resolveRouteKey('/predict/000975')).toBe('forkPredictDetail')
  })

  it('resolves the fork analysis route to the fork page', () => {
    expect(resolveRouteKey('/analysis')).toBe('forkAnalysis')
    // 上游 /portfolio 仍然归 Stocks（fork 没有重定向它）
    expect(resolveRouteKey('/portfolio')).toBe('stocks')
  })
})
