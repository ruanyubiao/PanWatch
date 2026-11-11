/**
 * 深度分析2 页面：只钉「截图里那块 UI 是否照字段渲染出来」。
 *
 * 接口全部 mock —— 这个页面自己不发网络请求以外的判断，真实取数在服务端测过
 * （``tests/test_fork_dsa.py``）。这里关注的是容易在改样式时弄坏的地方：
 * 核心洞察、操作建议/趋势预测、板块标签、四张狙击点位卡、情绪环数字与档位文案。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ForkDsa2Page from '../ForkDsa2'

const report = {
  meta: {
    stock_code: '002256',
    stock_name: '兆新股份',
    current_price: 2.93,
    change_pct: 0.34,
    asof: '2026-10-19',
    created_at: '2026-10-19T16:34:58',
    market_phase: 'postmarket',
    market_phase_label: '盘后',
    model_used: 'test/model',
  },
  summary: {
    analysis_summary: '兆新股份当前处于空头排列，股价低于所有均线，建议观望。',
    operation_advice: '观望',
    action_label: '观望',
    trend_prediction: '看空',
    sentiment_score: 42,
    sentiment_label: '中性',
    confidence_level: '中',
    risk_warning: '跌破 2.85 元需要止损。',
  },
  strategy: {
    ideal_buy: '空头排列下暂无理想买入点',
    secondary_buy: '暂无，需等待趋势反转',
    stop_loss: '2.85元（今日低点下方约1%）',
    take_profit: '3.05元（MA5附近）',
  },
  details: {
    sectors: ['光伏发电', '电力', '绿色电力'],
    limitations: ['新闻面未纳入（东财新闻搜索无结果或不可用）'],
    data_sources: ['本机行情库', '东财板块归属'],
  },
}

const latest = vi.fn()
const getReport = vi.fn()
const analyze = vi.fn()

vi.mock('@/lib/dsa-api', () => ({
  DSA_POLL_MS: 999999,
  getDsaLatest: (...args: unknown[]) => latest(...args),
  getDsaReport: (...args: unknown[]) => getReport(...args),
  analyzeDsa: (...args: unknown[]) => analyze(...args),
  getDsaHistory: vi.fn(),
}))

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dsa2/002256?name=%E5%85%86%E6%96%B0%E8%82%A1%E4%BB%BD']}>
      <Routes>
        <Route path="/dsa2/:symbol" element={<ForkDsa2Page />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('深度分析2 页面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latest.mockResolvedValue({
      id: 7,
      symbol: '002256',
      status: 'done',
      model_used: 'test/model',
      created_at: '2026-10-19T16:34:58',
      report,
    })
  })

  it('渲染截图那块面板的全部字段', async () => {
    renderPage()
    expect(await screen.findByText('兆新股份')).toBeTruthy()
    expect(screen.getByText('2.93')).toBeTruthy()
    expect(screen.getByText('+0.34%')).toBeTruthy()
    expect(screen.getByText('核心洞察')).toBeTruthy()
    expect(screen.getAllByText(/空头排列/).length).toBeGreaterThan(0)
    expect(screen.getByText('操作建议')).toBeTruthy()
    expect(screen.getByText('趋势预测')).toBeTruthy()
    expect(screen.getByText('看空')).toBeTruthy()
    // 板块标签逐个渲染
    expect(screen.getByText('光伏发电')).toBeTruthy()
    expect(screen.getByText('绿色电力')).toBeTruthy()
    // 四张狙击点位卡
    expect(screen.getByText('理想买入')).toBeTruthy()
    expect(screen.getByText('二次买入')).toBeTruthy()
    expect(screen.getByText('止损价位')).toBeTruthy()
    expect(screen.getByText('止盈目标')).toBeTruthy()
    expect(screen.getByText(/2.85元/)).toBeTruthy()
    // 情绪环：42 与档位文案
    expect(screen.getByText('42')).toBeTruthy()
    expect(screen.getByText('中性')).toBeTruthy()
    // 数据缺口要明说
    expect(screen.getByText(/新闻面未纳入/)).toBeTruthy()
  })

  it('没有历史报告时自动起任务并显示进度', async () => {
    latest.mockResolvedValue({ id: null, symbol: '002256', status: 'none', report: null })
    analyze.mockResolvedValue({ id: 8, symbol: '002256', status: 'running', report: null })
    renderPage()
    await waitFor(() => expect(analyze).toHaveBeenCalledWith('002256', '兆新股份'))
    expect(await screen.findByText('正在生成决策报告…')).toBeTruthy()
  })

  it('失败时给出错误与重试入口', async () => {
    latest.mockResolvedValue({
      id: 9,
      symbol: '002256',
      status: 'failed',
      error: 'RuntimeError: 行情库炸了',
      report: null,
    })
    renderPage()
    expect(await screen.findByText('分析失败')).toBeTruthy()
    expect(screen.getByText(/行情库炸了/)).toBeTruthy()
    expect(screen.getAllByText('重新分析').length).toBeGreaterThan(0)
  })

  it('数据源面板：逐行标「已接入 / 未配置」，需要 apikey 的模块不会假装有数据', async () => {
    latest.mockResolvedValue({
      id: 11,
      symbol: '002256',
      status: 'done',
      model_used: 'test/model',
      created_at: '2026-10-19T16:34:58',
      report: {
        ...report,
        details: {
          ...report.details,
          sources: [
            { key: 'market', label: '行情 / 均线 / 技术指标', source: '本机行情库 MySQL', status: 'ok' },
            { key: 'announcements', label: '公司公告', source: '东财公告接口', status: 'unavailable' },
            { key: 'research', label: '研报 / 机构评级', source: null, requires_key: true, status: 'unconfigured' },
          ],
        },
      },
    })
    renderPage()
    expect(await screen.findByText('数据源')).toBeTruthy()
    expect(screen.getByText('已接入')).toBeTruthy()
    expect(screen.getByText('本次未取到')).toBeTruthy()
    expect(screen.getByText('未配置')).toBeTruthy()
    const research = document.querySelector('[data-dsa2-source="research"]')
    expect(research?.getAttribute('data-dsa2-source-status')).toBe('unconfigured')
  })

  it('老报告没有数据源清单时不渲染面板（不留一堆假的未配置）', async () => {
    renderPage()
    expect(await screen.findByText('兆新股份')).toBeTruthy()
    expect(document.querySelector('[data-dsa2-sources]')).toBeNull()
  })
})
