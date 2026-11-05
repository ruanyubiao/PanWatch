import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ForkAnalysisTaskPage from '@/pages/ForkAnalysisTask'
import { resolveRouteKey } from '@/router/page-loaders'

/**
 * 任务详情独立页（历史任务点一行 → 新窗口打开，无导航、无返回）。
 *
 * 钉住三件事：
 *  1. 路由 /analysis/task/:kind/:runId 必须命中任务详情页，不能被 analysisDetail 吞掉；
 *  2. 页面里没有任何「返回 / 关闭」按钮；
 *  3. kind 分发正确 —— infer 只问推理接口，analysis 只问分析接口。
 */

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  report: vi.fn(),
  result: vi.fn(),
  inferGet: vi.fn(),
  inferResults: vi.fn(),
  inferSave: vi.fn(),
  download: vi.fn(),
  stocks: vi.fn(),
}))

vi.mock('@/lib/analysis-api', () => ({
  getAnalysisDetail: mocks.detail,
  getAnalysisReport: mocks.report,
  getAnalysisResult: mocks.result,
  downloadAnalysisExcel: mocks.download,
  getAnalysisStocks: mocks.stocks,
  formatDuration: (seconds: number | null) => (seconds === null ? '—' : `${Math.round(seconds)} 秒`),
}))

vi.mock('@/lib/infer-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/infer-api')>('@/lib/infer-api')
  return {
    ...actual,
    getInferRun: mocks.inferGet,
    getInferResults: mocks.inferResults,
    saveInferVariant: mocks.inferSave,
  }
})

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/analysis/task/:kind/:runId" element={<ForkAnalysisTaskPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('任务详情独立页', () => {
  it('路由命中任务详情页，不被 /analysis/ 的行情详情吞掉', () => {
    expect(resolveRouteKey('/analysis/task/analysis/20261022-120000-abcd')).toBe('forkAnalysisTask')
    expect(resolveRouteKey('/analysis/task/infer/20261022-120000-abcd')).toBe('forkAnalysisTask')
    // 报告页仍走自己的 loader
    expect(resolveRouteKey('/analysis/report/20261022-120000-abcd')).toBe('forkAnalysisReport')
    // 上游的个股详情不受影响
    expect(resolveRouteKey('/analysis/000001/2026-10-22')).toBe('analysisDetail')
  })

  it('分析任务：渲染条件详情，且没有返回/关闭按钮', async () => {
    mocks.detail.mockResolvedValue({
      run: {
        run_id: '20261022-120000-abcd',
        preset: 'xg1',
        status: 'done',
        method: 'stat_v3',
        start_date: '2024-01-01',
        end_date: '2026-09-02',
        hits: 1800,
        days_done: 400,
        validate_days: 30,
      },
      condition: { name: 'xg1', saved_at: '2026-10-20T10:00:00+08:00', request: null },
      verdict: null,
      horizons: [],
    })
    mocks.result.mockResolvedValue(null)

    renderAt('/analysis/task/analysis/20261022-120000-abcd')

    await waitFor(() => expect(screen.getByText('任务详情')).toBeTruthy())
    expect(document.querySelector('[data-fork-analysis-task-page="analysis"]')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /返回/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /关闭/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /返回/ })).toBeNull()
    expect(mocks.inferGet).not.toHaveBeenCalled()
  })

  it('推理任务：只问推理接口，渲染推理面板，不碰分析详情', async () => {
    mocks.inferGet.mockResolvedValue({
      run_id: '20261022-120000-abcd',
      created_at: '2026-10-22T12:00:00+08:00',
      status: 'done',
      preset: 'r11020315',
      iterations: 1000,
      done_iterations: 1000,
      alive: false,
      train_start: '2024-01-02',
      train_end: '2025-12-31',
      valid_start: '2026-01-05',
      valid_end: '2026-09-02',
      scores: { train: 64.2, test: 61.5 },
    })
    mocks.inferResults.mockResolvedValue({ finalists: [] })

    renderAt('/analysis/task/infer/20261022-120000-abcd')

    await waitFor(() => expect(document.querySelector('[data-fork-infer-panel]')).toBeTruthy())
    expect(mocks.inferGet).toHaveBeenCalledWith('20261022-120000-abcd')
    expect(mocks.detail).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /返回/ })).toBeNull()
  })
})
