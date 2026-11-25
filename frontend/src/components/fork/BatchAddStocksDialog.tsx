import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { fetchAPI } from '@panwatch/api'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Label } from '@panwatch/base-ui/components/ui/label'
import { Badge } from '@panwatch/base-ui/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@panwatch/base-ui/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import { isLikelyAShareCode, normalizeSymbol, parseStockInput, type StockInputEntry } from '@/lib/stock-tokens'

/**
 * fork：弹窗内的固定中文文案（变量名以 _ZH 结尾，仓库的 check:i18n 放行这种声明）。
 * 这里没有上游 i18n 资源可复用，集中声明既过检查，也方便以后统一替换。
 */
const BATCH_ADD_TEXTS_ZH = {
  title: '添加股票',
  description: '一行一只，可带名称（如「600486 扬农化工」）；也支持用空格、换行、逗号、顿号、斜杠、竖线、冒号或分号分隔。',
  searchLabel: '搜索股票',
  placeholder: '600486 扬农化工\n000981 山子高科\n600519 000001 比亚迪',
  recognizedPrefix: '已识别',
  recognizedSuffix: '个输入',
  missing: '未找到匹配的股票',
  etfSkipped: 'ETF 不在本页支持范围，已跳过',
  alreadyFollowed: '已关注',
  remove: '移除',
  cancel: '取消',
  resolve: '解析',
  confirmAdd: '确认添加',
}

/**
 * fork 专用：批量添加股票弹窗（替代上游的「添加股票 / ETF」单只弹窗）
 *
 * 上游弹窗一次只能选一只，且带 全部/A股/港股/美股 的市场筛选。fork 版：
 *   - 只搜 A 股（market=CN），没有市场切换
 *   - 输入框支持多只：「代码 名称」一行一只（600486 扬农化工）算一条；
 *     其余按空白 / 中英文逗号 / 顿号 / 斜杠 / 反斜杠 / 竖线 /
 *     冒号 / 分号 切分（切分规则见 lib/stock-tokens.ts，有单测）
 *   - 解析后再按代码去一次重（同一只票的两种写法只留一行）
 *   - 先「解析」把每个 token 解析成股票，人工确认后再「确认添加」
 *   - 后端没有批量接口，所以添加是前端循环 POST /stocks（用户明确认可）
 */

interface SearchResult {
  symbol: string
  name: string
  market: string
  asset_type?: 'stock' | 'etf'
}

type TokenStatus = 'ok' | 'ambiguous' | 'missing' | 'etf'

interface ResolvedRow {
  /** 用户原始片段（「600486 扬农化工」或「比亚迪」），列表里原样回显 */
  raw: string
  token: string
  status: TokenStatus
  chosen: SearchResult | null
  candidates: SearchResult[]
}

