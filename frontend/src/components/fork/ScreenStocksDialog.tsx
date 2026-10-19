import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Loader2 } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Switch } from '@panwatch/base-ui/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import {
  SCREEN_MARKETS,
  SCREEN_TEXTS_ZH,
  addChild,
  countConditions,
  countConditionsIn,
  createCondition,
  createDefaultRequest,
  createGroup,
  duplicateNode,
  findConflictGroup,
  findNode,
  formatRule,
  removeNode,
  requiredBarsOf,
  toApiRequest,
  treeDepth,
  updateNode,
  validateScreenRequest,
  type GroupNode,
  type LogicOperator,
  type RuleNode,
  type ScreenRequest,
  type ScreenResponse,
  type ScreenMarket,
  type ValidationIssue,
} from '@/lib/screen-rule'
import { ScreenConditionGroup, type ScreenTreeHandlers } from '@/components/fork/ScreenConditionGroup'
import { screenStocks } from '@/lib/screen-api'

/**
 * fork 专用：条件选股弹窗（需求规格 §5.2 / §5.3 / §5.4 / §6）。
 *
 * 状态全部在**草稿**里：`initialRequest` 只在打开时读一次（「修改条件」用它恢复
 * 上次的设置），编辑过程中不碰页面上的选股结果 —— 只有点「开始选股」成功，
 * 才通过 `onResult(resp, req)` 把结果交给页面。所以「取消 / 请求失败」都不会
 * 让分析页的表格发生任何变化。
 *
 * 数字输入用字符串保存在草稿里（`daysText` 等）：受控 number input 一旦把
 * 空串转成 0，「清空重输」就会卡成 `0`。提交前统一 `Number()`。
 */

const T = SCREEN_TEXTS_ZH

interface DraftForm {
  daysText: string
  capMinText: string
  capMaxText: string
  markets: ScreenMarket[]
  includeSt: boolean
  rule: GroupNode
}

function toDraft(request: ScreenRequest): DraftForm {
  return {
    daysText: String(request.trading_days),
    capMinText: String(request.market_cap.min_yi),
    capMaxText: String(request.market_cap.max_yi),
    markets: [...request.markets],
    includeSt: request.include_st,
    rule: stripCollapsed(request.rule),
  }
}

function stripCollapsed(node: GroupNode): GroupNode {
  return {
    ...node,
    children: node.children.map(child =>
      child.type === 'group' ? stripCollapsed(child) : child,
    ),
  }
}

function toRequest(form: DraftForm): ScreenRequest {
  return {
    trading_days: Number(form.daysText),
    markets: [...form.markets],
    include_st: form.includeSt,
    market_cap: { min_yi: Number(form.capMinText), max_yi: Number(form.capMaxText) },
    rule: form.rule,
  }
}

