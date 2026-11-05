import { useEffect, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { fetchAPI } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { getCurrentLocale } from '@/i18n'
import type { MarketStatus } from '@/components/MarketCalendarStatus'

/**
 * fork 专用：交易日历面板（直接嵌在首页里，常显）
 *
 * 上游的 MarketCalendarStatus 是一个悬停/点击才弹出的 Popover：它自己渲染的
 * 「A股 已收盘 港股 已收盘 美股 盘前」那一行就是 PopoverTrigger。用户要求
 * 首页去掉那一行、直接把弹窗内容铺在页面上，所以在 fork 里复制出这个组件：
 * 内容与上游 PopoverContent 逐行一致（同样的 i18n key、同样的 3 张状态卡 +
 * 未来 14 天表 + 页脚说明），只是不再有 Popover 触发器。
 *
 * 为什么不给上游组件加个 prop 控制：那会改上游文件。fork 的纪律是上游文件
 * 只做「一行级别」的改动，独立组件让 `git merge upstream/main` 保持零冲突。
 * 代价是上游改这个弹窗的样式时这里不会自动跟随——需要时手工同步。
 */

interface CalendarDay {
  date: string
  is_trading_day: boolean | null
  reason: string
  session_times: { open: string; close: string }[]
}

interface TradingCalendars {
  timezone: string
  markets: {
    market: string
    status: string
    next_open: string | null
    local_date: string
    local_time: string
    timezone: string
    days: CalendarDay[]
  }[]
}

/** 与上游 MarketCalendarStatus 内的同名实现保持一致。 */
function calendarTime(instant: string, timezone: string, locale: string) {
  const date = new Date(instant)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const part = (type: string) => parts.find(value => value.type === type)?.value
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    shortDate: `${part('month')}/${part('day')}`,
    clock: new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  }
}

const statusDot = (status: string) =>
  status === 'trading'
    ? 'bg-emerald-500'
    : ['pre_market', 'break'].includes(status)
      ? 'bg-amber-500'
      : 'bg-slate-400'

const columns = 'grid grid-cols-[64px_repeat(3,minmax(0,1fr))] sm:grid-cols-[80px_repeat(3,minmax(0,1fr))]'

