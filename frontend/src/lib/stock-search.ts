/**
 * fork 专用：分析页搜索框的匹配规则（代码 + 名称合并，Everything 语法）。
 *
 * 为什么要有这一层
 * --------------
 * 搜索语法**直接用**用户指定的库 ``lib/vendor/everything_filter.js``
 * （逐字复制、未改动），它本身只认「一段文本 + 一个查询串」。股票有**两个**字段
 * 要参与匹配（代码、名称），所以照抄 RuoYi 那边 ``telecontrolOrderMatch.js`` 的
 * 写法：先拼出一段可搜索文本（``orderSearchText`` 的等价物），再交给 ``matchText``。
 *
 * 拼法：``代码 + 空格 + 名称``。空格是 AND 的边界，因此
 * ``601 平安`` → 「代码含 601」且「名称含 平安」，两条都命中的才算 —— 这正是用户要的
 * 「代码和名称合并进行匹配」。反过来说，查询串里的 ``|`` ``!`` ``*`` ``"`` 等
 * 也都由那个库解释，本文件不重写任何匹配逻辑。
 */
import { matchText } from '@/lib/vendor/everything_filter'

/** 搜索框 placeholder（与 RuoYi 的 TELECONTROL_ORDER_FILTER_PLACEHOLDER 同风格）。 */
export const STOCK_SEARCH_PLACEHOLDER_ZH = '搜索：空格与、|或、!非、"短语"、*?'

/** 悬停「?」时的语法说明。一条一行：写法 → 说明 → 例子。 */
export const STOCK_SEARCH_HELP_ZH: { syntax: string; desc: string; sample: string }[] = [
  { syntax: '空格', desc: '与：几个词都命中才算', sample: '601 平安' },
  { syntax: '|', desc: '或：任一侧命中即可', sample: '平安|茅台' },
  { syntax: '!', desc: '非：排除某个词', sample: '!ST' },
  { syntax: '"…"', desc: '短语：整段连续出现', sample: '"贵州茅台"' },
  { syntax: '*', desc: '任意多个字符', sample: '6005*' },
  { syntax: '?', desc: '正好一个字符', sample: '000001?' },
  { syntax: '^…', desc: '以…开头', sample: '^60' },
  { syntax: '…$', desc: '以…结尾', sample: '银行$' },
]

/** 语法说明的标题与脚注。 */
export const STOCK_SEARCH_HELP_TITLE_ZH = '搜索语法（代码与名称一起匹配）'
export const STOCK_SEARCH_HELP_FOOTER_ZH =
  '匹配对象 = 代码 + 空格 + 名称；不区分大小写；留空不过滤。'
export const STOCK_SEARCH_CLEAR_ZH = '清空搜索'

/** 参与匹配的一行：只要有代码和名称即可（行情行与自选行都满足）。 */
export interface SearchableStock {
  code?: string | null
  symbol?: string | null
  name?: string | null
}

/**
 * 拼出可搜索文本：``代码 + ' ' + 名称``。
 *
 * 自选里的行只有 ``symbol``（带 sh/sz 前缀），所以缺 ``code`` 时从 ``symbol``
 * 里剥出 6 位数字 —— 否则复制一份逻辑到页面里，两条列表的搜索行为又会不一致。
 */
export function buildStockSearchText(stock: SearchableStock): string {
  const code = stock.code || String(stock.symbol || '').replace(/^[a-z]+/i, '')
  return `${code} ${stock.name ?? ''}`.trim()
}

/** 该行是否命中搜索串（空串恒为 true）。 */
export function stockMatchesSearch(stock: SearchableStock, query: string): boolean {
  return matchText(buildStockSearchText(stock), query)
}
