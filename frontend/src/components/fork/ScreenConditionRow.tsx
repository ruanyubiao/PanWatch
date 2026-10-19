import { Copy, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  CONDITION_DEFS_ZH,
  SCREEN_TEXTS_ZH,
  formatNode,
  type ConditionName,
  type ConditionNode,
  type ConditionParamsMap,
} from '@/lib/screen-rule'
import { ScreenParamEditor } from '@/components/fork/ScreenParamEditor'

/**
 * fork 专用：条件树里的一行条件（需求规格 §5.2 第 3 条）。
 *
 * 一行里四件事：条件名、参数摘要（等宽字体 + `bg-secondary` 小块）、分类标签、
 * 编辑 / 复制 / 删除。参数摘要由注册表的 `summary()` 生成，和规则预览用的是
 * **同一个函数** —— 否则「行里写的」和「预览里写的」迟早会不一致。
 */

const T = SCREEN_TEXTS_ZH

export function ScreenConditionRow({
  node,
  tradingDays,
  error,
  onUpdate,
  onDuplicate,
  onRemove,
}: {
  node: ConditionNode
  tradingDays: number
  error?: string
  onUpdate: (params: ConditionParamsMap[ConditionName]) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const def = CONDITION_DEFS_ZH[node.name]
  return (
    <div
      className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
        error ? 'border-destructive/60' : 'border-border/60'
      }`}
      data-fork-screen-condition={node.name}
      data-node-id={node.id}
    >
      <span className="shrink-0 text-[12px] text-foreground">{def.label}</span>
      <span className="min-w-0 truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {formatNode(node)}
      </span>
      <span className="shrink-0 rounded bg-accent/40 px-1 py-0.5 text-[10px] text-muted-foreground">
        {def.category}
      </span>
      {error ? <span className="shrink-0 text-[11px] text-destructive">{error}</span> : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {Object.keys(def.defaults).length > 0 ? (
          <ScreenParamEditor
            name={node.name}
            value={node.params as ConditionParamsMap[ConditionName]}
            tradingDays={tradingDays}
            onConfirm={onUpdate}
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                title={T.edit}
                aria-label={T.edit}
              >
                <Pencil className="h-3 w-3" />
              </Button>
            }
          />
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          title={T.copy}
          aria-label={T.copy}
          onClick={onDuplicate}
        >
          <Copy className="h-3 w-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6 hover:text-destructive"
          title={T.remove}
          aria-label={T.remove}
          onClick={onRemove}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