export function MarketCalendarPanel({
  markets,
  labelMarket,
  days = 14,
}: {
  markets: MarketStatus[]
  labelMarket: (code: string) => string
  days?: number
}) {
  const { t } = useTranslation('configuration')
  const [data, setData] = useState<TradingCalendars | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const locale = getCurrentLocale()
  // 状态变化时重取一次（与上游 Popover 打开时的依赖一致）
  const calendarState = markets.map(market => `${market.code}:${market.local_date}:${market.status}`).join('|')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    fetchAPI<TradingCalendars>(
      `/stocks/markets/calendar?days=${days}&timezone=${encodeURIComponent(timezone)}`,
      { signal: controller.signal },
    )
      .then(value => { if (!controller.signal.aborted) setData(value) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [calendarState, timezone, retry, days])

  const weekday = (date: string) =>
    new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
      .format(new Date(`${date}T12:00:00Z`))

  const sessionLabel = (instant: string, day: string) => {
    const value = calendarTime(instant, timezone, locale)
    const offset = Math.round((Date.parse(value.date) - Date.parse(day)) / 86400000)
    if (offset === 0) return value.clock
    if (offset === 1) return t('stocksPage.calendar.nextDay', { time: value.clock })
    if (offset === -1) return t('stocksPage.calendar.previousDay', { time: value.clock })
    return `${value.shortDate} ${value.clock}`
  }

  const timezoneLabel = timezone === 'Asia/Shanghai' ? t('stocksPage.calendar.beijing') : timezone

  return (
    <div aria-label={t('stocksPage.calendar.title')}>
      <div className="flex shrink-0 items-center gap-3 pb-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <CalendarDays className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm">{t('stocksPage.calendar.title')}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t('stocksPage.calendar.displayTimezone', { timezone: timezoneLabel })}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">{t('stocksPage.calendar.loading')}</p>
      ) : error ? (
        <div className="text-xs">
          <p>{t('stocksPage.calendar.error')}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setRetry(value => value + 1)}>
            {t('stocksPage.calendar.retry')}
          </Button>
        </div>
      ) : data ? (
        <>
          <div className="grid shrink-0 grid-cols-3 gap-2 pb-4 sm:gap-3">
            {data.markets.map(market => {
              const next = market.next_open ? calendarTime(market.next_open, timezone, locale) : null
              const live = markets.find(value => value.code === market.market)
              const status = live?.status ?? market.status
              const localDate = live?.local_date ?? market.local_date
              const localTime = live?.local_time ?? market.local_time
              return (
                <div key={market.market} className="min-w-0 rounded-xl border border-border/70 bg-muted/20 p-2.5 sm:p-3">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="text-xs font-medium">{labelMarket(market.market)}</span>
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <span className={`h-1 w-1 rounded-full ${statusDot(status)}`} />
                      {t(`stocksPage.marketStatus.${status}`, { defaultValue: status })}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] tabular-nums text-muted-foreground" title={live?.timezone ?? market.timezone}>
                    {t('stocksPage.calendar.localDate', { date: localDate?.slice(5).replace('-', '/'), time: localTime })}
                  </p>
                  <p className="mt-3 text-[10px] text-muted-foreground">{t('stocksPage.calendar.nextOpen')}</p>
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5 text-sm font-semibold tabular-nums tracking-tight">
                    {next ? (
                      <>
                        <span>{next.shortDate}</span>
                        <span>{next.clock}</span>
                      </>
                    ) : (
                      <span className="text-xs font-normal text-muted-foreground">{t('stocksPage.calendar.pending')}</span>
                    )}
                  </p>
                </div>
              )
            })}
          </div>

          <div className="flex min-h-0 flex-col border-t border-border/60" role="table" aria-label={t('stocksPage.calendar.title')}>
            <div className={`${columns} shrink-0 items-center border-b border-border/60 bg-muted/30 px-3 py-2.5 text-[11px] font-medium text-muted-foreground sm:px-5`} role="row">
              <span role="columnheader">{t('stocksPage.calendar.date')}</span>
              {data.markets.map(market => (
                <span className="text-center" key={market.market} role="columnheader">{labelMarket(market.market)}</span>
              ))}
            </div>
            <div className="min-h-0 max-h-[340px] overflow-y-auto overscroll-contain scrollbar" role="rowgroup">
              {data.markets[0]?.days.map((day, index) => (
                <div key={day.date} role="row" className={`${columns} items-center border-b border-border/40 px-3 py-3 last:border-b-0 hover:bg-muted/20 sm:px-5`}>
                  <div role="cell">
                    <p className="text-xs font-medium tabular-nums">{day.date.slice(5).replace('-', '/')}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">{weekday(day.date)}</p>
                  </div>
                  {data.markets.map(market => {
                    const current = market.days[index]
                    return (
                      <div key={market.market} role="cell" className="text-center">
                        <p className={`text-[11px] ${current.is_trading_day ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground/70'}`}>
                          {t(`stocksPage.calendar.reasons.${current.reason}`, { defaultValue: current.reason })}
                        </p>
                        {current.session_times.map(session => (
                          <p key={session.open} className="mt-1 text-[10px] leading-relaxed text-muted-foreground tabular-nums whitespace-nowrap">
                            {sessionLabel(session.open, day.date)} – {sessionLabel(session.close, day.date)}
                          </p>
                        ))}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      <div className="shrink-0 border-t border-border/60 bg-muted/10 pt-3 text-[10px] leading-relaxed text-muted-foreground">
        <p>{t('stocksPage.calendar.statusRule')}</p>
        <p className="mt-0.5 text-muted-foreground/70">{t('stocksPage.calendar.source')}</p>
      </div>
    </div>
  )
}
