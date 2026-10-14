/**
 * fork：未关注股票的深度分析契约。
 *
 * 背景：后端本就支持「无绑定」触发（stock_id<=0 + symbol/market + allow_unbound=true，
 * 不落库、不写自选），只有前端的触发请求不带 symbol/market，导致未关注的股票点深度
 * 分析必然被后端以 stock_symbol_required 拒绝。本测试钉住修复后的契约：
 *   stockId<=0  → 必须把 symbol/market/name 透传给 trigger
 *   stockId>0   → 请求形状与上游一致（不带这三个参数）
 */
import i18n from '@/i18n'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tradingAgentsApi } from '@panwatch/api'
import { DeepAnalysisModal } from '@panwatch/biz-ui/components/deep-analysis-modal'

vi.mock('@panwatch/api', () => ({
  tradingAgentsApi: {
    trigger: vi.fn(),
    findRunning: vi.fn(),
    getLatestForStock: vi.fn(),
    getProgress: vi.fn(),
  },
  subscribeSSE: vi.fn(),
}))
vi.mock('@panwatch/base-ui/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  stockName: '万科A',
  stockSymbol: '000002',
}

beforeEach(async () => {
  vi.clearAllMocks()
  // 弹窗会把 running 的 trace_id 按 symbol 存进 localStorage，跨用例会串味
  // （同 symbol 的下一个用例会直接进「运行中」视图，且首帧渲染出的开始按钮
  //  在重渲染时已被摘掉，点击落空 → 断言不到 trigger）。
  localStorage.clear()
  await i18n.changeLanguage('zh-CN')
  vi.mocked(tradingAgentsApi.findRunning).mockResolvedValue({ trace_id: null, status: 'none' })
  vi.mocked(tradingAgentsApi.getLatestForStock).mockResolvedValue(null)
  vi.mocked(tradingAgentsApi.trigger).mockResolvedValue({ ok: true, trace_id: 'man-tradingagents-000002-1' })
  vi.mocked(tradingAgentsApi.getProgress).mockResolvedValue({
    trace_id: 'man-tradingagents-000002-1',
    status: 'running',
    stages: [],
    completed_stages: [],
    elapsed_sec: 1,
    total_cost_usd: 0,
  })
})

describe('未关注股票的深度分析', () => {
  it('stockId=0 时把 symbol/market/name 透传给 trigger（走后端无绑定通道）', async () => {
    render(<DeepAnalysisModal {...baseProps} stockId={0} stockMarket="CN" />)
    const start = await screen.findByRole('button', { name: '开始分析' })
    fireEvent.click(start)
    await waitFor(() => expect(tradingAgentsApi.trigger).toHaveBeenCalledTimes(1))
    expect(tradingAgentsApi.trigger).toHaveBeenCalledWith(0, {
      force: false,
      symbol: '000002',
      market: 'CN',
      name: '万科A',
    })
  })

  it('已关注（stockId>0）时不带 symbol/market/name，保持上游请求形状', async () => {
    render(<DeepAnalysisModal {...baseProps} stockId={21} stockMarket="CN" />)
    const start = await screen.findByRole('button', { name: '开始分析' })
    fireEvent.click(start)
    await waitFor(() => expect(tradingAgentsApi.trigger).toHaveBeenCalledTimes(1))
    expect(tradingAgentsApi.trigger).toHaveBeenCalledWith(21, {
      force: false,
      symbol: undefined,
      market: undefined,
      name: undefined,
    })
  })

  it('未关注时 market 缺省为 CN，不至于把 symbol 空着送出去', async () => {
    render(<DeepAnalysisModal {...baseProps} stockId={0} />)
    const start = await screen.findByRole('button', { name: '开始分析' })
    fireEvent.click(start)
    await waitFor(() => expect(tradingAgentsApi.trigger).toHaveBeenCalledTimes(1))
    const opts = vi.mocked(tradingAgentsApi.trigger).mock.calls[0][1]
    expect(opts?.market).toBe('CN')
    expect(opts?.symbol).toBe('000002')
  })
})
