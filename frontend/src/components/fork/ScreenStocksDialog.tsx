import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Loader2, Save, Trash2 } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
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
  MAX_TRADING_DAYS,
  MIN_TRADING_DAYS,
  SCREEN_MARKETS,
  SCREEN_TEXTS_ZH,
  addChild,
  countConditions,
  countConditionsIn,
  createCondition,
  createGroup,
  duplicateNode,
  findConflictGroup,
  findNode,
  formatRule,
  migrateLegacyMarketCap,
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
import { cleanNumeric } from '@/components/fork/ScreenNumberField'
import {
  ScreenStepButtons,
  STEP_INPUT_CLASSES,
  stepValue,
  type StepDirection,
} from '@/components/fork/ScreenStepButtons'
import { ScreenConditionGroup, type ScreenTreeHandlers } from '@/components/fork/ScreenConditionGroup'
import { screenStocks } from '@/lib/screen-api'
import { SCREEN_PRESET_TEXTS_ZH } from '@/lib/screen-presets'

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
 *
 * 基础筛选的三个字段都是「标题 + 控件同一行」（用户反馈），且控件自身限死取值
 * 范围（`BaseNumberInput`：越界当场夹回边界，非法字符敲不进去）。
 *
 * 宽度：`max-w-[968px]`，比上游默认的 768px 宽 200px（用户反馈，条件树 + 参数浮层
 * 在 768px 里太挤）。
 */

const T = SCREEN_TEXTS_ZH

/**
 * 统计窗口默认值（交易日）。
 *
 * 用户要求恢复成 30，但**不要让它看起来像「已选中」**：值照填，焦点不给它
 * （见渲染处 `onOpenAutoFocus`），否则输入框一带上焦点描边，视觉上就是「选中的控件」。
 */
const DEFAULT_TRADING_DAYS = 30

interface DraftForm {
  daysText: string
  markets: ScreenMarket[]
  includeSt: boolean
  rule: GroupNode
  /** 窗口结束日（`YYYY-MM-DD`）；空 = 库里最新交易日 */
  asofText: string
  /**
   * 是否启用「窗口截止日」。
   *
   * 用户 2026-10-21 第 2 条：日期输入框后面加一个复选框 —— 不勾 = 不指定日期
   * （沿用「库里最新交易日」的规则），勾上才把填的日期交给后端推导交易日。
   * 不勾时输入框禁用、值清空（不参与校验、也不会提交）。
   */
  asofEnabled: boolean
}

/**
 * 打开时的草稿。
 *
 * `request === null` 表示「第一次打开」：统计窗口预填 30（默认值），但弹窗打开时
 * **不把焦点交给它**（见渲染处的 `onOpenAutoFocus`），所以它只是一格填好的数字，
 * 不会带着焦点描边出现。其余保持可用状态（四个市场全选、不含 ST、空根组）。
 * 「修改条件」传回上次的请求时按请求原样回填。
 */
