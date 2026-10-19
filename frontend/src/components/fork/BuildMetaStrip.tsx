import type { ReactNode } from 'react'

/**
 * fork：分析页筛选行右端的元信息（用户指定的三项与顺序）——
 *
 *   数据时间：2026-10-19 17:00:30   vabbac461   2026-10-19 19:28:04
 *   └ 股票数据最后一次同步          └ 代码版本    └ 代码最后提交
 *
 * - **数据时间**来自 ``GET /api/stocks/market-meta`` 的 ``data_synced_at`` ——
 *   行情库最后一次同步的时刻（管道 ``sync_log`` 里 ``stock_daily`` 那条成功记录），
 *   不是页面载入时间。用户明确要「股票最后一次数据同步」，页面载入时刻已经去掉。
 * - **版本 / 提交时间**同接口的 ``sha`` / ``commit_time``（部署时写下的
 *   ``BUILD_INFO.json`` 或本机 ``.git``，见 ``fork_market.build_info``）。
 *
 * 时间一律按**浏览器本地时区**显示，格式固定 ``YYYY-MM-DD HH:MM:SS``：
 * 不使用 toLocaleString —— 它在中文 locale 下给出 ``2026/10/19 17:00:30``（斜杠）。
 * 三项都拿不到就整块隐藏 —— 这行只是给人对版本/对数据用的。
 */

export interface BuildMeta {
  sha?: string | null
  branch?: string | null
  commit_time?: string | null
  published_at?: string | null
  /** 行情库最后一次同步（ISO，带本机时区偏移） */
  data_synced_at?: string | null
  /** 那次同步对应的交易日（YYYY-MM-DD） */
  data_trade_date?: string | null
}

/**
 * 时间串 → 本地 ``YYYY-MM-DD HH:MM:SS``；解析不了返回空串。
 *
 * 不带时区信息的串（``2026-10-19T17:00:30``）由 ``new Date`` 按本地时间解释 ——
 * 与后端「库里存的是本机时间」的前提一致；带 ``+08:00`` 的先换算到本地。
 */
export function formatLocalStamp(value?: string | null): string {
  const text = (value || '').trim()
  if (!text) return ''
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

const BUILD_META_TEXTS_ZH = {
  dataTime: (stamp: string) => `数据时间：${stamp}`,
  dataTimeHint: (stamp: string, tradeDate: string | null | undefined) =>
    `股票数据最后一次同步：${stamp}${tradeDate ? `（交易日 ${tradeDate}）` : ''}`,
  version: (version: string) => `v${version}`,
  versionHint: (build: BuildMeta) =>
    `代码版本 ${build.sha}${build.branch ? `（分支 ${build.branch}）` : ''}${
      build.published_at ? `，部署于 ${formatLocalStamp(build.published_at)}` : ''
    }`,
  commitHint: (stamp: string) => `代码最后一次提交：${stamp}`,
}

export interface BuildMetaStripProps {
  build: BuildMeta | null
}

export function BuildMetaStrip({ build }: BuildMetaStripProps) {
  const version = (build?.sha || '').trim()
  const dataTime = formatLocalStamp(build?.data_synced_at)
  const commit = formatLocalStamp(build?.commit_time)

  if (!dataTime && !version && !commit) return null

  const items: ReactNode[] = []
  if (dataTime) {
    items.push(
      <span
        key="data"
        data-fork-build-data-time
        title={BUILD_META_TEXTS_ZH.dataTimeHint(dataTime, build?.data_trade_date)}
      >
        {BUILD_META_TEXTS_ZH.dataTime(dataTime)}
      </span>,
    )
  }
  if (version) {
    items.push(
      <span
        key="version"
        data-fork-build-version
        title={BUILD_META_TEXTS_ZH.versionHint(build as BuildMeta)}
      >
        {BUILD_META_TEXTS_ZH.version(version)}
      </span>,
    )
  }
  if (commit) {
    items.push(
      <span key="commit" data-fork-build-commit title={BUILD_META_TEXTS_ZH.commitHint(commit)}>
        {commit}
      </span>,
    )
  }

  return (
    <span
      data-fork-build-meta
      className="ml-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none text-muted-foreground/60"
    >
      {items}
    </span>
  )
}

export default BuildMetaStrip
