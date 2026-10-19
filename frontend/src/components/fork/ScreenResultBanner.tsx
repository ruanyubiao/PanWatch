import { Filter, RefreshCw, X } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  SCREEN_TEXTS_ZH,
  formatRule,
  summarizeBase,
  type ScreenRequest,
  type ScreenResponse,
} from '@/lib/screen-rule'

/**
 * fork 专用：分析页的「选股结果」横幅（需求规格 §5.5）。
 *
 * 放在筛选行和表格之间。它只说三件事：**筛出多少只**、**数据是什么时候的 /
 * 算了多少只 / 几只数据不足 / 花了多久**、以及**用了什么条件**（第二行截断，
 * 悬停看全文）。三个按钮分别对应「改条件」「用同一请求再跑」「回到全市场」。
 *
 * 「退出选股」不重新请求 —— 表格自己留着全量数据（`sourceRows=null` 就切回
 * 那份缓存），所以退出是瞬时的。
 */

const T = SCREEN_TEXTS_ZH

export function ScreenResultBanner({
  response,
  request,
  rerunning = false,
  onEdit,
  onRerun,
  onExit,
}: {
  response: ScreenResponse
  request: ScreenRequest
  rerunning?: boolean
  onEdit: () => void
  onRerun: () => void
  onExit: () => void
}) {
  const seconds = (response.stats.elapsed_ms / 1000).toFixed(1)
  const line2 = `${summarizeBase(request)} ｜ ${formatRule(request.rule)}`

  return (
    <div
      className="mb-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
      data-fork-screen-banner
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12px] font-medium text-foreground">
          {T.bannerTitle(response.total)}
        </span>
        <span className="text-[11px] text-muted-foreground" data-fork-screen-banner-meta>
          {T.bannerMeta(
            response.asof ?? '—',
            response.stats.candidates,
            response.stats.insufficient,
            seconds,
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-[12px]"
            onClick={onEdit}
            data-fork-screen-edit
          >
            <Filter className="h-3.5 w-3.5" /> {T.editRule}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2 text-[12px]"
            onClick={onRerun}
            disabled={rerunning}
            data-fork-screen-rerun
          >
            <RefreshCw className={`h-3.5 w-3.5 ${rerunning ? 'animate-spin' : ''}`} /> {T.rerun}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={onExit}
            data-fork-screen-exit
          >
            <X className="h-3.5 w-3.5" /> {T.exit}
          </Button>
        </div>
      </div>
      <div
        className="mt-1 truncate text-[11px] text-muted-foreground"
        title={line2}
        data-fork-screen-banner-rule
      >
        {line2}
      </div>
    </div>
  )
}
