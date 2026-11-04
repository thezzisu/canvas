import { ref } from 'vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import { api, apiContext, apiUrl, isCurrentApi } from './api'
import { t } from './i18n'

/** Open synchronously so an authenticated request cannot consume the browser's user gesture. */
export function useSourcePreview() {
  const busy = ref(false), toast = useToast()
  async function open(path: string, filename: string) {
    if (busy.value) return
    const tab = window.open('about:blank', '_blank')
    if (!tab) { toast.add({ title: t('panels.preview.popupBlocked'), color: 'warning' }); return }
    tab.opener = null
    tab.document.title = filename
    tab.document.body.textContent = t('panels.preview.siteStarting')
    tab.document.documentElement.style.colorScheme = 'dark'
    const context = apiContext()
    busy.value = true
    try {
      const result = await api<{ id: string; url: string }>(`${path}/preview`, {
        method: 'POST', body: JSON.stringify({ apiBase: context.base }),
      }, context)
      const expected = apiUrl(`/api/capture/${result.id}/`, context), url = new URL(result.url, expected)
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.id) || url.origin !== expected.origin || !url.pathname.startsWith(expected.pathname)
        || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid preview URL')
      if (!tab.closed) tab.location.replace(url.href)
    } catch {
      tab.close()
      if (isCurrentApi(context)) toast.add({ title: t('panels.preview.siteFailed'), color: 'error' })
    } finally { busy.value = false }
  }
  return { busy, open }
}
