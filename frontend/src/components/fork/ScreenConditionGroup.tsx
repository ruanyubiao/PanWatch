import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  MAX_DEPTH,
  SCREEN_TEXTS_ZH,
  type ConditionName,
  type ConditionParamsMap,
  type GroupNode,
  type LogicOperator,
  type ValidationIssue,
} from '@/lib/screen-rule'
import { ScreenConditionPicker } from '@/components/fork/ScreenConditionPicker'
import { ScreenConditionRow } from '@/components/fork/ScreenConditionRow'

/**
 * fork 专用：条件组的递归渲染（需求规格 §5.2 第 3 条 / §6.2）。
 *
 * 每条规则都是刻意的：
 * - 「+ 条件组」到第 5 层禁用（悬停给原因），不是点了再报错；
 * - 删除**非空**子组要二次确认（在弹窗里用 `useConfirm`），空的直接删；
 * - 兄弟节点之间用小字标出所在组的运算符 —— 光看每组的切换按钮，
 *   嵌套一深就看不出「这个条件是跟谁 AND」；
 * - 任何编辑都**不自动**改写树结构（不合并单子节点组、不提升层级），
 *   用户怎么搭就怎么算。
 */

const T = SCREEN_TEXTS_ZH

export interface ScreenTreeHandlers {
  addCondition: (groupId: string, name: ConditionName, params: ConditionParamsMap[ConditionName]) => void
  addGroup: (groupId: string) => void
  setOperator: (groupId: string, operator: LogicOperator) => void
  toggleCollapse: (groupId: string) => void
  removeGroup: (groupId: string) => void
  updateCondition: (conditionId: string, params: ConditionParamsMap[ConditionName]) => void
  duplicateCondition: (conditionId: string) => void
  removeCondition: (conditionId: string) => void
}

const OR_COLOR = '#c2410c'

export function ScreenConditionGroup({
  node,
  depth,
  isRoot,
  tradingDays,
  handlers,
  issues,
  submitted,
}: {
  node: GroupNode
  depth: number
  isRoot: boolean
  tradingDays: number
  handlers: ScreenTreeHandlers
  issues: ValidationIssue[]
  submitted: boolean
}) {
  const collapsed = Boolean(node.collapsed)
  const canNest = depth < MAX_DEPTH
  const groupIssues = issues.filter(issue => issue.nodeId === node.id)
  const showEmptyError = submitted && !isRoot && node.children.length === 0

  return (
    <div
      className={isRoot ? '' : 'border-l-[3px] border-primary/55 bg-accent/18 pl-2'}
      data-fork-screen-group={node.id}
      data-depth={depth}
    >
      <div className="flex flex-wrap items-center gap-1.5 py-1">
        {isRoot ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            title={collapsed ? T.expand : T.collapse}
            aria-label={collapsed ? T.expand : T.collapse}
            onClick={() => handlers.toggleCollapse(node.id)}
          >
            {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        )}
        <span className="text-[11px] font-medium text-foreground">
          {isRoot ? T.rootGroup : T.subGroup}
        </span>
        <span className="text-[10px] text-muted-foreground">{T.level(depth)}</span>

        <div
          role="radiogroup"
          aria-label={T.ruleTitle}
          className="ml-1 inline-flex overflow-hidden rounded border border-border"
        >
          {(['AND', 'OR'] as LogicOperator[]).map(operator => {
            const active = node.operator === operator
            return (
              <button
                key={operator}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => handlers.setOperator(node.id, operator)}
                className={`px-1.5 py-0.5 text-[10px] transition-colors ${
                  active
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {operator === 'AND' ? T.andLabel : T.orLabel}
              </button>
            )
          })}
        </div>

        <ScreenConditionPicker
          tradingDays={tradingDays}
          onPick={(name, params) => handlers.addCondition(node.id, name, params)}
          trigger={
            /*
             * 文案本身就带「+」（T.addCondition = '+ 条件'），再放一个 Plus 图标
             * 就成了「+ + 条件」（用户反馈）。所以这里只用文字，不再加图标。
             */
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-primary"
              data-fork-screen-add-condition={node.id}
            >
              {T.addCondition}
            </Button>
          }
        />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-40"
          disabled={!canNest}
          title={canNest ? T.addGroup : T.maxDepthHint}
          onClick={() => handlers.addGroup(node.id)}
          data-fork-screen-add-group={node.id}
        >
          {T.addGroup}
        </Button>

        {isRoot ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="ml-auto h-6 w-6 text-muted-foreground hover:text-destructive"
            title={T.remove}
            aria-label={T.remove}
            onClick={() => handlers.removeGroup(node.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      {collapsed ? null : (
        <div className="space-y-1 pb-1">
          {node.children.length === 0 ? (
            <div
              className={`py-1 text-[11px] ${showEmptyError ? 'text-destructive' : 'text-muted-foreground/70'}`}
            >
              {isRoot ? T.emptyRoot : showEmptyError ? T.emptyGroupError : T.emptyGroup}
            </div>
          ) : (
            node.children.map((child, index) => (
              <div key={child.id}>
                {index > 0 ? (
                  <div
                    className="py-0.5 pl-1 text-[10px]"
                    style={{ color: node.operator === 'OR' ? OR_COLOR : undefined }}
                  >
                    {node.operator}
                  </div>
                ) : null}
                {child.type === 'group' ? (
                  <ScreenConditionGroup
                    node={child}
                    depth={depth + 1}
                    isRoot={false}
                    tradingDays={tradingDays}
                    handlers={handlers}
                    issues={issues}
                    submitted={submitted}
                  />
                ) : (
                  <ScreenConditionRow
                    node={child}
                    tradingDays={tradingDays}
                    error={issues.find(issue => issue.nodeId === child.id)?.message}
                    onUpdate={params => handlers.updateCondition(child.id, params)}
                    onDuplicate={() => handlers.duplicateCondition(child.id)}
                    onRemove={() => handlers.removeCondition(child.id)}
                  />
                )}
              </div>
            ))
          )}
          {groupIssues.length > 0 && !showEmptyError ? (
            <div className="text-[11px] text-destructive">{groupIssues[0].message}</div>
          ) : null}
        </div>
      )}
    </div>
  )
}
