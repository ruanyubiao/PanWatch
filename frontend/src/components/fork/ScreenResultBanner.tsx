import { Filter, X } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { SCREEN_PRESET_TEXTS_ZH } from '@/lib/screen-presets'
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
 * 它只说三件事：**筛出多少只**、**数据是什么时候的 / 算了多少只 / 几只数据不足 /
 * 花了多久**、以及**用了什么条件**（第二行截断，悬停看全文）。
 *
 * 按钮只剩两个（用户第 6 条 2026-10-20 晚）：
 *   - 「修改条件」→ 打开条件选股弹窗（带回这次的条件）
 *   - 「退出选股」→ 回到全市场
 *
 * 「保存条件」与「重新选股」两个按钮**从横幅上删掉了**：「保存」挪进条件选股弹窗
 * 底部（保存的是草稿，不必先跑结果）；「重新选股」与工具条上的「刷新」完全等价
 * （`handleRefresh` 在选股结果生效时就是重跑同一条规则），留着是两个按钮一个作用。
 *
 * 「退出选股」不重新请求 —— 表格自己留着全量数据（`sourceRows=null` 就切回
 * 那份缓存），所以退出是瞬时的。
 */

const T = SCREEN_TEXTS_ZH

export function ScreenResultBanner({
  response,
  request,
  onEdit,
  onExit,
  savedName = null,
}: {
  response: ScreenResponse
  request: ScreenRequest
  onEdit: () => void
  onExit: () => void
  /** 当前结果对应的已保存条件名（从已保存条件跑出来的才有，纯提示） */
  savedName?: string | null
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
          {savedName ? (
            <span className="text-[11px] text-muted-foreground" data-fork-screen-banner-saved>
              {SCREEN_PRESET_TEXTS_ZH.summary(savedName)}
            </span>
          ) : null}
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

export default ScreenResultBanner