function toDraft(request: ScreenRequest | null): DraftForm {
  if (!request) {
    return {
      daysText: String(DEFAULT_TRADING_DAYS),
      markets: [...SCREEN_MARKETS],
      includeSt: false,
      rule: createGroup('AND'),
      asofText: '',
      asofEnabled: false,
    }
  }
  return {
    daysText: String(request.trading_days),
    // 市场至少留一个（老请求里如果空着，退回「全部」）
    markets: request.markets.length ? [...request.markets] : [...SCREEN_MARKETS],
    includeSt: request.include_st,
    // 老条件文件里的基础市值区间 → 两条市值条件（见 migrateLegacyMarketCap）
    rule: migrateLegacyMarketCap({ ...request, rule: stripCollapsed(request.rule) }),
    asofText: request.asof ?? '',
    // 老请求带日期 = 用户当时指定过 → 勾上
    asofEnabled: Boolean(request.asof),
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

/** 窗口留空 → NaN：校验报「统计窗口需为 1–250 的整数」，不会被悄悄当成 0。 */
function daysOf(form: DraftForm): number {
  const text = form.daysText.trim()
  return text === '' ? Number.NaN : Number(text)
}

function toRequest(form: DraftForm): ScreenRequest {
  return {
    trading_days: daysOf(form),
    markets: [...form.markets],
    include_st: form.includeSt,
    // 总市值是条件列表里的一条条件，不再是基础筛选参数
    rule: form.rule,
    asof: form.asofEnabled && form.asofText.trim() !== '' ? form.asofText.trim() : null,
  }
}

/**
 * 基础筛选里的数字框（草稿里存的是**字符串**，所以不走 `ScreenNumberField`）。
 *
 * 只吃数字（整数场不吃小数点、负数只在 min < 0 时吃一个开头的负号），越界
 * 立刻夹回边界 —— 「由条件的限制，最好控件直接有限制，不让输入」。
 * 右侧带一对加减按钮（用户反馈：参照原生 number 的上下箭头），点一次 ±1，
 * 走的是同一条夹取逻辑；↑/↓ 键等价。
 */
function BaseNumberInput({
  text,
  min,
  max,
  integer = true,
  allowEmpty = false,
  screenField,
  ariaLabel,
  className = '',
  onText,
}: {
  text: string
  min: number
  max: number
  integer?: boolean
  allowEmpty?: boolean
  screenField: string
  ariaLabel: string
  className?: string
  onText: (text: string) => void
}) {
  const parsed = text.trim() === '' ? Number.NaN : Number(text)
  const stepBase = Number.isFinite(parsed) ? parsed : min

  const applyStep = (direction: StepDirection) => {
    onText(String(stepValue(parsed, direction, min, max, integer)))
  }

  return (
    <span className={`relative flex items-stretch ${className}`}>
      <input
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        data-screen-field={screenField}
        value={text}
        onChange={event => {
          const cleaned = cleanNumeric(event.target.value, integer, min < 0)
          // 空串 / 孤立负号：先留着（allowEmpty 时提交会被校验拦住）
          if (cleaned === '' || cleaned === '-' || cleaned === '.') {
            onText(cleaned)
            return
          }
          const parsedValue = Number(cleaned)
          if (!Number.isFinite(parsedValue)) {
            onText(cleaned)
            return
          }
          if (parsedValue < min) {
            onText(String(min))
            return
          }
          if (parsedValue > max) {
            onText(String(max))
            return
          }
          onText(cleaned)
        }}
        onBlur={() => {
          if (allowEmpty) return
          if (text.trim() === '' || text === '-' || text === '.') onText(String(min))
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowUp' && stepBase < max) {
            event.preventDefault()
            applyStep(1)
          } else if (event.key === 'ArrowDown' && stepBase > min) {
            event.preventDefault()
            applyStep(-1)
          }
        }}
        className={STEP_INPUT_CLASSES}
      />
      <ScreenStepButtons
        onStep={applyStep}
        canStepUp={stepBase < max}
        canStepDown={stepBase > min}
        label={ariaLabel}
      />
    </span>
  )
}

export function ScreenStocksDialog({
  open,
  onOpenChange,
  initialRequest,
  asof,
  onResult,
  presetName = null,
  onDeletePreset,
  onSavePreset,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialRequest?: ScreenRequest | null
  asof?: string | null
  onResult: (response: ScreenResponse, request: ScreenRequest) => void
  /**
   * 从「已保存条件」的「编辑」打开时传名字。传了的话：顶部一行「正在编辑已保存条件」，
   * 底部「保存」变成「覆盖保存」、「删除」可用。
   */
  presetName?: string | null
  onDeletePreset?: (name: string) => void
  /**
   * 底部「保存」：把**当前草稿**交出去（用户第 5 条要求保存按钮放进弹窗）。
   *
   * ``name`` 有值 = 覆盖这个已保存条件（页面直接写文件，不再问名字）；
   * ``null`` = 还没保存过 → 页面弹「输入文件名」的小窗。
   * 保存的是草稿而不是上一轮的结果，所以不需要先跑一次选股。
   */
  onSavePreset?: (request: ScreenRequest, name: string | null) => void
}) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [form, setForm] = useState<DraftForm>(() => toDraft(initialRequest ?? null))
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // 每次打开都用最新的 initialRequest（「修改条件」要把上次的请求原样带回）
  useEffect(() => {
    if (open) {
      setForm(toDraft(initialRequest ?? null))
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
  /**
   * 条件参数校验用的窗口：窗口留空时按上限 250 算。
   *
   * 否则「连续 N 日阳线」这类跟窗口联动的参数会在窗口还空着的时候被卡到 1，
   * 用户填完窗口再回头看，条件参数已经被改小了 —— 真正拦提交的是统计窗口
   * 自己那条校验。
   */
  const effectiveDays = Number.isFinite(request.trading_days)
    ? Math.min(Math.max(MIN_TRADING_DAYS, Math.trunc(request.trading_days)), MAX_TRADING_DAYS)
    : MAX_TRADING_DAYS

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

  /**
   * 市场选择是「全部 / 其它」二选一的组（用户第 3 条）：
   *
   * - 点「全部」→ 四个市场全选（已经全选时再点也不清空）；
   * - 点某个市场 → 该市场加入 / 退出；退出后自然就不再是「全部」；
   * - **不允许一个都不选**（最后一个市场不能被取消）。
   */
  const toggleMarket = (market: ScreenMarket) => {
    setForm(current => {
      // 「全部」状态下点某个市场 → 只保留它（全部被取消选中）
      if (current.markets.length === SCREEN_MARKETS.length) {
        return { ...current, markets: [market] }
      }
      const selected = current.markets.includes(market)
      if (selected && current.markets.length === 1) return current
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

  /**
   * 底部「保存」（第 5 条）：保存的是**当前草稿**，不要求先跑一次选股。
   *
   * 草稿不合法时**不落盘**（同一套校验、同样标红字段），否则会存下一个跑不通的
   * 条件；合法就交给页面 —— 有名字（从已保存条件打开）直接覆盖，没名字弹输入框。
   */
  const handleSave = () => {
    setSubmitted(true)
    setIssues(liveIssues)
    if (liveIssues.length > 0) {
      const first = liveIssues[0]
      const selector = first.nodeId ? `[data-node-id="${first.nodeId}"]` : `[data-screen-field="${first.path}"]`
      window.setTimeout(() => {
        document.querySelector<HTMLElement>(selector)?.focus?.()
      }, 0)
      return
    }
    onSavePreset?.(toApiRequest(request), presetName)
  }

  const formDisabled = submitting

  return (
    <Dialog open={open} onOpenChange={next => (next ? onOpenChange(true) : handleCancel())}>
      <DialogContent
        ref={contentRef}
        className="max-w-[968px]"
        data-fork-screen-dialog
        tabIndex={-1}
        /**
         * 打开时不把焦点交给第一个输入框。
         *
         * 统计窗口带默认值 30，而 Radix 的默认行为是聚焦第一个可聚焦元素 ——
         * 正好是那个数字框，于是它一打开就带着焦点描边和光标，看起来像「已选中」。
         * 这里把焦点留在弹窗容器自身：仍在对话框内部（可访问性），但没有输入框
         * 呈现选中态。
         */
        onOpenAutoFocus={event => {
          event.preventDefault()
          contentRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{T.title}</DialogTitle>
          <DialogDescription>
            {presetName ? SCREEN_PRESET_TEXTS_ZH.editingPreset(presetName) : T.description}
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={formDisabled} className="space-y-3 disabled:opacity-60">
          {/* 基础筛选：先在 MySQL 里过滤，和条件树是「且」 */}
          <div className="rounded-lg border border-border/60 bg-accent/10 p-3">
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-[12px] font-medium text-foreground">{T.baseTitle}</span>
              <span className="text-[10px] text-muted-foreground">{T.baseHint}</span>
            </div>
            <div className="space-y-2">
              {/* 统计窗口：标题与控件同一行（用户反馈） */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.tradingDays}</span>
                <BaseNumberInput
                  screenField="trading_days"
                  ariaLabel={T.tradingDays}
                  text={form.daysText}
                  min={MIN_TRADING_DAYS}
                  max={MAX_TRADING_DAYS}
                  allowEmpty
                  className="w-20"
                  onText={next => setForm(current => ({ ...current, daysText: next }))}
                />
                <span className="text-[11px] text-muted-foreground">{T.tradingDaysSuffix}</span>
              </div>

              {/* 窗口结束日（可选）：勾上「启用」才指定日期，不勾就用库里最新交易日。
                  非交易日（周末/长假）由后端落到 ≤ 它的最大交易日，所以这里不拦。 */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.asofLabel}</span>
                <input
                  type="date"
                  aria-label={T.asofLabel}
                  data-screen-field="asof"
                  value={form.asofText}
                  disabled={!form.asofEnabled}
                  onChange={event =>
                    setForm(current => ({ ...current, asofText: event.target.value }))
                  }
                  className="h-7 rounded-md border border-input bg-background px-2 text-[12px] text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                />
                <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={form.asofEnabled}
                    aria-label={T.asofEnable}
                    data-screen-field="asof_enabled"
                    onChange={event => {
                      const enabled = event.target.checked
                      // 勾上时给一个能直接改的起点：优先当前数据日期，其次今天
                      const fallback = asof ?? new Date().toISOString().slice(0, 10)
                      setForm(current => ({
                        ...current,
                        asofEnabled: enabled,
                        asofText: enabled ? current.asofText || fallback : '',
                      }))
                    }}
                  />
                  {T.asofEnable}
                </label>
                <span className="text-[11px] text-muted-foreground">{T.asofHint}</span>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{T.market}</span>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label={T.market}>
                <button
                  type="button"
                  aria-pressed={allSelected ? true : noneSelected ? false : 'mixed'}
                  aria-label={T.marketAll}
                  data-fork-screen-market-all
                  onClick={() =>
                    setForm(current => ({
                      ...current,
                      // 「全部」只能选中，不能取消（取消要逐个点掉其他市场）
                      markets: [...SCREEN_MARKETS],
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
              {/* ST / *ST 跟在市场按钮后面，留一点间隔；不再单独占一行、也没有自己的标题 */}
              <div className="ml-3 flex items-center gap-1.5">
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

          {/* 条件树 */}
          <div className="rounded-lg border border-border/60 p-3">
            <div className="mb-1 text-[12px] font-medium text-foreground">{T.ruleTitle}</div>
            <ScreenConditionGroup
              node={form.rule}
              depth={1}
              isRoot
              tradingDays={effectiveDays}
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

        {/* 最后一行按钮与上面的预览/报错之间留出间距并加分隔线 ——
            用户反馈「条件选股的最后按钮行和上面 UI 贴在一起了」。
            第 5 条（2026-10-20 晚）：删除按钮**一直在**（没保存过时禁用），
            它后面是「保存」（已保存过则变成「覆盖保存」），最后才是「开始选股」；
            「取消」文字按钮去掉 —— 右上角有 X。 */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div className="text-[10px] text-muted-foreground" data-fork-screen-meta>
            {asof
              ? T.footerMeta(asof, bars, conditions, depth)
              : T.footerMetaNoAsOf(bars, conditions, depth)}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-7 px-2 text-[12px] disabled:opacity-40"
              disabled={!presetName || submitting || !onDeletePreset}
              title={presetName ? undefined : SCREEN_PRESET_TEXTS_ZH.deleteDisabled}
              onClick={() => {
                if (presetName && onDeletePreset) onDeletePreset(presetName)
              }}
              data-fork-screen-delete-preset
            >
              <Trash2 className="h-3.5 w-3.5" />
              {SCREEN_PRESET_TEXTS_ZH.delete}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-7 px-2 text-[12px]"
              disabled={submitting || !onSavePreset}
              onClick={() => void handleSave()}
              data-fork-screen-save-preset
            >
              <Save className="h-3.5 w-3.5" />
              {/* 文案永远是「保存」（用户第 2 条）：覆盖保存时行为仍是覆盖，只是不再换词 —— 
                  同一个按钮一会儿叫保存一会儿叫覆盖保存，看着像两个功能。 */}
              {SCREEN_PRESET_TEXTS_ZH.dialogSave}
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
