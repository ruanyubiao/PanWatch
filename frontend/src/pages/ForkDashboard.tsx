import { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Newspaper, RefreshCw } from 'lucide-react'
import { dashboardApi, fetchAPI, type DashboardBrief } from '@panwatch/api'
import { MarketCalendarPanel } from '@/components/fork/MarketCalendarPanel'
import type { MarketStatus } from '@/components/MarketCalendarStatus'
import { useTranslation } from 'react-i18next'

/**
 * fork 专用首页（ForkDashboard）
 *
 * 与上游 Dashboard.tsx 的唯一差别：只保留「收盘复盘」(eod 简报) 一张卡片。
 * 上游首页的组合速览条、指数走势、今日要紧事、组合体检、机会精选、
 * DiscoveryPanel、各类分享图弹窗，这里一律不渲染。
 *
 * 为什么单独建文件而不是裁剪 Dashboard.tsx：上游首页改动频繁，
 * 独立组件让 `git merge upstream/main` 保持零冲突。
 * App.tsx 里把 "/" 指向本组件即可（那里只有一行改动）。
 */
export default function ForkDashboardPage() {
  // 命名空间是 configuration（上游 dashboard 文案都在这个 ns 下）
  const { t } = useTranslation(['configuration', 'common'])
  const [brief, setBrief] = useState<DashboardBrief | null>(null)
  const [briefOpen, setBriefOpen] = useState(true)
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null)
  // fork：交易日历（原本挂在分析页「市场状态」上，鼠标悬停才弹出）
  const [marketStatus, setMarketStatus] = useState<MarketStatus[]>([])

  useEffect(() => {
    const controller = new AbortController()
    fetchAPI<MarketStatus[]>('/stocks/markets/status', { signal: controller.signal })
      .then(list => {
        if (!controller.signal.aborted) setMarketStatus(list || [])
      })
      .catch(() => {
        if (!controller.signal.aborted) setMarketStatus([])
      })
    return () => controller.abort()
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    dashboardApi
      .brief('eod')
      .then(value => setBrief(value && !value.empty ? value : null))
      .catch(() => setBrief(null))
      .finally(() => {
        setLoading(false)
        setRefreshedAt(new Date())
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const briefLabel = t('dashboardRuntime.briefTypes.eod', { defaultValue: '收盘复盘' })

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="card p-5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h1 className="flex items-center gap-2 text-[15px] font-semibold">
            <Newspaper className="h-4 w-4 text-primary" />
            {briefLabel}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {refreshedAt && (
              <span className="text-[11px] text-muted-foreground">
                {refreshedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
            {brief?.date && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                AI · {brief.date}
              </span>
            )}
            {brief?.content && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setBriefOpen(v => !v)}
              >
                {briefOpen
                  ? t('dashboard.collapse', { defaultValue: '收起' })
                  : t('dashboard.expand', { defaultValue: '展开' })}
              </button>
            )}
            <button
              type="button"
              onClick={load}
              disabled={loading}
              title={t('common:actions.refresh', { defaultValue: '刷新' })}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {brief ? (
          <>
            {brief.title && (
              <div className="text-[14.5px] font-semibold text-foreground">{brief.title}</div>
            )}
            {briefOpen && brief.content && (
              <div className="prose prose-sm dark:prose-invert mt-2 max-w-none break-words text-[12.5px] [&_p]:my-1 [&_ul]:my-1 [&_li]:my-0.5">
                <ReactMarkdown>{brief.content}</ReactMarkdown>
              </div>
            )}
          </>
        ) : (
          <div className="py-10 text-center">
            <div className="text-[13px] text-muted-foreground">
              {loading
                ? t('common:actions.loading', { defaultValue: '加载中…' })
                : t('dashboardRuntime.briefEmpty', { defaultValue: '暂无收盘复盘内容' })}
            </div>
            {!loading && (
              <div className="mt-2 text-[11px] text-muted-foreground/70">
                {t('dashboardRuntime.briefEmptyHint', {
                  defaultValue: '收盘复盘由「盘后简报」任务生成，可在设置里配置 AI 模型后等待调度执行。',
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* fork：交易日历（紧跟在「收盘复盘」之后）。
          用户要求：去掉上游那行「A股 已收盘 港股 已收盘 美股 盘前」的悬停触发器，
          把原来的弹窗内容直接铺在首页上（MarketCalendarPanel，fork 自有组件）。 */}
      {marketStatus.length > 0 && (
        <div className="card mt-4 p-4">
          <MarketCalendarPanel
            markets={marketStatus}
            labelMarket={code => (code === 'CN' ? 'A 股' : code === 'HK' ? '港股' : code === 'US' ? '美股' : code)}
          />
        </div>
      )}
    </div>
  )
}
