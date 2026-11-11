import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * 「深度分析2」的队列与计时。
 *
 * 钉住用户提的三件事：
 *  1. 刷新页面时「已用时间」不能归零 —— 起点是库里的 ``started_at``，不是前端 mount；
 *  2. 多个分析要排队：运行中排第一，其余是等待，列表可删；
 *  3. 排队中不能显示成「正在生成」。
 */

const mocks = vi.hoisted(() => ({
  latest: vi.fn(),
  report: vi.fn(),
  queue: vi.fn(),
  analyze: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('@/lib/dsa-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dsa-api')>('@/lib/dsa-api')
  return {
    ...actual,
    getDsaLatest: mocks.latest,
    getDsaReport: mocks.report,
    getDsaQueue: mocks.queue,
    analyzeDsa: mocks.analyze,
    deleteDsaQueueItem: mocks.remove,
  }
})

import ForkDsa2Page from '@/pages/ForkDsa2'
import { dsa2Path, dsaElapsedSeconds, formatDsaInstant } from '@/lib/dsa-api'

afterEach(() => {
  vi.mocked(mocks.latest).mockReset()
  vi.mocked(mocks.report).mockReset()
  vi.mocked(mocks.queue).mockReset()
  vi.mocked(mocks.analyze).mockReset()
  vi.mocked(mocks.remove).mockReset()
})

const renderPage = (symbol = '600877') =>
  render(
    <MemoryRouter initialEntries={[dsa2Path(symbol, '电科芯片')]}>
      <Routes>
        <Route path="/dsa2/:symbol" element={<ForkDsa2Page />} />
      </Routes>
    </MemoryRouter>,
  )

describe('深度分析2 · 计时', () => {
  it('已用时间以 started_at 为起点：晚 65 秒打开也是 1 分多，不是 0', () => {
    const started = new Date(Date.now() - 65_000)
    const elapsed = dsaElapsedSeconds({ started_at: started.toISOString(), created_at: started.toISOString() })
    expect(elapsed).toBeGreaterThanOrEqual(65)
    expect(elapsed).toBeLessThan(80)
  })

  it('排队中（没有 started_at）退回入队时间，不会算出负数', () => {
    expect(dsaElapsedSeconds({ started_at: null, created_at: null })).toBe(0)
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(dsaElapsedSeconds({ started_at: future })).toBe(0)
  })

  it('开始时间按 2026/11/11 11:46:55 显示（带秒）', () => {
    const text = formatDsaInstant('2026-11-11T11:46:55')
    expect(text).toMatch(/^2026\/11\/11 \d{2}:46:55$/)
  })

  it('运行中卡片显示「任务开始时间」与算出来的已用时长', async () => {
    const started = new Date(Date.now() - 125_000)
    mocks.latest.mockResolvedValue({
      id: 7,
      symbol: '600877',
      name: '电科芯片',
      status: 'running',
      created_at: started.toISOString(),
      started_at: started.toISOString(),
      report: null,
    })

    renderPage()
    const startedAt = await screen.findByText(/任务开始时间/)
    expect(startedAt.textContent).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/)
    expect(screen.getByText(/已用 2 分 \d+ 秒/)).toBeTruthy()
  })
})

describe('深度分析2 · 队列', () => {
  const running = {
    id: 11,
    symbol: '600519',
    name: '贵州茅台',
    status: 'running' as const,
    created_at: '2026-11-11T11:40:00',
    started_at: '2026-11-11T11:40:05',
    queue_position: 0,
  }
  const waiting = {
    id: 12,
    symbol: '002256',
    name: '兆新股份',
    status: 'queued' as const,
    created_at: '2026-11-11T11:41:00',
    started_at: null,
    queue_position: 1,
  }

  it('排队中显示「排队中」而不是「正在生成」', async () => {
    mocks.latest.mockResolvedValue({ ...waiting, symbol: '600877', queue_position: 2 })
    renderPage()
    expect(await screen.findByText('排队中')).toBeTruthy()
    expect(screen.getByText(/前面还有 2 个任务/)).toBeTruthy()
    expect(screen.queryByText('正在生成决策报告…')).toBeNull()
  })

  it('队列按钮列出运行中在前、等待在后，并标出位次', async () => {
    mocks.latest.mockResolvedValue({ ...running, symbol: '600877', queue_position: 0 })
    mocks.queue.mockResolvedValue({ items: [running, waiting], running, pending: 1 })

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '队列' }))

    const rows = await screen.findAllByRole('listitem')
    expect(rows[0].getAttribute('data-dsa2-queue-item')).toBe('600519')
    expect(rows[0].getAttribute('data-dsa2-queue-status')).toBe('running')
    expect(rows[1].getAttribute('data-dsa2-queue-item')).toBe('002256')
    expect(rows[1].textContent).toContain('等待')
    expect(rows[1].textContent).toContain('前面 1 个')
  })

  it('删除走接口，删完重新读队列', async () => {
    mocks.latest.mockResolvedValue({ ...running, symbol: '600877', queue_position: 0 })
    mocks.queue.mockResolvedValue({ items: [running, waiting], running, pending: 1 })
    mocks.remove.mockResolvedValue({ id: 12, outcome: 'deleted' })

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '队列' }))
    await userEvent.click(await screen.findByRole('button', { name: '把 002256 从队列删除' }))

    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith(12))
    await waitFor(() => expect(mocks.queue).toHaveBeenCalledTimes(2))
  })

  it('每一项的「名称 / 代码 / 时间」压在同一行，不占两行', async () => {
    mocks.latest.mockResolvedValue({ ...running, symbol: '600877', queue_position: 0 })
    mocks.queue.mockResolvedValue({ items: [running, waiting], running, pending: 1 })

    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: '队列' }))
    const rows = await screen.findAllByRole('listitem')

    // 一行 = 同一个不换行容器里同时装着名称、代码和时间
    const line = rows[0].querySelector('[class*="whitespace-nowrap"]')
    expect(line).toBeTruthy()
    expect(line!.textContent).toContain('贵州茅台')
    expect(line!.textContent).toContain('600519')
    expect(line!.textContent).toMatch(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/)

    // 旧的「两行」结构（block 子元素）不能再出现
    expect(rows[0].querySelectorAll('.block')).toHaveLength(0)
    const waitLine = rows[1].querySelector('[class*="whitespace-nowrap"]')
    expect(waitLine!.textContent).toContain('兆新股份')
    expect(waitLine!.textContent).toContain('002256')
    expect(waitLine!.textContent).toContain('前面 1 个')
  })
})

describe('深度分析2 · 运行中提示文案', () => {
  it('提示保持一句话以内（用户口径：太长）', async () => {
    const started = new Date(Date.now() - 6_000)
    mocks.latest.mockResolvedValue({
      id: 21,
      symbol: '600877',
      name: '电科芯片',
      status: 'running',
      created_at: started.toISOString(),
      started_at: started.toISOString(),
      report: null,
    })

    renderPage()
    const hint = await screen.findByText(/1~3 分钟/)
    expect(hint.textContent).toBe('通常 1~3 分钟；可关掉窗口，稍后再看同一份结果。')
    expect(hint.textContent!.length).toBeLessThan(30)
  })
})
