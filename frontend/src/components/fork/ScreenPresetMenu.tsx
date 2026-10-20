import { Pencil } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@panwatch/base-ui/components/ui/select'
import { SCREEN_PRESET_TEXTS_ZH, type ScreenPreset } from '@/lib/screen-presets'
import { formatRule } from '@/lib/screen-rule'

/**
 * fork：「已保存条件」的下拉 + 编辑按钮（用户反馈 2026-10-20 第 2 条）。
 *
 * 位置由页面决定（紧跟「条件选股」按钮之后）。一个条件都没有时**两个控件都不可
 * 操作**（下拉与编辑同时 disabled），而不是弹一个空菜单让用户点。
 *
 * 下拉只负责「选一个」；点「编辑」才把那个条件的完整请求交给弹窗（窗口 / 市场 /
 * 市值 / 条件树一起回填），这是用户明确要求的交互：先选、再编辑。
 */
export function ScreenPresetMenu({
  presets,
  value,
  onChange,
  onEdit,
  className = '',
}: {
  presets: ScreenPreset[]
  /** 当前选中的条件名；null = 没选 */
  value: string | null
  onChange: (name: string | null) => void
  /** 打开弹窗编辑选中的条件 */
  onEdit: (name: string) => void
  className?: string
}) {
  const empty = presets.length === 0
  const selected = value && presets.some(item => item.name === value) ? value : null

  return (
    <div className={`flex items-center gap-1.5 ${className}`} data-fork-preset-menu>
      <Select
        value={selected ?? undefined}
        disabled={empty}
        onValueChange={next => onChange(next)}
      >
        <SelectTrigger
          aria-label={SCREEN_PRESET_TEXTS_ZH.menuLabel}
          data-fork-preset-select
          className="h-7 w-[150px] text-[12px]"
          title={empty ? SCREEN_PRESET_TEXTS_ZH.menuEmpty : SCREEN_PRESET_TEXTS_ZH.menuPlaceholder}
        >
          <SelectValue placeholder={empty ? SCREEN_PRESET_TEXTS_ZH.menuEmpty : SCREEN_PRESET_TEXTS_ZH.menuPlaceholder} />
        </SelectTrigger>
        <SelectContent className="min-w-[190px]">
          {presets.map(preset => (
            <SelectItem
              key={preset.name}
              value={preset.name}
              className="text-[12px]"
              // 悬停看完整规则，免得同名前缀的两个条件分不清
              title={formatRule(preset.request.rule)}
            >
              {preset.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 px-2 text-[12px]"
        data-fork-preset-edit
        disabled={empty || !selected}
        title={selected ? SCREEN_PRESET_TEXTS_ZH.editPreset : SCREEN_PRESET_TEXTS_ZH.editDisabled}
        onClick={() => {
          if (selected) onEdit(selected)
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
        {SCREEN_PRESET_TEXTS_ZH.edit}
      </Button>
    </div>
  )
}

export default ScreenPresetMenu
