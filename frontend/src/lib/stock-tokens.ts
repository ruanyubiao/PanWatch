/**
 * 批量添加股票时的输入切分（fork 专用）
 *
 * 只做纯文本处理，方便单测；真正的解析（token → 股票）在
 * components/fork/BatchAddStocksDialog.tsx 里逐条调搜索接口。
 *
 * 分隔符（用户指定）：空白（空格 / 换行 / \t，即正则 \s）、中文逗号，
 * 英文逗号 , 顿号 、 斜杠 / 反斜杠 \ 竖线 | 冒号 : ： 分号 ; ；
 */

const SEPARATOR = /[\s,，、;；:：/\\|]+/

/** 切分并去重（保留首次出现的顺序）。 */
export function splitStockTokens(input: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of String(input || '').split(SEPARATOR)) {
    const token = raw.trim()
    if (!token) continue
    const key = token.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(token)
  }
  return out
}

/**
 * 归一成交易所代码。
 *
 * 自选和行情库里同一只票会出现两种写法：`600519` / `600519.SH`，以及带市场前缀的
 * `sh600519`（行情库 symbol）。只剥后缀的话，`sh600519` 对不上 `600519`，
 * 关注按钮、取消关注、批量添加会各认各的。
 */
export function normalizeSymbol(token: string): string {
  return String(token || '')
    .trim()
    .toUpperCase()
    .replace(/^(SH|SZ|BJ|HK)(?=\d)/, '')
    .replace(/\.(SH|SS|SZ|BJ|HK|US)$/, '')
}

/** 两个代码是不是同一只上市证券（忽略 sh/sz/bj 前缀和 .SH/.SZ 后缀）。 */
export function sameListingCode(a?: string | null, b?: string | null): boolean {
  const left = normalizeSymbol(a || '')
  const right = normalizeSymbol(b || '')
  return left.length > 0 && left === right
}

/** token 是否长得像纯代码（用于「代码精确命中」优先判断）。 */
export function looksLikeCode(token: string): boolean {
  return /^\d{5,6}$/.test(normalizeSymbol(token))
}

/** A 股代码前缀（与后端 fork_catalog.A_SHARE_PREFIXES 一致）。 */
const A_SHARE_PREFIXES = ['60', '68', '00', '30', '920']

/**
 * 是否像一只 A 股代码。
 * 搜索/目录都没命中时，只有这种情况才允许「按代码直接添加」，
 * 避免 12345 这种随手输入被写成垃圾自选。
 */
export function isLikelyAShareCode(token: string): boolean {
  const code = normalizeSymbol(token)
  return /^\d{6}$/.test(code) && A_SHARE_PREFIXES.some(prefix => code.startsWith(prefix))
}
