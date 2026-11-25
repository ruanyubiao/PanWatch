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

/** 一条输入项：token 送去解析，nameHint 只是提示（不单独成条）。 */
export interface StockInputEntry {
  /** 解析主键：优先代码，没有代码时是名称 */
  token: string
  /** 同一行里跟在代码后面的名称，用于兜底搜索与确认回显 */
  nameHint?: string
  /** 原始片段，弹窗里原样回显（用户 2026-11-25：一行一只是常态） */
  raw: string
}

/** 代码的判等键（大小写不敏感）。 */
function tokenKey(token: string): string {
  return token.toUpperCase()
}

/**
 * 切分用户输入的一条条股票（fork 专用）。
 *
 * 用户粘贴的常态是「代码 名称」一行一只（600486 扬农化工）。早先按空白一刀切，
 * 一行会变成「600486」+「扬农化工」两条，而两条解析到的是同一只票，于是列表
 * 里出现重复的两行（用户 2026-11-25 报的 bug）。
 *
 * 现在的规则：同一行里「代码 + 紧跟的一个非代码词」合成一条（当名称提示），
 * 其余词仍各自成条；单行里出现多组也是同样的配对（600519 贵州茅台 000001 平安银行）。
 * 真正按「解析后的代码」去重放在弹窗里做 —— 那里才知道 token 到底是哪只票。
 */
export function parseStockInput(input: string): StockInputEntry[] {
  const out: StockInputEntry[] = []
  const seen = new Map<string, StockInputEntry>()

  for (const line of String(input || '').split(/\r?\n/)) {
    const parts = line
      .split(SEPARATOR)
      .map(part => part.trim())
      .filter(Boolean)

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      const next = parts[i + 1]
      const pairWithNext = looksLikeCode(part) && !!next && !looksLikeCode(next)
      const entry: StockInputEntry = pairWithNext
        ? { token: part, nameHint: next, raw: `${part} ${next}` }
        : { token: part, raw: part }
      if (pairWithNext) i += 1

      const key = tokenKey(entry.token)
      const dup = seen.get(key)
      if (dup) {
        // 同一只票先以纯代码出现、后来又带上了名称：补上名称提示即可
        if (!dup.nameHint && entry.nameHint) dup.nameHint = entry.nameHint
        continue
      }
      seen.set(key, entry)
      out.push(entry)
    }
  }
  return out
}

/** 只要 token 列表（保留首次出现的顺序）。 */
export function splitStockTokens(input: string): string[] {
  return parseStockInput(input).map(entry => entry.token)
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

/** A 股代码前缀（与后端 fork_market 的 _BOARD_CASE 认的同一套前缀）。 */
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
