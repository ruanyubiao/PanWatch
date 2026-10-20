/**
 * 条件选股「已保存条件」的前端调用与名字规则（用户反馈 2026-10-20 第 1 / 2 条）。
 *
 * 名字 = 服务器上的文件名（后端 ``data/screen_presets/<名字>.json``），所以这里
 * 的校验必须与后端 ``fork_screen/presets.py`` 逐条对齐：长度按**字符**算（中文
 * 一个字算一个），只禁会破坏文件名的字符。前端先拦一遍是为了在输入框旁边立刻
 * 给出提示，不是为了替代后端校验。
 *
 * 保存走 ``POST /api/stocks/screen/presets``：存的是**整个请求**（窗口 / 市场 /
 * 市值 / 条件树），所以「编辑」能把弹窗原样填回去。
 */
import { fetchAPI } from '@panwatch/api'
import type { ScreenRequest } from '@/lib/screen-rule'

/** 名字长度上限（字符）。与后端 ``presets.NAME_MAX_LEN`` 保持一致。 */
export const PRESET_NAME_MAX = 10

/** 文件名里不允许出现的字符（与后端 ``_FORBIDDEN_CHARS`` 一致）。 */
const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f]/

export const SCREEN_PRESET_TEXTS_ZH = {
  save: '保存条件',
  saveTitle: '保存条件',
  saveDescription: '保存后可在「已保存条件」下拉里选出来复用或编辑。名字同时是服务器上的文件名。',
  nameLabel: '条件名称',
  namePlaceholder: '最多 10 个字符',
  nameCounter: (used: number) => `${used}/${PRESET_NAME_MAX}`,
  nameRequired: '请输入条件名称',
  nameTooLong: `名称最多 ${PRESET_NAME_MAX} 个字符`,
  nameForbidden: '名称不能包含 / \\ : * ? " < > | 等字符',
  nameDot: '名称不能以 . 开头或结尾',
  overwriteTitle: '覆盖条件',
  overwriteConfirm: (name: string) => `已存在同名条件「${name}」，覆盖它？`,
  confirm: '确定',
  cancel: '取消',
  saved: (name: string) => `已保存条件「${name}」`,
  saveFailed: (message: string) => `保存条件失败：${message}`,
  deleted: (name: string) => `已删除条件「${name}」`,
  deleteFailed: (message: string) => `删除条件失败：${message}`,
  deleteTitle: '删除条件',
  deleteConfirm: (name: string) => `删除已保存的条件「${name}」？删掉后不可恢复。`,
  delete: '删除',
  menuPlaceholder: '已保存条件',
  menuEmpty: '暂无已保存条件',
  menuLabel: '已保存条件',
  edit: '编辑',
  editPreset: '编辑已保存条件',
  editDisabled: '还没有已保存的条件',
  editingPreset: (name: string) => `正在编辑已保存条件「${name}」：改完点「开始选股」查看结果。`,
  summary: (name: string) => `「${name}」`,
  loadFailed: (message: string) => `读取已保存条件失败：${message}`,
}

export interface ScreenPreset {
  /** 名字 = 文件名 */
  name: string
  /** 保存时间（ISO，带时区）；老文件可能没有 */
  saved_at: string | null
  request: ScreenRequest
}

/** 名字的校验结果：``null`` 表示可用，否则是给人看的错误文案。 */
export function presetNameError(raw: string): string | null {
  const name = raw.trim()
  if (!name) return SCREEN_PRESET_TEXTS_ZH.nameRequired
  // 按字符数算：``[...name]`` 而不是 ``name.length``，避免代理对被拆开数
  if ([...name].length > PRESET_NAME_MAX) return SCREEN_PRESET_TEXTS_ZH.nameTooLong
  if (FORBIDDEN_CHARS.test(name)) return SCREEN_PRESET_TEXTS_ZH.nameForbidden
  if (name.startsWith('.') || name.endsWith('.')) return SCREEN_PRESET_TEXTS_ZH.nameDot
  return null
}

/** 名字最长能输入的字符数（输入框 maxLength 用，中文一个字算一个）。 */
export function presetNameMaxLength(): number {
  return PRESET_NAME_MAX
}

export async function listPresets(signal?: AbortSignal): Promise<ScreenPreset[]> {
  const data = await fetchAPI<{ items: ScreenPreset[] }>('/stocks/screen/presets', { signal })
  return (data?.items ?? []).filter(item => Boolean(item?.name && item?.request))
}

export async function savePreset(
  name: string,
  request: ScreenRequest,
  overwrite = false,
): Promise<ScreenPreset> {
  const data = await fetchAPI<{ item: ScreenPreset }>('/stocks/screen/presets', {
    method: 'POST',
    body: JSON.stringify({ name: name.trim(), request, overwrite }),
  })
  return data.item
}

export async function deletePreset(name: string): Promise<void> {
  await fetchAPI<{ deleted: string }>(`/stocks/screen/presets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  })
}
