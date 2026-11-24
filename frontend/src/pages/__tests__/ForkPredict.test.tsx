/**
 * 「模型预测」两个页面（/predict 列表、/predict/:code 详情）+ 地址口径。
 *
 * 接口全部 mock —— 真实取数在服务端测过（``tests/test_fork_predict.py``，
 * 包括表不存在、北交所、名次顺序、曲线正序）。这里钉的是页面会坏的地方：
 * - 列表按名次渲染、代码是**新窗口**链接到详情；
 * - 没有预测时是「尚未生成」而不是一个红色报错；
 * - 详情页把「名次 / 全市场只数 / 分位」写清楚，逐日表**最新在上**（曲线是最旧在左）；
 * - 诚实提示必须出现（这是「参考之一」不是建议）。
 */
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ForkPredictPage, { formatAmount } from '../ForkPredict'
import ForkPredictDetailPage from '../ForkPredictDetail'

const getDates = vi.fn()
const getDaily = vi.fn()
const getStock = vi.fn()

vi.mock('@/lib/predict-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/predict-api')>('@/lib/predict-api')
  return {
    ...actual,
    getPredictDates: (...args: unknown[]) => getDates(...args),
    getPredictDaily: (...args: unknown[]) => getDaily(...args),
    getPredictStock: (...args: unknown[]) => getStock(...args),
  }
})

const dailyRows = {
  available: true,
  trade_date: '2026-11-24',
  total: 4991,
  model_version: 'pred_head_20261124-1458',
  scored_at: '2026-11-24 15:42:32',
  items: [
    { rank_no: 1, code: '688630', name: '芯碁微装', pct: 100, amt_med20: 1.689508170e9 },
    { rank_no: 2, code: '688519', name: '南亚新材', pct: 99.98, amt_med20: 1.5e9 },
  ],
}

function renderList() {
  return render(
    <MemoryRouter initialEntries={['/predict']}>
      <Routes>
        <Route path="/predict" element={<ForkPredictPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderDetail(code = '688630') {
  return render(
    <MemoryRouter initialEntries={[`/predict/${code}`]}>
      <Routes>
        <Route path="/predict/:code" element={<ForkPredictDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('模型预测列表页', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDates.mockResolvedValue({
      available: true,
      dates: [{ trade_date: '2026-11-24', count: 4991, model_version: 'v' }],
      latest: '2026-11-24',
      model: { version: 'pred_head_20261124-1458', n_features: 73 },
    })
    getDaily.mockResolvedValue(dailyRows)
  })

  it('按名次渲染，代码是指向详情的新窗口链接', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('芯碁微装')).toBeTruthy())
    const link = screen.getByRole('link', { name: /688630/ }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/predict/688630')
    expect(link.getAttribute('target')).toBe('_blank')
    // 名次在第一行、分位照原值
    expect(screen.getByText('99.98')).toBeTruthy()
    expect(screen.getByText('16.90 亿')).toBeTruthy()
  })

  it('诚实提示与总数一定在页面上', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('芯碁微装')).toBeTruthy())
    expect(screen.getByText(/共 4991 只/)).toBeTruthy()
    expect(screen.getByText(/整体排序不成立/)).toBeTruthy()
  })

  it('没有预测时写「尚未生成」，不是报错', async () => {
    getDates.mockResolvedValue({ available: false, dates: [], latest: null, model: null })
    getDaily.mockResolvedValue({ available: false, trade_date: null, total: 0, items: [] })
    renderList()
    await waitFor(() => expect(screen.getByText(/预测尚未生成/)).toBeTruthy())
    expect(screen.queryByText(/读取预测失败/)).toBeNull()
  })

  it('成交额格式化：亿 / 万', () => {
    expect(formatAmount(1.68950817e9)).toBe('16.90 亿')
    expect(formatAmount(3.2e5)).toBe('32 万')
    expect(formatAmount(null)).toBe('—')
  })
})

describe('模型预测详情页', () => {
  const detail = {
    code: '688630',
    name: '芯碁微装',
    trade_date: '2026-11-24',
    rank_no: 1,
    universe: 4991,
    pct: 100,
    amt_med20: 1.68950817e9,
    model_version: 'pred_head_20261124-1458',
    scored_at: '2026-11-24 15:42:32',
    history: [
      { trade_date: '2026-11-21', rank_no: 1200, pct: 75 },
      { trade_date: '2026-11-24', rank_no: 1, pct: 100 },
    ],
    model: { version: 'v', n_features: 73 },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    getStock.mockResolvedValue(detail)
  })

  it('名次 / 全市场只数 / 分位都写清楚', async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText('芯碁微装')).toBeTruthy())
    expect(screen.getByText(/全市场 4991 只/)).toBeTruthy()
    expect(document.querySelector('[data-predict-pct="1"]')?.textContent).toBe('100.00')
    expect(screen.getAllByText('16.90 亿').length).toBeGreaterThan(0)
  })

  it('曲线有数据点，逐日表最新在上', async () => {
    renderDetail()
    await waitFor(() => expect(screen.getByText('芯碁微装')).toBeTruthy())
    expect(document.querySelector('[data-predict-curve="1"]')).toBeTruthy()
    const dates = Array.from(document.querySelectorAll('tbody tr td:first-child')).map(
      cell => cell.textContent,
    )
    expect(dates).toEqual(['2026-11-24', '2026-11-21'])
  })

  it('没有记录时给一句人话，不是空白', async () => {
    getStock.mockRejectedValue(new Error('predict_not_found'))
    renderDetail('600519')
    await waitFor(() => expect(screen.getByText(/读取预测失败/)).toBeTruthy())
  })
})
