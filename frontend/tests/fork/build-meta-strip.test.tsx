import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BuildMetaStrip } from '@/components/fork/BuildMetaStrip'

/**
 * 分析页筛选行右端的元信息（第六轮）：代码版本 / 提交时间 / 页面数据同步时间。
 *
 * 钉住三件事：
 *   1. 三项都在位，且都带「v / 提交 / 同步」前缀（用户要求的叫法）
 *   2. 缺信息时那一项不渲染，全缺时整块不渲染（不留一串空标签）
 *   3. 「同步」的悬停说明里要能看到库内最新交易日 —— 行情不是实时价，
 *      这是唯一能看出数据是哪天的地方
 */

const BUILD = {
  sha: '3827fc2a',
  branch: 'analysis-20261019',
  commit_time: '2026-10-19T18:56:00+08:00',
  published_at: '2026-10-19T19:30:00+08:00',
}

afterEach(() => cleanup())

describe('fork: 版本/同步元信息', () => {
  it('三项都渲染：v<sha> / 提交 / 同步', () => {
    render(<BuildMetaStrip build={BUILD} syncAt={Date.parse('2026-10-19T19:12:00+08:00')} asof="2026-10-19" />)
    const version = screen.getByText('v3827fc2a')
    expect(version).toBeTruthy()
    expect(version.getAttribute('title')).toContain('analysis-20261019')

    expect(screen.getByText(/^提交 /)).toBeTruthy()
    const sync = screen.getByText(/^同步 /)
    expect(sync.getAttribute('title')).toContain('2026-10-19')
  })

  it('只有版本时只渲染一项（提交/同步缺失不报错）', () => {
    render(<BuildMetaStrip build={{ sha: '3827fc2a' }} syncAt={null} asof={null} />)
    expect(screen.getByText('v3827fc2a')).toBeTruthy()
    expect(screen.queryByText(/^提交 /)).toBeNull()
    expect(screen.queryByText(/^同步 /)).toBeNull()
  })

  it('什么都没拿到时整块不渲染', () => {
    const { container } = render(<BuildMetaStrip build={null} syncAt={null} asof={null} />)
    expect(container.innerHTML).toBe('')
  })
})
