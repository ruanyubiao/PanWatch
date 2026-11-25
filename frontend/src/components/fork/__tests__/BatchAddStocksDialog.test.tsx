/**
 * 「添加股票」弹窗的输入口径（用户 2026-11-25 报的 bug）。
 *
 * 用户粘贴的是「代码 名称」一行一只：
 *
 *   600486 扬农化工
 *   000981 山子高科
 *   600486 扬农化工
 *
 * 旧切分器按空白一刀切，一行会变成「600486」+「扬农化工」两条，两条又都解析到
 * 同一只票，列表里就出现重复的两行。这里钉住三件事：
 * - 「代码 名称」只算一条（三行输入 → 已识别 2 个输入）；
 * - 解析后按代码再去一次重，重复的同一只票只留一行；
 * - 代码搜不到时用名称兜底（名称只是提示，不单独成条）。
 *
 * 搜索接口全部 mock，真实搜索在服务端那边有自己的用例。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BatchAddStocksDialog } from '../BatchAddStocksDialog'

const fetchAPI = vi.fn()

vi.mock('@panwatch/api', () => ({
  fetchAPI: (...args: unknown[]) => fetchAPI(...args),
}))

/** 搜索桩：代码 → 名称，名称 → 同一只票。 */
const CATALOG: Record<string, { symbol: string; name: string; market: string }> = {
  '600486': { symbol: '600486', name: '扬农化工', market: 'CN' },
  '000981': { symbol: '000981', name: '山子高科', market: 'CN' },
  扬农化工: { symbol: '600486', name: '扬农化工', market: 'CN' },
  山子高科: { symbol: '000981', name: '山子高科', market: 'CN' },
}

function searchStub(url: string) {
  const q = decodeURIComponent(String(url).replace(/^.*[?&]q=/, '').split('&')[0])
  const hit = CATALOG[q]
  return Promise.resolve(hit ? [hit] : [])
}

function renderDialog() {
  return render(
    <BatchAddStocksDialog
      open
      onOpenChange={() => {}}
      existingSymbols={new Set<string>()}
      onAdded={() => {}}
    />,
  )
}

function typeInput(text: string) {
  // Dialog 内容渲染在 portal 里，跟着 document 走而不是 render 的 container
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: text } })
}

describe('BatchAddStocksDialog 输入解析', () => {
  beforeEach(() => {
    fetchAPI.mockReset()
    fetchAPI.mockImplementation((url: string) => searchStub(url))
  })

  it('「代码 名称」一行一条：三行输入识别为 2 个，解析后仍是 2 行', async () => {
    renderDialog()
    typeInput('600486 扬农化工\n000981 山子高科\n600486 扬农化工')

    expect(screen.getByText(/已识别 2 个输入/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '解析' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /确认添加 \(2\)/ })).toBeTruthy()
    })
    // 两只票各出现一次（名称不再单独成行）
    expect(screen.getAllByText('扬农化工')).toHaveLength(1)
    expect(screen.getAllByText('山子高科')).toHaveLength(1)
    // 原始片段原样回显
    expect(screen.getByText('600486 扬农化工')).toBeTruthy()
    expect(screen.getByText('000981 山子高科')).toBeTruthy()
  })

  it('代码与名称分成两条输入时，解析后按代码合并成一行', async () => {
    renderDialog()
    typeInput('600486\n扬农化工')

    expect(screen.getByText(/已识别 2 个输入/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '解析' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /确认添加 \(1\)/ })).toBeTruthy()
    })
    expect(screen.getAllByText('扬农化工')).toHaveLength(1)
  })

  it('代码搜不到时用名称兜底，且只算一条', async () => {
    renderDialog()
    // 代码不在目录里，名称能搜到
    typeInput('600487 扬农化工')
    fireEvent.click(screen.getByRole('button', { name: '解析' }))

    await waitFor(() => {
      expect(fetchAPI).toHaveBeenCalledWith(
        expect.stringContaining(encodeURIComponent('扬农化工')),
      )
    })
    // 兜底命中 600486，不会因为「代码没搜到」而多出一行
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /确认添加 \(1\)/ })).toBeTruthy()
    })
  })
})
