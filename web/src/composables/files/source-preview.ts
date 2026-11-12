import { ref } from 'vue'
import { api, apiContext, apiUrl, isCurrentApi } from '../../api/api'
import { t } from '../../plugins/i18n'
import { notify } from '../notify'
import { requestTrustedPreview } from './trusted-preview'

/** Open synchronously so an authenticated request cannot consume the browser's user gesture. */
export function useSourcePreview() {
  const busy = ref(false)
  function open(path: string, filename: string) {
    if (/\.html?$/iu.test(filename))
      requestTrustedPreview(filename, () => {
        void launch(path, filename)
      })
    else void launch(path, filename)
  }
  async function launch(path: string, filename: string) {
    if (busy.value) return
    const tab = window.open('about:blank', '_blank')
    if (!tab) {
      notify.warning(t('panels.preview.popupBlocked'))
      return
    }
    tab.opener = null
    tab.document.title = filename
    tab.document.body.textContent = t('panels.preview.siteStarting')
    tab.document.documentElement.style.colorScheme = 'dark'
    const context = apiContext()
    busy.value = true
    try {
      const result = await api<{ id: string; url: string }>(
        `${path}/preview`,
        {
          method: 'POST',
          body: JSON.stringify({ apiBase: context.base }),
        },
        context,
      )
      const expected = apiUrl(`/api/capture/${result.id}/`, context),
        url = new URL(result.url, expected)
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(result.id) ||
        url.origin !== expected.origin ||
        !url.pathname.startsWith(expected.pathname) ||
        url.username ||
        url.password ||
        !['http:', 'https:'].includes(url.protocol)
      )
        throw new Error('Invalid preview URL')
      if (!tab.closed) tab.location.replace(url.href)
    } catch {
      tab.close()
      if (isCurrentApi(context)) notify.error(t('panels.preview.siteFailed'))
    } finally {
      busy.value = false
    }
  }
  return { busy, open }
}
