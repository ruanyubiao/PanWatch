/**
 * 深度分析2 · 历史报告。
 *
 * 用户口径（第 3 条）：库里的历史报告要能翻——在「队列」按钮后面加一颗「历史」，
 * 点开是这只票的历史列表，点某一项跳到 ``/dsa2/代码?id=N``；地址不带 id 时取最新
 * 一份。这里钉住三件事：
 *   1. ``?id=N`` 读的是那一份（走 ``getDsaReport``），不是最新；
 *   2. 不带 id 才走「最新」；
 *   3. 点历史项后地址真的变成 ``?id=N``。
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  latest: vi.fn(),
  report: vi.fn(),
  queue: vi.fn(),
  analyze: vi.fn(),
  remove: vi.fn(),
  history: vi.fn(),
}))

vi.mock('@/lib/dsa-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dsa-api')>('@/lib/dsa-api')
  return {
    ...actual,
    DSA_POLL_MS: 999999,
    getDsaLatest: mocks.latest,
    getDsaReport: mocks.report,
    getDsaQueue: mocks.queue,
    analyzeDsa: mocks.analyze,
    deleteDsaQueueItem: mocks.remove,
    getDsaHistory: mocks.history,
  }
})

import ForkDsa2Page from '@/pages/ForkDsa2'

/** 当前地址（点历史项后要能读到 ?id=N）。 */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>
}

afterEach(() => {
  vi.mocked(mocks.latest).mockReset()
  vi.mocked(mocks.report).mockReset()
  vi.mocked(mocks.queue).mockReset()
  vi.mocked(mocks.analyze).mockReset()
  vi.mocked(mocks.remove).mockReset()
  vi.mocked(mocks.history).mockReset()
})

const report = (price: number, advice: string) => ({
  meta: {
    stock_code: '000975',
    stock_name: '山金国际',
    current_price: price,
    change_pct: 1.23,
    asof: '2026-11-23',
    created_at: '2026-11-23T16:40:00',
    market_phase_label: '盘后',
  },
  summary: { analysis_summary: '测试用摘要', action_label: advice, trend_prediction: '看多', sentiment_score: 55 },
  strategy: {},
  details: {},
})

const HISTORY = {
  symbol: '000975',
  name: '山金国际',
  count: 2,
  items: [
    {
      id: 22,
      symbol: '000975',
      status: 'done' as const,
      created_at: '2026-11-24T10:32:24',
      price: 21.7,
      change_pct: -1.59,
      asof: '2026-11-24',
      advice: '观望',
      trend: '震荡',
    },
    {
      id: 21,
      symbol: '000975',
      status: 'done' as const,
      created_at: '2026-11-23T16:40:00',
      price: 22.05,
      change_pct: 7.93,
      asof: '2026-11-23',
      advice: '买入',
      trend: '看多',
    },
  ],
}

function renderPage(entry = '/dsa2/000975') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/dsa2/:symbol"
          element={
            <>
              <LocationProbe />
              <ForkDsa2Page />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  )
}

describe('深度分析2 · 历史报告', () => {
  it('?id=22 读的是第 22 份，不是最新那份', async () => {
    mocks.history.mockResolvedValue(HISTORY)
    mocks.report.mockResolvedValue({ id: 22, symbol: '000975', status: 'done', report: report(21.7, '观望') })

    renderPage('/dsa2/000975?id=22')

    expect(await screen.findByText(/测试用摘要/)).toBeTruthy()
    await waitFor(() => expect(mocks.report).toHaveBeenCalledWith(22))
    expect(mocks.latest).not.toHaveBeenCalled()
  })

  it('不带 id 时读最新一份（历史里挑最新那条）', async () => {
    mocks.history.mockResolvedValue(HISTORY)
    mocks.latest.mockResolvedValue({ id: 22, symbol: '000975', status: 'done', report: report(21.7, '观望') })

    renderPage('/dsa2/000975')

    expect(await screen.findByText(/测试用摘要/)).toBeTruthy()
    await waitFor(() => expect(mocks.latest).toHaveBeenCalledWith('000975'))
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('「历史」按钮在「队列」后面，点开后列出这份票的历史', async () => {
    mocks.history.mockResolvedValue(HISTORY)
    mocks.latest.mockResolvedValue({ id: 22, symbol: '000975', status: 'done', report: report(21.7, '观望') })

    renderPage()

    const triggers = Array.from(document.querySelectorAll('[data-dsa2-queue-trigger], [data-dsa2-history-trigger]'))
    expect(triggers.map(node => node.getAttribute('data-dsa2-queue-trigger') ? 'queue' : 'history')).toEqual([
      'queue',
      'history',
    ])

    await userEvent.click(screen.getByRole('button', { name: '历史' }))
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('[data-dsa2-history-item]')
      expect(found).toHaveLength(2)
      return found
    })
    expect(rows[0].getAttribute('data-dsa2-history-item')).toBe('22')
    expect(rows[0].getAttribute('data-dsa2-history-current')).toBe('1')
    expect(rows[1].textContent).toContain('买入')
  })

  it('点历史里的某一条：地址跳成 /dsa2/000975?id=21 并读那一份', async () => {
    mocks.history.mockResolvedValue(HISTORY)
    mocks.latest.mockResolvedValue({ id: 22, symbol: '000975', status: 'done', report: report(21.7, '观望') })
    mocks.report.mockResolvedValue({ id: 21, symbol: '000975', status: 'done', report: report(22.05, '买入') })

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    const rows = await waitFor(() => {
      const found = document.querySelectorAll('[data-dsa2-history-item]')
      expect(found).toHaveLength(2)
      return found
    })
    await userEvent.click(rows[1] as HTMLElement)

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/dsa2/000975?id=21'))
    await waitFor(() => expect(mocks.report).toHaveBeenCalledWith(21))
  })

  it('没有历史时列表给一句「还没有历史报告」，不是空白', async () => {
    mocks.history.mockResolvedValue({ symbol: '000975', name: '山金国际', count: 0, items: [] })
    mocks.latest.mockResolvedValue({ id: null, symbol: '000975', status: 'none', report: null })

    renderPage()
    expect(await screen.findByText('开始分析')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '历史' }))
    expect(await screen.findByText('这只票还没有历史报告')).toBeTruthy()
    expect(document.querySelectorAll('[data-dsa2-history-item]')).toHaveLength(0)
  })
})
