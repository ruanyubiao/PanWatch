import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BuildMetaStrip, formatLocalStamp } from '@/components/fork/BuildMetaStrip'

/**
 * 分析页筛选行右端的元信息（用户第七轮定的口径）：
 *
 *   数据时间：2026-10-19 17:00:30   vabbac461   2026-10-19 19:28:04
 *
 * 钉住四件事：
 *   1. 顺序是「数据时间 → 版本 → 提交时间」（用户明确要求的排列）
 *   2. 时间格式固定 ``YYYY-MM-DD HH:MM:SS``，本地时区 —— 不是 toLocaleString
 *      那种 ``2026/10/19 17:00:30``（斜杠），也不是只到分钟
 *   3. 「数据时间」取的是**股票数据最后一次同步**（``data_synced_at``），
 *      不是页面载入时刻 —— 页面载入时间这一项已经删掉
 *   4. 缺信息时那一项不渲染，全缺时整块不渲染（不留一串空标签）
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

describe('fork: 数据时间 / 版本 / 提交时间', () => {
  it('三项都渲染，顺序是 数据时间 → 版本 → 提交时间', () => {
    const { container } = render(<BuildMetaStrip build={BUILD} />)
    const strip = container.querySelector('[data-fork-build-meta]') as HTMLElement
    expect(strip).toBeTruthy()

    const text = strip.textContent || ''
    expect(text).toContain('数据时间：2026-10-19 17:00:30')
    expect(text).toContain('vabbac461')
    expect(text).toContain('2026-10-19 19:28:04')

    expect(text.indexOf('数据时间：')).toBeLessThan(text.indexOf('vabbac461'))
    expect(text.indexOf('vabbac461')).toBeLessThan(text.indexOf('2026-10-19 19:28:04'))
  })

  it('数据时间=/.../ 带交易日悬停说明，版本悬停带分支', () => {
    const { container } = render(<BuildMetaStrip build={BUILD} />)
    const data = container.querySelector('[data-fork-build-data-time]') as HTMLElement
    expect(data.getAttribute('title')).toContain('2026-10-19 17:00:30')
    expect(data.getAttribute('title')).toContain('交易日 2026-10-19')

    const version = container.querySelector('[data-fork-build-version]') as HTMLElement
    expect(version.getAttribute('title')).toContain('analysis-20261019')
    // 部署时间也按同一格式显示（不再出现 ISO 原串）
    expect(version.getAttribute('title')).toContain('2026-10-19 19:33:31')
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
    expect(container.textContent).toBe('vabbac461')
    expect(container.querySelector('[data-fork-build-data-time]')).toBeNull()
    expect(container.querySelector('[data-fork-build-commit]')).toBeNull()
  })

  it('什么都没拿到时整块不渲染', () => {
    const { container } = render(<BuildMetaStrip build={null} />)
    expect(container.innerHTML).toBe('')
  })
})
