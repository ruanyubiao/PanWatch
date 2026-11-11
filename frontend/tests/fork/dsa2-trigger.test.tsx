import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dsa2Button } from '@/components/fork/Dsa2Button'
import { dsa2Path } from '@/lib/dsa-api'

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
  it('地址口径：/dsa2/<代码>?name=<名称>，名称缺省留空', () => {
    expect(dsa2Path('600519', '贵州茅台')).toBe('/dsa2/600519?name=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0')
    expect(dsa2Path('000001')).toBe('/dsa2/000001?name=')
    expect(dsa2Path('000001', null)).toBe('/dsa2/000001?name=')
  })

  it('点一下只开新窗口：标题与 aria 都是「深度分析2」，URL 带代码和名称', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    render(<Dsa2Button symbol="600519" name="贵州茅台" />)

    const button = screen.getByRole('button', { name: '深度分析2' })
    expect(button.getAttribute('title')).toBe('深度分析2')
    expect(button.getAttribute('data-fork-dsa2-trigger')).toBe('1')

    await userEvent.click(button)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith(
      '/dsa2/600519?name=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0',
      '_blank',
      'noopener,noreferrer',
    )
  })

  it('悬停文案可覆盖（分析页从 cardTexts 传进来）', () => {
    render(<Dsa2Button symbol="600519" name="贵州茅台" label="深度分析2（DSA）" />)
    expect(screen.getByRole('button', { name: '深度分析2（DSA）' })).toBeTruthy()
  })
})
