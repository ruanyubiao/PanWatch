/**
 * 类型声明（仅声明，不改动实现）。
 *
 * 实现文件 ``everything_filter.js`` 是从
 * https://github.com/ruanyubiao/RuoYi-Vue3-FastAPI/blob/master/ruoyi-fastapi-frontend/src/utils/everything_filter.js
 * **逐字复制**过来的，未做任何修改（用户要求：不要修改这个库，直接用）。
 * 因此它没有类型；本仓库的 tsconfig 没开 allowJs，直接 import .js 会让 tsc 报
 * TS7016，所以这里补一份声明，只描述形状，不动实现。
 */
export function normalizeQuery(query: string): string
export function collapseOrSpaces(query: string): string
export function prepareQuery(query: string): string
export function splitOrParts(term: string): string[]
export function matchOne(text: string, pattern: string, ignoreCase?: boolean): boolean
export function matchOrTerm(text: string, term: string, ignoreCase?: boolean): boolean
export function tokenize(query: string): string[]
export function matchAndTerm(text: string, token: string, ignoreCase?: boolean): boolean
export function matchAnd(text: string, query: string, ignoreCase?: boolean): boolean
export function matchText(
  text: string,
  query: string,
  options?: { ignoreCase?: boolean },
): boolean
export function filterStrings(
  items: unknown,
  query: string,
  options?: { ignoreCase?: boolean },
): string[]
export function filterStringsWithIndex(
  items: unknown,
  query: string,
  options?: { ignoreCase?: boolean },
): { index: number; value: string }[]
export function hasActiveFilter(query: string): boolean
