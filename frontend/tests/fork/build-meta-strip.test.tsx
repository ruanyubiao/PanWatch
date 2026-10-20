import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BuildMetaStrip, formatLocalStamp } from '@/components/fork/BuildMetaStrip'

/**
 * 分析页工具条第一行右端的元信息。
 *
 * 第 7 条（2026-10-20 晚）把它从**三段分开的文字**合并成**一个文本框**：
 *
 *   数据时间：2026-10-19 17:00:30 ｜ 代码版本：abbac461 ｜ 部署时间：2026-10-19 19:33:31
 *
 * 悬停提示也合并成一段**多行**文本（换行显示，一项一行）：
 *
 *   数据时间：…（交易日 …）
 *   代码版本：…（分支 …）
 *   部署时间：…
 *
 * 钉住四件事：
 *   1. 只有一个框（`[data-fork-build-meta]`），三段在同一段文本里、顺序固定
 *   2. 时间格式固定 ``YYYY-MM-DD HH:MM:SS``，本地时区 —— 不是 toLocaleString
 *      那种 ``2026/10/19 17:00:30``（斜杠）
 *   3. 提示是一段合并的多行文本，按「代码版本 / 部署时间」分行
 *   4. 缺信息时那一项不渲染，全缺时整块不渲染（不留一个空框）
 *
 * 用例里的入参故意写成**不带时区**的本地时间串（如 ``2026-10-19T17:00:30``），
 * 这样断言值与运行机器的 TZ 无关，格式错误照样会被抓到。
 */

const BUILD = {
  sha: 'abbac461',
  branch: 'analysis-20261019',
  commit_time: '2026-10-19T19:28:04',
  published_at: '2026-10-19T19:33:31',
  data_synced_at: '2026-10-19T17:00:30',
  data_trade_date: '2026-10-19',
}

afterEach(() => cleanup())

describe('fork: 数据时间 / 版本 / 部署时间（合并成一个文本框）', () => {
  it('一个框里三段同一行，顺序是 数据时间 → 代码版本 → 部署时间', () => {
    const { container } = render(<BuildMetaStrip build={BUILD} />)
    const strip = container.querySelector('[data-fork-build-meta]') as HTMLElement
    expect(strip).toBeTruthy()
    // 只有这一个框：不再有分开的三段
    expect(container.querySelectorAll('[data-fork-build-meta]')).toHaveLength(1)
    expect(container.querySelectorAll('span')).toHaveLength(1)

    const text = (strip.textContent || '').trim()
    expect(text).toBe(
      '数据时间：2026-10-19 17:00:30 ｜ 代码版本：abbac461 ｜ 部署时间：2026-10-19 19:33:31',
    )
  })

  it('悬停提示合并成多行：数据时间 → 代码版本（带分支）→ 部署时间', () => {
    const { container } = render(<BuildMetaStrip build={BUILD} />)
    const title = container.querySelector('[data-fork-build-meta]')!.getAttribute('title') || ''
    const lines = title.split('\n')

    // 一行一项，换行显示
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('数据时间：2026-10-19 17:00:30')
    expect(lines[0]).toContain('交易日 2026-10-19')
    expect(lines[1]).toContain('代码版本：abbac461')
    expect(lines[1]).toContain('analysis-20261019')
    expect(lines[2]).toContain('部署时间：2026-10-19 19:33:31')
  })

  it('格式固定为 YYYY-MM-DD HH:MM:SS（补零、不用斜杠、秒不缺位）', () => {
    expect(formatLocalStamp('2026-01-02T03:04:05')).toBe('2026-01-02 03:04:05')
    expect(formatLocalStamp('2026-01-02T03:04:05')).not.toContain('/')
    expect(formatLocalStamp('2026-10-19 17:00:30')).toBe('2026-10-19 17:00:30')
    expect(formatLocalStamp('')).toBe('')
    expect(formatLocalStamp('不是时间')).toBe('')
  })

  it('缺哪项就不渲染哪项', () => {
    const { container } = render(<BuildMetaStrip build={{ sha: 'abbac461' }} />)
    expect(container.textContent).toBe('代码版本：abbac461')
    const title = container.querySelector('[data-fork-build-meta]')!.getAttribute('title') || ''
    expect(title).toBe('代码版本：abbac461')
  })

  it('没 published_at 的旧部署用最后提交时间充当「部署时间」', () => {
    const { container } = render(
      <BuildMetaStrip build={{ sha: 'abbac461', commit_time: '2026-10-19T19:28:04' }} />,
    )
    expect(container.textContent).toContain('部署时间：2026-10-19 19:28:04')
  })

  it('什么都没拿到时整块不渲染', () => {
    const { container } = render(<BuildMetaStrip build={null} />)
    expect(container.innerHTML).toBe('')
  })
})
