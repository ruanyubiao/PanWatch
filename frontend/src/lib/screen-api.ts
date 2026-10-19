/**
 * 条件选股接口调用（需求规格 §7.1）。
 *
 * ``fetchAPI`` 在传了 ``signal`` 时**不会**自己设超时（见 client.ts），所以选股
 * 要由调用方给 AbortController + 60s 定时器：全市场最坏情况（W=250 / MA250）
 * 后端要读约 120 万行，20s 默认超时会误杀。
 */
import { fetchAPI } from '@panwatch/api'
import type { ScreenRequest, ScreenResponse } from '@/lib/screen-rule'

export const SCREEN_TIMEOUT_MS = 60000

export function screenStocks(req: ScreenRequest, signal?: AbortSignal): Promise<ScreenResponse> {
  return fetchAPI<ScreenResponse>('/stocks/screen', {
    method: 'POST',
    body: JSON.stringify(req),
    signal,
    timeoutMs: SCREEN_TIMEOUT_MS,
  })
}

/** 给调用方用：一条带 60s 超时的 controller（外层取消时要一并 abort）。 */
export function createScreenAbort(outer?: AbortSignal): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), SCREEN_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort()
  outer?.addEventListener('abort', onOuterAbort)
  return {
    controller,
    dispose: () => {
      window.clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    },
  }
}
