import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { api, apiContext, apiRevision, apiUrl, isCurrentApi } from './api'

export async function mediaTicket(path: string, download = false, context = apiContext(), signal?: AbortSignal) {
  const resource = apiUrl(path, context)
  const root = new URL(context.base)
  if (resource.search || !/^api\/(?:files|backgrounds|downloads)\/[^/]+$/.test(resource.pathname.slice(root.pathname.length)))
    throw new Error('Invalid Canvas media path')
  const original = `/${resource.pathname.slice(root.pathname.length)}`
  const ticket = await api<{ url: string; expiresAt: number }>('/api/media-tickets', {
    method: 'POST', body: JSON.stringify({ path: original, download }), signal,
  }, context)
  const url = apiUrl(ticket.url, context)
  if (!url.pathname.startsWith(`${root.pathname}api/media/`) || url.search || !Number.isFinite(ticket.expiresAt))
    throw new Error('Invalid Canvas media ticket')
  return { url: url.href, expiresAt: ticket.expiresAt }
}

/** Mounted previews renew their scoped URL without retaining the account token in DOM. */
export function useMediaUrl(path: MaybeRefOrGetter<string | undefined>) {
  const url = ref(''), error = ref<unknown>()
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let serial = 0
  async function renew() {
    request?.abort(); clearTimeout(timer)
    const value = toValue(path), current = ++serial, context = apiContext()
    if (!value || !context.token) { url.value = ''; return }
    const controller = request = new AbortController(); error.value = undefined
    try {
      const ticket = await mediaTicket(value, false, context, controller.signal)
      if (current !== serial || !isCurrentApi(context)) return
      url.value = ticket.url
      timer = setTimeout(() => void renew(), Math.max(1000, ticket.expiresAt - Date.now() - 30_000))
    } catch (reason) { if (current === serial && isCurrentApi(context) && !controller.signal.aborted) error.value = reason }
  }
  watch([() => toValue(path), apiRevision], () => { url.value = ''; void renew() }, { immediate: true })
  onBeforeUnmount(() => { serial++; request?.abort(); clearTimeout(timer) })
  return { url: computed(() => url.value), error, retry: renew }
}

export async function downloadMedia(path: string, filename: string) {
  const context = apiContext(), ticket = await mediaTicket(path, true, context)
  if (!isCurrentApi(context)) return
  const anchor = document.createElement('a')
  anchor.href = ticket.url; anchor.download = filename; anchor.hidden = true
  anchor.referrerPolicy = 'no-referrer'
  ;(document.fullscreenElement || document.body).append(anchor)
  anchor.click(); anchor.remove()
}
