import { useEffect, useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { Button } from '@panwatch/base-ui/components/ui/button'
import { Input } from '@panwatch/base-ui/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@panwatch/base-ui/components/ui/dialog'
import {
  PRESET_NAME_MAX,
  SCREEN_PRESET_TEXTS_ZH,
  presetNameError,
} from '@/lib/screen-presets'

/**
 * fork：保存条件时输入名字的小弹窗（用户反馈 2026-10-20 第 1 条）。
 *
 * 「名字就是文件名规则」：名字会直接变成服务器上的 `data/screen_presets/<名字>.json`，
 * 所以输入框与后端用**同一套**规则（`presetNameError`）拦：空、超过 10 个字符、
 * 含 `/ \ : * ? " < > |`、以 `.` 开头结尾。三条都在输入框下面直接说清楚，
 * 不要等点了确定才报错。
 *
 * 名字重复时**不在这里问**：外层（页面）知道当前列表，由它弹「覆盖？」确认，
 * 这样弹窗只负责「拿一个合法的名字」。
 */
export function SaveConditionDialog({
  open,
  onOpenChange,
  defaultName = '',
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 打开时预填的名字（保存过的条件再用「保存」时方便微调） */
  defaultName?: string
  /** 返回 true 表示已保存（弹窗自己关），false 表示用户放弃（留在弹窗里） */
  onSave: (name: string) => Promise<boolean>
}) {
  const [text, setText] = useState(defaultName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setText(defaultName)
      setSaving(false)
      setError(null)
    }
  }, [open, defaultName])

  const nameError = presetNameError(text)
  const disabled = saving || Boolean(nameError)

  const submit = async () => {
    if (nameError) {
      setError(nameError)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const done = await onSave(text.trim())
      if (done) onOpenChange(false)
    } catch (exc) {
      setError(SCREEN_PRESET_TEXTS_ZH.saveFailed(exc instanceof Error ? exc.message : String(exc)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={next => (!next && saving ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-[420px]" data-fork-screen-save>
        <DialogHeader>
          <DialogTitle>{SCREEN_PRESET_TEXTS_ZH.saveTitle}</DialogTitle>
          <DialogDescription>{SCREEN_PRESET_TEXTS_ZH.saveDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">{SCREEN_PRESET_TEXTS_ZH.nameLabel}</span>
            <span className="text-[10px] text-muted-foreground/70" data-fork-preset-counter>
              {SCREEN_PRESET_TEXTS_ZH.nameCounter([...text.trim()].length)}
            </span>
          </div>
          <Input
            autoFocus
            value={text}
            maxLength={PRESET_NAME_MAX}
            placeholder={SCREEN_PRESET_TEXTS_ZH.namePlaceholder}
            data-fork-preset-name
            aria-label={SCREEN_PRESET_TEXTS_ZH.nameLabel}
            aria-invalid={Boolean(nameError)}
            onChange={event => {
              setText(event.target.value)
              setError(null)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            className="h-8 text-[12px]"
          />
          {nameError ? (
            <div className="text-[11px] text-destructive" data-fork-preset-error>
              {nameError}
            </div>
          ) : null}
          {error ? (
            <div className="text-[11px] text-destructive" data-fork-preset-error>
              {error}
            </div>
          ) : null}
        </div>

        {/* 按钮行与输入框之间留出间距并加一条分隔线 —— 用户反馈「确认按钮行和输入框贴在一起了」 */}
        <div className="mt-4 flex items-center justify-end gap-1.5 border-t border-border/60 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[12px]"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            {SCREEN_PRESET_TEXTS_ZH.cancel}
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-[12px]"
            disabled={disabled}
            onClick={() => void submit()}
            data-fork-preset-confirm
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {SCREEN_PRESET_TEXTS_ZH.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SaveConditionDialog
