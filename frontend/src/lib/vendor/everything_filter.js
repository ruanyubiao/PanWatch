/**
 * Everything 风格字符串过滤器（精简版）。
 *
 * 用于对一段文本做 Everything 搜索语法的轻量匹配，不是官方语法的 100% 实现。
 * 遥控指令树（telecontrolOrderMatch）以及其它前端列表过滤可复用本模块。
 *
 * ---------------------------------------------------------------------------
 * 预处理
 * ---------------------------------------------------------------------------
 *   1. 中文引号 `“”` → 英文 `"`；中文问号 `？` → 英文 `?`（通配符）。
 *   2. 引号外中文空格 `\u3000` / NBSP → 英文空格；引号内不动。
 *   3. 引号外 `|` 两侧空白收掉（`开窗 | 拍照` → `开窗|拍照`），空白属 OR 操作符。
 *
 * ---------------------------------------------------------------------------
 * 优先级（空格 AND 高于 `|` OR）
 * ---------------------------------------------------------------------------
 *   先按空格分词（AND），再在每个词内部按 `|` 做 OR。
 *
 *   `指向|星敏 设置`  →  (指向 OR 星敏) AND 设置
 *   `开窗 | 拍照`      →  先收成 `开窗|拍照` → 开窗 OR 拍照
 *   `开窗 | 拍*`       →  开窗 OR 拍*
 *
 *   空格     AND：各词必须同时命中。
 *   |        OR：仅在「同一个空格分词单元」内二选一（引号内 `|` 不当 OR）。
 *   !        NOT：紧跟在词前。`!指向|星敏` → 既不含指向也不含星敏。
 *   "…"      短语：整段连续子串；内部空格 / `|` 都不拆。
 *
 * ---------------------------------------------------------------------------
 * 通配符（词内；子串匹配）
 * ---------------------------------------------------------------------------
 *   *  0+ 字符   例：`拍*` 匹配「拍照」「开窗拍照」
 *   ?  1 字符    例：`K15??` 匹配 K1501
 *
 * ---------------------------------------------------------------------------
 * 其它
 * ---------------------------------------------------------------------------
 *   ^… / …$   开头 / 结尾（无通配时）
 *   默认忽略大小写；空查询不过滤；`开窗|` 空 OR 分支丢弃；仅 `|` → 不匹配
 */

/** 中文弯引号 → 英文直引号；全角问号 → 英文 `?`（通配） */
const CN_QUOTE_RE = /[\u201c\u201d]/g
const CN_QUESTION_RE = /\uFF1F/g

/** 把普通字符转义成正则字面量。 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 弯引号→`"`；全角 `？`→`?`；引号外中文/NBSP 空格→英文空格。
 *
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  const s = String(query ?? '')
    .replace(CN_QUOTE_RE, '"')
    .replace(CN_QUESTION_RE, '?')
  let out = ''
  let inQuote = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') {
      inQuote = !inQuote
      out += c
      continue
    }
    if (!inQuote && (c === '\u3000' || c === '\u00a0')) {
      out += ' '
      continue
    }
    out += c
  }
  return out
}

/**
 * 引号外：把 `|` 两侧空白收掉（空白属于 OR）。
 * `开窗 | 拍照` → `开窗|拍照`；引号内不动。
 *
 * @param {string} query
 * @returns {string}
 */
export function collapseOrSpaces(query) {
  let out = ''
  let inQuote = false
  let i = 0
  while (i < query.length) {
    const c = query[i]
    if (c === '"') {
      inQuote = !inQuote
      out += c
      i += 1
      continue
    }
    if (!inQuote && c === '|') {
      out = out.replace(/[ \t]+$/, '')
      out += '|'
      i += 1
      while (i < query.length && (query[i] === ' ' || query[i] === '\t')) i += 1
      continue
    }
    out += c
    i += 1
  }
  return out
}

/**
 * normalizeQuery + collapseOrSpaces + trim。
 *
 * @param {string} query
 * @returns {string}
 */
export function prepareQuery(query) {
  return collapseOrSpaces(normalizeQuery(query)).trim()
}

/**
 * 按 `|` 拆 OR 候选项（用于单个 AND 词内部；调用方保证不在引号短语上调）。
 * 空段丢弃：`开窗|` → `['开窗']`；`|` → `[]`。
 *
 * @param {string} term
 * @returns {string[]}
 */
export function splitOrParts(term) {
  return String(term || '')
    .split('|')
    .map(p => p.trim())
    .filter(Boolean)
}

/**
 * 通配 → 子串正则（不加 ^$）。
 *
 * @param {string} pattern
 * @param {boolean} [ignoreCase=true]
 * @returns {RegExp}
 */
function wildcardToRegex(pattern, ignoreCase = true) {
  let result = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') result += '.*'
    else if (char === '?') result += '.'
    else result += escapeRegex(char)
  }
  return new RegExp(result, ignoreCase ? 'i' : '')
}

