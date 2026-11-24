import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dsa2Button } from '@/components/fork/Dsa2Button'
import { dsa2Path, dsa2ReportPath } from '@/lib/dsa-api'

/**
 * 分析页操作列里的「深度分析2」入口。
 *
 * 钉住两件事：地址口径统一走 ``dsa2Path``（各处不再手拼 URL），以及点击只 opener
 * 开新窗口、不发请求（一次分析要调大模型，绝不能卡住当前页）。
 */

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('深度分析2 入口', () => {
  it('地址口径：只有代码，不再带 ?name=（代码本身已经唯一确定标的）', () => {
    expect(dsa2Path('600519')).toBe('/dsa2/600519')
    expect(dsa2Path('000975')).toBe('/dsa2/000975')
    // 历史里某一份：/dsa2/代码?id=N；不给 id 就是最新一份
    expect(dsa2ReportPath('000975', 22)).toBe('/dsa2/000975?id=22')
    expect(dsa2ReportPath('000975')).toBe('/dsa2/000975')
    expect(dsa2ReportPath('000975', null)).toBe('/dsa2/000975')
    expect(dsa2Path('600519')).not.toContain('name=')
  })

  it('点一下只开新窗口：标题与 aria 都是「深度分析2」，URL 只带代码', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<Dsa2Button symbol="600519" />)

    const button = screen.getByRole('button', { name: '深度分析2' })
    expect(button.getAttribute('title')).toBe('深度分析2')
    expect(button.getAttribute('data-fork-dsa2-trigger')).toBe('1')

    await userEvent.click(button)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('/dsa2/600519', '_blank', 'noopener,noreferrer')
  })

  it('悬停文案可覆盖（分析页从 cardTexts 传进来）', () => {
    render(<Dsa2Button symbol="600519" label="深度分析2（DSA）" />)
    expect(screen.getByRole('button', { name: '深度分析2（DSA）' })).toBeTruthy()
  })

  it('北交所标的：入口不渲染（bj 前缀 / 4xx / 8xx / 920xxx 都不给按钮）', () => {
    for (const symbol of ['bj430047', '430047', '830799', '920992', 'bj920992', '870199']) {
      const { container, unmount } = render(<Dsa2Button symbol={symbol} />)
      expect(container.querySelector('[data-fork-dsa2-trigger]'), symbol).toBeNull()
      unmount()
    }
  })
})
