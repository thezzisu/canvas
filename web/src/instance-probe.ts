import { computed, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { isBuildInfo, type BuildInfo } from '../../shared/build-info'
import { isCanvasSession, normalizeApiBase, resolveApiUrl } from './instance-url'

export async function probeInstance(base: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<BuildInfo> {
  const response = await request(resolveApiUrl(normalizeApiBase(base), '/api/session'), {
    signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
  })
  if (!response.ok) throw new Error('instances.probeFailed')
  const value: unknown = await response.json()
  if (!isCanvasSession(value)) throw new Error('instances.probeFailed')
  const server = (value as { server?: unknown }).server
  if (!isBuildInfo(server)) throw new Error('instances.probeFailed')
  return server
}

/** Only the current normalized address can unlock a connection form. */
export function useInstanceProbe(address: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean> = true) {
  const base = computed(() => { try { return normalizeApiBase(toValue(address)) } catch { return '' } })
  const result = shallowRef<{ base: string; build: BuildInfo }>()
  const pending = ref(false), failed = ref(false), attempt = ref(0)
  watch([base, () => toValue(enabled), attempt], ([value, active], _previous, cleanup) => {
    result.value = undefined; failed.value = false; pending.value = !!value && active
    if (!value || !active) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void probeInstance(value, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])).then(build => {
        if (!controller.signal.aborted) result.value = { base: value, build }
      }).catch(() => { if (!controller.signal.aborted) failed.value = true })
        .finally(() => { if (!controller.signal.aborted) pending.value = false })
    }, 450)
    cleanup(() => { clearTimeout(timer); controller.abort() })
  }, { immediate: true, flush: 'sync' })
  return { base, result, pending, failed, retry: () => { attempt.value++ },
    ready: computed(() => !!result.value && result.value.base === base.value && toValue(enabled)) }
}
