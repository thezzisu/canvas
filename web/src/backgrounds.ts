import { computed, onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { apiContext, apiFetch, apiRevision, ApiError, isCurrentApi, requireCurrentApi } from './api'
import { BackgroundCache } from './background-cache'
import { t } from './i18n'

const cache = new BackgroundCache(async (path, signal) => {
  const context = apiContext(), response = await apiFetch(path, { signal }, context)
  if (!response.ok) throw new ApiError(response.status, t('common.requestFailed', { status: response.status }))
  const blob = await response.blob()
  requireCurrentApi(context)
  return blob
})
watch(apiRevision, () => cache.clear(), { flush: 'sync' })
export const retainBackgrounds = (paths: Iterable<string>) => cache.retain(paths)

/** Switching canvases reuses the loaded image; changing sessions drops every object URL. */
export function useBackgroundUrl(path: MaybeRefOrGetter<string | undefined>) {
  const url = ref(''), error = ref<unknown>()
  let serial = 0
  function load() {
    const value = toValue(path), current = ++serial, context = apiContext()
    error.value = undefined
    url.value = value && context.token ? cache.peek(value) || '' : ''
    if (!value || !context.token) return
    void cache.get(value).then(result => {
      if (current === serial && isCurrentApi(context)) url.value = result
    }).catch(reason => { if (current === serial && isCurrentApi(context) && reason?.name !== 'AbortError') error.value = reason })
  }
  watch([() => toValue(path), apiRevision], load, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => { serial++ })
  return { url: computed(() => url.value), error, retry: load }
}