export function BatchAddStocksDialog({
  open,
  onOpenChange,
  existingSymbols,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingSymbols: Set<string>
  onAdded: () => void | Promise<void>
}) {
  const { toast } = useToast()
  const [text, setText] = useState('')
  const [rows, setRows] = useState<ResolvedRow[]>([])
  const [resolving, setResolving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [parsed, setParsed] = useState(false)

  const entries = useMemo(() => parseStockInput(text), [text])

  useEffect(() => {
    if (!open) {
      setText('')
      setRows([])
      setParsed(false)
      setResolving(false)
      setSubmitting(false)
    }
  }, [open])

  const searchStocks = useCallback(async (query: string): Promise<SearchResult[]> => {
    try {
      return (
        (await fetchAPI<SearchResult[]>(
          `/stocks/search?q=${encodeURIComponent(query)}&market=CN`,
        )) || []
      )
    } catch {
      return []
    }
  }, [])

  const resolveOne = useCallback(
    async (entry: StockInputEntry): Promise<ResolvedRow> => {
      const token = entry.token
      const raw = entry.raw
      let found = await searchStocks(token)
      // 「代码 名称」里的代码搜不到（新股、改名、停牌）时，用名称再试一次：
      // 名称只是提示，不单独成条，所以这一行仍然只算一只票。
      if (found.length === 0 && entry.nameHint) {
        found = await searchStocks(entry.nameHint)
      }

      // fork 页只服务股票：搜到的 ETF 一律不接受（ETF 有自己的代码段，
      // 不能因为「搜不到股票」就把它当代码直接加进来）。
      const results = found.filter(item => (item.asset_type || 'stock') !== 'etf')
      if (results.length === 0 && found.length > 0) {
        return { raw, token, status: 'etf', chosen: null, candidates: [] }
      }

      const normalized = normalizeSymbol(token)
      const exact = results.find(item => normalizeSymbol(item.symbol) === normalized)
      if (exact) return { raw, token, status: 'ok', chosen: exact, candidates: results }

      const byName = results.find(item => item.name === token || item.name === entry.nameHint)
      if (byName) return { raw, token, status: 'ok', chosen: byName, candidates: results }

      if (results.length === 1) {
        return { raw, token, status: 'ok', chosen: results[0], candidates: results }
      }
      if (results.length === 0) {
        // 搜索没命中：只有「像 A 股代码」的输入才允许按代码添加（新股/停牌等），
        // 否则 12345 这种随手输入就会被写成垃圾自选。
        if (isLikelyAShareCode(token)) {
          return {
            raw,
            token,
            status: 'ok',
            chosen: { symbol: normalized, name: normalized, market: 'CN', asset_type: 'stock' },
            candidates: [],
          }
        }
        return { raw, token, status: 'missing', chosen: null, candidates: [] }
      }
      return { raw, token, status: 'ambiguous', chosen: results[0], candidates: results }
    },
    [searchStocks],
  )

  const handleResolve = useCallback(async () => {
    if (entries.length === 0) return
    setResolving(true)
    try {
      const next: ResolvedRow[] = []
      // 没有批量搜索接口，逐个查
      for (const entry of entries) {
        next.push(await resolveOne(entry))
      }
      // 按「解析后的代码」再去一次重：600486 与 扬农化工 指向同一只票，
      // 输入里同时出现时只保留一条（用户 2026-11-25 报的重复行）。
      const bySymbol = new Map<string, ResolvedRow>()
      const deduped: ResolvedRow[] = []
      for (const row of next) {
        const symbol = row.chosen ? normalizeSymbol(row.chosen.symbol) : ''
        if (!symbol) {
          deduped.push(row)
          continue
        }
        if (bySymbol.has(symbol)) continue
        bySymbol.set(symbol, row)
        deduped.push(row)
      }
      setRows(deduped)
      setParsed(true)
    } finally {
      setResolving(false)
    }
  }, [entries, resolveOne])

  const pendingRows = rows.filter(row => row.status !== 'missing' && row.chosen)
  const newRows = pendingRows.filter(row => !existingSymbols.has(String(row.chosen?.symbol)))

  const handleSubmit = useCallback(async () => {
    if (newRows.length === 0) return
    setSubmitting(true)
    let added = 0
    let failed = 0
    for (const row of newRows) {
      const item = row.chosen as SearchResult
      try {
        await fetchAPI('/stocks', {
          method: 'POST',
          body: JSON.stringify({
            symbol: item.symbol,
            name: item.name,
            market: item.market || 'CN',
            asset_type: 'stock',
          }),
        })
        added += 1
      } catch {
        failed += 1
      }
    }
    setSubmitting(false)
    await onAdded()
    const skipped = pendingRows.length - newRows.length
    const parts = [`已添加 ${added} 只`]
    if (skipped > 0) parts.push(`已存在跳过 ${skipped} 只`)
    if (failed > 0) parts.push(`失败 ${failed} 只`)
    toast(parts.join('，'), failed > 0 ? 'error' : 'success')
    if (failed === 0) onOpenChange(false)
  }, [existingSymbols, newRows, onAdded, onOpenChange, pendingRows.length, toast])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{BATCH_ADD_TEXTS_ZH.title}</DialogTitle>
          <DialogDescription>
            {BATCH_ADD_TEXTS_ZH.description}
          </DialogDescription>
        </DialogHeader>

        <div>
          <Label className="mb-2 block">{BATCH_ADD_TEXTS_ZH.searchLabel}</Label>
          <textarea
            value={text}
            onChange={e => {
              setText(e.target.value)
              setParsed(false)
              setRows([])
            }}
            placeholder={BATCH_ADD_TEXTS_ZH.placeholder}
            rows={4}
            className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-[12px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {BATCH_ADD_TEXTS_ZH.recognizedPrefix} {entries.length} {BATCH_ADD_TEXTS_ZH.recognizedSuffix}
              {entries.length > 0 &&
                `：${entries.slice(0, 6).map(entry => entry.raw).join(' / ')}${entries.length > 6 ? ' …' : ''}`}
            </span>
          </div>
        </div>

        {parsed && rows.length > 0 && (
          <div className="max-h-64 overflow-auto scrollbar rounded-md border border-border/50">
            {rows.map((row, index) => {
              const item = row.chosen
              const exists = !!item && existingSymbols.has(item.symbol)
              return (
                <div
                  key={`${row.token}-${index}`}
                  className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-b-0"
                >
                  <span className="w-40 shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                    {row.raw}
                  </span>
                  {row.status === 'missing' ? (
                    <span className="flex-1 text-[12px] text-rose-500">{BATCH_ADD_TEXTS_ZH.missing}</span>
                  ) : row.status === 'etf' ? (
                    <span className="flex-1 text-[12px] text-amber-600">{BATCH_ADD_TEXTS_ZH.etfSkipped}</span>
                  ) : (
                    <>
                      <span className="shrink-0 font-mono text-[12px] font-semibold">{item?.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px]">{item?.name}</span>
                      {exists && <Badge variant="secondary">{BATCH_ADD_TEXTS_ZH.alreadyFollowed}</Badge>}
                      {row.candidates.length > 1 && (
                        <Select
                          value={item?.symbol || ''}
                          onValueChange={value => {
                            const picked = row.candidates.find(c => c.symbol === value)
                            if (!picked) return
                            setRows(prev =>
                              prev.map((r, i) =>
                                i === index ? { ...r, chosen: picked, status: 'ok' } : r,
                              ),
                            )
                          }}
                        >
                          <SelectTrigger className="h-7 w-[180px] text-[11px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {row.candidates.map(c => (
                              <SelectItem key={`${c.market}-${c.symbol}`} value={c.symbol}>
                                {c.symbol} {c.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={BATCH_ADD_TEXTS_ZH.remove}
                    onClick={() => setRows(prev => prev.filter((_, i) => i !== index))}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {BATCH_ADD_TEXTS_ZH.cancel}
          </Button>
          {/* fork：解析按钮从输入框下方挪到底部按钮行（原来和底部按钮视觉重叠），
              放在「取消」与「确认添加」之间，用绿色区分。 */}
          <Button
            type="button"
            size="sm"
            className="bg-emerald-600 text-white hover:bg-emerald-600/90"
            disabled={entries.length === 0 || resolving}
            onClick={() => void handleResolve()}
          >
            {resolving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {BATCH_ADD_TEXTS_ZH.resolve}
          </Button>
          <Button type="button" disabled={!parsed || newRows.length === 0 || submitting} onClick={() => void handleSubmit()}>
            {submitting && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {BATCH_ADD_TEXTS_ZH.confirmAdd}{newRows.length > 0 ? ` (${newRows.length})` : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
