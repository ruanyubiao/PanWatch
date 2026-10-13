import { afterEach, describe, expect, it, vi } from 'vitest'
import { tradingAgentsApi } from '@panwatch/api/tradingagents'

describe('deep analysis report metadata', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each(['latest', 'history'])('keeps the analysis date separate from generated time for %s', async kind => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { content: 'Report', analysis_date: '2026-10-01', created_at: '2026-10-01T08:00:00+08:00', updated_at: '2026-10-01T15:30:00+08:00' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const report = kind === 'latest' ? await tradingAgentsApi.getLatestForStock('601238') : await tradingAgentsApi.getAnalysisByDate('601238', '2026-10-01')
    expect(report?.analysis_date).toBe('2026-10-01')
    expect(report?.generated_at).toBe('2026-10-01T15:30:00+08:00')
  })
})

describe('deep analysis trigger for non-followed stocks', () => {
  afterEach(() => vi.restoreAllMocks())
  const urls: string[] = []
  const mockFetch = () => {
    urls.length = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ code: 0, data: { ok: true, trace_id: 'man-tradingagents-000002-1' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
  }

  it('stockId<=0 时带上 symbol/market/name，走后端无绑定通道', async () => {
    mockFetch()
    await tradingAgentsApi.trigger(0, { symbol: '000002', market: 'CN', name: '万科A' })
    const url = urls[0]
    expect(url).toContain('/stocks/0/agents/tradingagents/trigger')
    expect(url).toContain('allow_unbound=true')
    expect(url).toContain('symbol=000002')
    expect(url).toContain('market=CN')
    expect(url).toContain(`name=${encodeURIComponent('万科A')}`)
  })

  it('已关注（stockId>0）时不带 symbol/market，保持原有请求形状', async () => {
    mockFetch()
    await tradingAgentsApi.trigger(21, { force: true })
    const url = urls[0]
    expect(url).toContain('/stocks/21/agents/tradingagents/trigger')
    expect(url).toContain('allow_unbound=true')
    expect(url).toContain('force_refresh=true')
    expect(url).not.toContain('symbol=')
    expect(url).not.toContain('market=')
  })
})
