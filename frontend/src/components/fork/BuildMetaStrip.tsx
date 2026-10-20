import type { ReactNode } from 'react'

/**
 * fork：分析页工具条第一行右端的元信息（用户指定）。
 *
 * 第 7 条（2026-10-20 晚）把它从**三段分开的文字**合并成**一个文本框**：
 *
 *   数据时间：2026-10-20 17:00:26 ｜ 代码版本：e669fbad ｜ 部署时间：2026-10-20 19:42:06
 *
 * 悬停提示也合并成一段多行文本（不再是三个各自的小提示）：
 *
 *   数据时间：2026-10-20 17:00:26（交易日 2026-10-20）
 *   代码版本：e669fbad（分支 analysis-20261019）
 *   部署时间：2026-10-20 19:42:06
 *
 * - **数据时间**来自 ``GET /api/stocks/market-meta`` 的 ``data_synced_at`` ——
 *   行情库最后一次同步的时刻（管道 ``sync_log`` 里 ``stock_daily`` 那条成功记录），
 *   不是页面载入时间。
 * - **代码版本 / 部署时间**同接口的 ``sha`` / ``published_at``（部署时写下的
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
  dataTime: '数据时间',
  version: '代码版本',
  deploy: '部署时间',
  /** 可见文本的分隔符（一行里三段，顺序固定） */
  separator: ' ｜ ',
  /** 悬停提示：一行一项，换行显示 */
  tip: (lines: string[]) => lines.join('\n'),
  dataLine: (stamp: string, tradeDate: string | null | undefined) =>
    `数据时间：${stamp}${tradeDate ? `（交易日 ${tradeDate}）` : ''}`,
  versionLine: (build: BuildMeta) =>
    `代码版本：${(build.sha || '').trim()}${build.branch ? `（分支 ${build.branch}）` : ''}`,
  deployLine: (stamp: string) => `部署时间：${stamp}`,
}

export interface BuildMetaStripProps {
  build: BuildMeta | null
}

export function BuildMetaStrip({ build }: BuildMetaStripProps) {
  const version = (build?.sha || '').trim()
  const dataTime = formatLocalStamp(build?.data_synced_at)
  const deploy = formatLocalStamp(build?.published_at)
  // 老部署的 BUILD_INFO 里没有 published_at 时用最后提交时间兜住「这是哪版」这一项
  const deployStamp = deploy || formatLocalStamp(build?.commit_time)

  if (!dataTime && !version && !deployStamp) return null

  // 可见文本：三段合成一句，缺哪段就跳过哪段（顺序固定）
  const parts: string[] = []
  const tipLines: string[] = []
  if (dataTime) {
    parts.push(`${BUILD_META_TEXTS_ZH.dataTime}：${dataTime}`)
    tipLines.push(BUILD_META_TEXTS_ZH.dataLine(dataTime, build?.data_trade_date))
  }
  if (version) {
    parts.push(`${BUILD_META_TEXTS_ZH.version}：${version}`)
    tipLines.push(BUILD_META_TEXTS_ZH.versionLine(build as BuildMeta))
  }
  if (deployStamp) {
    parts.push(`${BUILD_META_TEXTS_ZH.deploy}：${deployStamp}`)
    tipLines.push(BUILD_META_TEXTS_ZH.deployLine(deployStamp))
  }

  const text: ReactNode = parts.join(BUILD_META_TEXTS_ZH.separator)

  return (
    <span
      data-fork-build-meta
      title={BUILD_META_TEXTS_ZH.tip(tipLines)}
      className="ml-auto shrink-0 whitespace-nowrap rounded border border-border/60 px-1.5 py-0.5 text-[11px] leading-tight text-muted-foreground/70"
    >
      {text}
    </span>
  )
}

export default BuildMetaStrip