/**
 * 单个原子条件（不含词内 `|` / 顶层 AND）。
 *
 * @param {string} text
 * @param {string} pattern
 * @param {boolean} [ignoreCase=true]
 * @returns {boolean}
 */
export function matchOne(text, pattern, ignoreCase = true) {
  pattern = String(pattern || '').trim()
  if (!pattern) return true

  const hay = String(text ?? '')
  const cmp = (a, b) => (ignoreCase ? a.toLowerCase().includes(b.toLowerCase()) : a.includes(b))
  const cmpStart = (a, b) => (ignoreCase ? a.toLowerCase().startsWith(b.toLowerCase()) : a.startsWith(b))
  const cmpEnd = (a, b) => (ignoreCase ? a.toLowerCase().endsWith(b.toLowerCase()) : a.endsWith(b))

  if (pattern.length >= 2 && pattern.startsWith('"') && pattern.endsWith('"')) {
    return cmp(hay, pattern.slice(1, -1))
  }

  if (pattern.startsWith('^')) {
    return cmpStart(hay, pattern.slice(1))
  }

  if (pattern.endsWith('$') && !pattern.includes('*') && !pattern.includes('?')) {
    return cmpEnd(hay, pattern.slice(0, -1))
  }

  if (pattern.includes('*') || pattern.includes('?')) {
    return wildcardToRegex(pattern, ignoreCase).test(hay)
  }

  return cmp(hay, pattern)
}

/**
 * 一个空格分词单元：可为短语、含 `|` 的 OR、或普通词。
 * 不含前导 `!`（NOT 在 matchAndTerm 处理）。
 *
 * @param {string} text
 * @param {string} term
 * @param {boolean} [ignoreCase=true]
 * @returns {boolean}
 */
export function matchOrTerm(text, term, ignoreCase = true) {
  term = String(term || '').trim()
  if (!term) return true

  if (term.length >= 2 && term.startsWith('"') && term.endsWith('"')) {
    return matchOne(text, term, ignoreCase)
  }

  if (term.includes('|')) {
    const parts = splitOrParts(term)
    if (!parts.length) return false
    return parts.some(p => matchOne(text, p, ignoreCase))
  }

  return matchOne(text, term, ignoreCase)
}

/**
 * 空格分词（先 prepareQuery）。短语 `"…"` 整段一个 token。
 *
 * @param {string} query
 * @returns {string[]}
 */
export function tokenize(query) {
  const prepared = prepareQuery(query)
  const tokens = []
  const regex = /"[^"]*"|\S+/g
  let match
  while ((match = regex.exec(prepared)) !== null) {
    tokens.push(match[0])
  }
  return tokens
}

/**
 * 单个 AND 词：可选 `!` 前缀 + matchOrTerm。
 *
 * @param {string} text
 * @param {string} token
 * @param {boolean} [ignoreCase=true]
 * @returns {boolean}
 */
export function matchAndTerm(text, token, ignoreCase = true) {
  token = String(token || '').trim()
  if (!token) return true
  if (token.startsWith('!')) {
    return !matchOrTerm(text, token.slice(1), ignoreCase)
  }
  return matchOrTerm(text, token, ignoreCase)
}

/**
 * AND：所有空格分词单元都要成立（单元内可有 `|` OR）。
 *
 * @param {string} text
 * @param {string} query
 * @param {boolean} [ignoreCase=true]
 * @returns {boolean}
 */
export function matchAnd(text, query, ignoreCase = true) {
  const tokens = tokenize(query)
  if (!tokens.length) return true
  for (const token of tokens) {
    if (!matchAndTerm(text, token, ignoreCase)) return false
  }
  return true
}

/**
 * 主匹配入口：prepareQuery → 空格 AND（词内 OR）。
 *
 * @param {string} text
 * @param {string} query
 * @param {{ ignoreCase?: boolean }} [options]
 * @returns {boolean}
 */
export function matchText(text, query, options = {}) {
  const { ignoreCase = true } = options
  const prepared = prepareQuery(String(query ?? ''))
  if (!prepared) return true
  return matchAnd(text, prepared, ignoreCase)
}

/**
 * @param {unknown} items
 * @param {string} query
 * @param {{ ignoreCase?: boolean }} [options]
 * @returns {string[]}
 */
export function filterStrings(items, query, options = {}) {
  if (!Array.isArray(items)) return []
  return items.filter(item => typeof item === 'string' && matchText(item, query, options))
}

/**
 * @param {unknown} items
 * @param {string} query
 * @param {{ ignoreCase?: boolean }} [options]
 * @returns {{ index: number, value: string }[]}
 */
export function filterStringsWithIndex(items, query, options = {}) {
  if (!Array.isArray(items)) return []
  const result = []
  items.forEach((item, index) => {
    if (typeof item === 'string' && matchText(item, query, options)) {
      result.push({ index, value: item })
    }
  })
  return result
}

/**
 * @param {string} query
 * @returns {boolean}
 */
export function hasActiveFilter(query) {
  return String(query ?? '').trim().length > 0
}
