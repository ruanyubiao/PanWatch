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

/** 去掉交易所后缀（600519.SH / 600519.SS / 000001.SZ → 600519 / 000001）。 */
export function normalizeSymbol(token: string): string {
  return String(token || '')
    .trim()
    .toUpperCase()
    .replace(/\.(SH|SS|SZ|BJ|HK|US)$/, '')
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