export function ScreenStocksDialog({
  open,
  onOpenChange,
  initialRequest,
  asof,
  onResult,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialRequest?: ScreenRequest | null
  asof?: string | null
  onResult: (response: ScreenResponse, request: ScreenRequest) => void
}) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [form, setForm] = useState<DraftForm>(() => toDraft(initialRequest ?? createDefaultRequest()))
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 每次打开都用最新的 initialRequest（「修改条件」要把上次的请求原样带回）
  useEffect(() => {
    if (open) {
      setForm(toDraft(initialRequest ?? createDefaultRequest()))
      setIssues([])
      setSubmitted(false)
      setSubmitting(false)
      setError(null)
    }
  }, [open, initialRequest])

  const request = useMemo(() => toRequest(form), [form])
  const liveIssues = useMemo(() => validateScreenRequest(request), [request])
  const shownIssues = submitted ? liveIssues : issues
  const preview = useMemo(() => formatRule(form.rule), [form.rule])
  const conflict = useMemo(() => findConflictGroup(form.rule), [form.rule])
  const bars = useMemo(() => requiredBarsOf(request), [request])
  const conditions = countConditions(form.rule)
  const depth = treeDepth(form.rule)

  const setRule = useCallback((rule: GroupNode) => setForm(current => ({ ...current, rule })), [])

  const handlers: ScreenTreeHandlers = useMemo(
    () => ({
      addCondition: (groupId, name, params) => {
        const node = createCondition(name)
        setRule(addChild(form.rule, groupId, { ...node, params } as RuleNode))
      },
      addGroup: groupId => setRule(addChild(form.rule, groupId, createGroup('AND'))),
      setOperator: (groupId, operator: LogicOperator) =>
        setRule(updateNode(form.rule, groupId, node => (node.type === 'group' ? { ...node, operator } : node))),
      toggleCollapse: groupId =>
        setRule(
          updateNode(form.rule, groupId, node =>
            node.type === 'group' ? { ...node, collapsed: !node.collapsed } : node,
          ),
        ),
      removeGroup: groupId => {
        const node = findNode(form.rule, groupId)
        if (!node) return
        const count = countConditionsIn(node)
        if (count === 0) {
          setRule(removeNode(form.rule, groupId))
          return
        }
        void askConfirm(T.deleteGroupConfirm(count), { destructive: true, title: T.deleteGroupTitle }).then(ok => {
          if (ok) setRule(removeNode(form.rule, groupId))
        })
      },
      updateCondition: (conditionId, params) =>
        setRule(
          updateNode(form.rule, conditionId, node =>
            node.type === 'condition' ? ({ ...node, params } as RuleNode) : node,
          ),
        ),
      duplicateCondition: conditionId => setRule(duplicateNode(form.rule, conditionId)),
      removeCondition: conditionId => setRule(removeNode(form.rule, conditionId)),
    }),
    [askConfirm, form.rule, setRule],
  )

  const toggleMarket = (market: ScreenMarket) => {
    setForm(current => {
      const selected = current.markets.includes(market)
      const next = selected
        ? current.markets.filter(item => item !== market)
        : [...current.markets, market]
      // 保持 SCREEN_MARKETS 的顺序（请求里顺序无所谓，但 UI 与预览要稳定）
      return { ...current, markets: SCREEN_MARKETS.filter(item => next.includes(item)) }
    })
  }

  const allSelected = form.markets.length === SCREEN_MARKETS.length
  const noneSelected = form.markets.length === 0

  const handleSubmit = async () => {
    setSubmitted(true)
    setIssues(liveIssues)
    if (liveIssues.length > 0) {
      // 焦点移到第一处错误：字段用 data-screen-field 标记，节点用 data-node-id
      const first = liveIssues[0]
      const selector = first.nodeId ? `[data-node-id="${first.nodeId}"]` : `[data-screen-field="${first.path}"]`
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(selector)?.focus?.()
      }, 0)
      return
    }
    const payload = toApiRequest(request)
    const controller = new AbortController()
    abortRef.current = controller
    const timer = window.setTimeout(() => controller.abort(), 60000)
    setSubmitting(true)
    setError(null)
    try {
      const response = await screenStocks(payload, controller.signal)
      toast(T.success(response.total), 'success')
      onResult(response, payload)
      onOpenChange(false)
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc)
      // 弹窗不关、表格不变：用户可以直接再点一次「开始选股」
      setError(T.failed(message))
    } finally {
      window.clearTimeout(timer)
      abortRef.current = null
      setSubmitting(false)
    }
  }

  const handleCancel = () => {
    if (submitting && abortRef.current) abortRef.current.abort()
    onOpenChange(false)
  }

  const formDisabled = submitting

  return (
    <Dialog open={open} onOpenChange={next => (next ? onOpenChange(true) : handleCancel())}>
      <DialogContent className="max-w-3xl" data-fork-screen-dialog>
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>{T.description}</DialogDescription>
        </DialogHeader>

        <fieldset disabled={formDisabled} className="space-y-3 disabled:opacity-60">
          {/* 基础筛选：先在 MySQL 里过滤，和条件树是「且」 */}
          <div className="rounded-lg border border-border/60 bg-accent/10 p-3">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-foreground">{T.baseTitle}</span>
              <span className="text-[10px] text-muted-foreground">{T.baseHint}</span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{T.tradingDays}</Label>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={1}
                    max={250}
                    className="h-7 w-20 text-[12px] font-mono"
                    data-screen-field="trading_days"
                    value={form.daysText}
                    onChange={event => setForm(current => ({ ...current, daysText: event.target.value }))}
                  />
                  <span className="text-[11px] text-muted-foreground">{T.tradingDaysSuffix}</span>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{T.marketCap}</Label>
                <div className="flex items-center gap-1">
                  <span className="text-[11px] text-muted-foreground">{T.capMin}</span>
                  <Input
                    type="number"
                    className="h-7 w-24 text-[12px] font-mono"
                    data-screen-field="market_cap.min_yi"
                    value={form.capMinText}
                    onChange={event => setForm(current => ({ ...current, capMinText: event.target.value }))}
                  />
                  <span className="text-[11px] text-muted-foreground">{T.capMax}</span>
                  <Input
                    type="number"
                    className="h-7 w-24 text-[12px] font-mono"
                    data-screen-field="market_cap.max_yi"
                    value={form.capMaxText}
                    onChange={event => setForm(current => ({ ...current, capMaxText: event.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">{T.st}</Label>
                <div className="flex h-7 items-center gap-1.5">
                  <Switch
                    checked={form.includeSt}
                    aria-label={T.includeSt}
                    data-screen-field="include_st"
                    onCheckedChange={checked => setForm(current => ({ ...current, includeSt: checked }))}
                  />
                  <span className="text-[11px] text-muted-foreground">{T.includeSt}</span>
                </div>
              </div>
            </div>

            <div className="mt-2 space-y-1">
              <Label className="text-[11px] text-muted-foreground">{T.market}</Label>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label={T.market}>
                <button
                  type="button"
                  aria-pressed={allSelected ? true : noneSelected ? false : 'mixed'}
                  aria-label={T.marketAll}
                  data-fork-screen-market-all
                  onClick={() =>
                    setForm(current => ({
                      ...current,
                      markets: allSelected ? [] : [...SCREEN_MARKETS],
                    }))
                  }
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                    allSelected
                      ? 'border-primary/60 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span
                    className="flex h-2.5 w-2.5 items-center justify-center rounded-[2px] border border-current/60 text-[8px] leading-none"
                    aria-hidden
                  >
                    {allSelected ? '✓' : noneSelected ? '' : '–'}
                  </span>
                  {T.marketAll}
                </button>
                {SCREEN_MARKETS.map(market => {
                  const label = {
                    sh: '上证',
                    sz: '深证',
                    cyb: '创业',
                    kcb: '科创',
                  }[market]
                  const selected = form.markets.includes(market)
                  return (
                    <button
                      key={market}
                      type="button"
                      aria-pressed={selected}
                      data-fork-screen-market={market}
                      onClick={() => toggleMarket(market)}
                      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                        selected
                          ? 'border-primary/60 bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      <span
                        className="flex h-2.5 w-2.5 items-center justify-center rounded-[2px] border border-current/60 text-[8px] leading-none"
                        aria-hidden
                      >
                        {selected ? '✓' : ''}
                      </span>
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* 条件树 */}
          <div className="rounded-lg border border-border/60 p-3">
            <div className="mb-1 text-[12px] font-medium text-foreground">{T.ruleTitle}</div>
            <ScreenConditionGroup
              node={form.rule}
              depth={1}
              isRoot
              tradingDays={Number(form.daysText) || 1}
              handlers={handlers}
              issues={shownIssues}
              submitted={submitted}
            />
          </div>

          {/* 规则预览 */}
          <div className="space-y-1">
            <div className="text-[11px] text-muted-foreground">{T.previewTitle}</div>
            <div
              className="rounded-md border border-dashed border-border px-2 py-1.5 font-mono text-[11px] text-foreground"
              data-fork-screen-preview
            >
              {preview}
            </div>
            {conflict ? <div className="text-[11px] text-muted-foreground">{T.conflictHint}</div> : null}
          </div>
        </fieldset>

        {shownIssues.length > 0 ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive" data-fork-screen-issues>
            {T.issueSummary(shownIssues.length)}
            {shownIssues.map(issue => (issue.nodeId ? `（${issue.nodeId}）` : '') + issue.message).join('；')}
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive" data-fork-screen-error>
            {error}
          </div>
        ) : null}

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] text-muted-foreground" data-fork-screen-meta>
            {asof
              ? T.footerMeta(asof, bars, conditions, depth)
              : T.footerMetaNoAsOf(bars, conditions, depth)}
          </div>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={handleCancel}>
              {T.cancel}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-[12px]"
              disabled={submitting || (submitted && liveIssues.length > 0)}
              onClick={() => void handleSubmit()}
              data-fork-screen-submit
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Filter className="h-3.5 w-3.5" />}
              {submitting ? T.submitting : T.submit}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
