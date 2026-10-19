import { formatDateTime } from '@/lib/utils'

/**
 * fork：分析页筛选行右端的元信息（用户要求的那三项）——
 *
 *   代码最新版本 | 提交时间 | 页面数据同步时间
 *
 * - **版本 / 提交时间**来自 ``GET /api/stocks/market-meta``（后端从部署时写下的
 *   ``BUILD_INFO.json`` 或本机 ``.git`` 取，见 ``fork_market.build_info``）。
 * - **同步时间**是这一页的数据真正载入的时刻（``StockMarketTable`` 拿到
 *   ``/stocks/market-table`` 响应时回传），点「刷新」会跟着变；
 *   悬停能看到库内最新交易日（那个才是「行情是哪天的」）。
 *
 * 三项都拿不到就整块隐藏 —— 这行只是给人对版本用的，不该在缺信息时留一串空标签。
 */

export interface BuildMeta {
  sha?: string | null
  branch?: string | null
  commit_time?: string | null
  published_at?: string | null
}

const BUILD_META_TEXTS_ZH = {
  version: (version: string) => `v${version}`,
  versionHint: (build: BuildMeta) =>
    `代码版本 ${build.sha}${build.branch ? `（分支 ${build.branch}）` : ''}${
      build.published_at ? `，部署于 ${build.published_at}` : ''
    }`,
  commit: (time: string) => `提交 ${time}`,
  commitHint: (raw: string | null | undefined) => `最后一次提交时间 ${raw || '未知'}`,
  sync: (time: string) => `同步 ${time}`,
  syncHint: (at: string, asof: string | null | undefined) =>
    `页面数据载入 ${at}；库内最新交易日 ${asof || '未知'}`,
}

export interface BuildMetaStripProps {
  build: BuildMeta | null
  /** 页面数据载入时间（epoch ms）；未载入时为空，那一项不显示 */
  syncAt?: number | null
  /** 库内最新交易日（``market-table`` 的 asof），只在悬停说明里出现 */
  asof?: string | null
}

export function BuildMetaStrip({ build, syncAt, asof }: BuildMetaStripProps) {
  const version = (build?.sha || '').trim()
  const commit = formatDateTime(build?.commit_time)
  const syncIso = typeof syncAt === 'number' && syncAt > 0 ? new Date(syncAt).toISOString() : null
  const sync = formatDateTime(syncIso)

  if (!version && !commit && !sync) return null

  return (
    <span
      data-fork-build-meta
      className="ml-auto flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-none text-muted-foreground/60"
    >
      {version && (
        <span data-fork-build-version title={BUILD_META_TEXTS_ZH.versionHint(build as BuildMeta)}>
          {BUILD_META_TEXTS_ZH.version(version)}
        </span>
      )}
      {commit && (
        <span data-fork-build-commit title={BUILD_META_TEXTS_ZH.commitHint(build?.commit_time)}>
          {BUILD_META_TEXTS_ZH.commit(commit)}
        </span>
      )}
      {sync && (
        <span data-fork-build-sync title={BUILD_META_TEXTS_ZH.syncHint(sync, asof)}>
          {BUILD_META_TEXTS_ZH.sync(sync)}
        </span>
      )}
    </span>
  )
}

export default BuildMetaStrip
