import { effectScope, shallowReactive, type Ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import { apiContext, apiUrl } from '../../api/api'
import { discardFrames } from '../files/retained-frame'
import { forgetCaptureTrust } from './capture-trust'
import { captureUrl } from '../../utils/terminal/capture-url'
import type { CaptureDescriptor } from '../../../../shared/capture'
import type { Source, SourceResource } from '../../api/types'

/** Whether a capture exists is shared server state; showing it is local to this browser. */
export interface CapturedApp extends Omit<CaptureDescriptor, 'path' | 'windowId'> {
  url: string
  visible: boolean
}
interface Capture extends Omit<CapturedApp, 'visible'> {
  viewKey: string
  hidden: Ref<string | null>
  dispose(): void
}
const captures = shallowReactive(new Map<string, Capture>())
const key = (sourceId: string, windowId: string) => `${sourceId}/${windowId}`
const viewPrefix = (instance: string) => `canvas:capture-view:${instance}:`

export function capturedApp(sourceId: string, windowId: string): CapturedApp | undefined {
  const capture = captures.get(key(sourceId, windowId))
  if (!capture) return
  const { hidden, viewKey: _, dispose: __, ...app } = capture
  return { ...app, visible: hidden.value !== capture.id }
}
export function setCaptureVisible(sourceId: string, windowId: string, visible: boolean) {
  const capture = captures.get(key(sourceId, windowId))
  if (capture) capture.hidden.value = visible ? null : capture.id
}
function forget(entry: string) {
  const capture = captures.get(entry)
  if (!capture) return
  // Another page may already have saved a newer capture for the same window.
  try {
    if (localStorage.getItem(capture.viewKey) === capture.id)
      localStorage.removeItem(capture.viewKey)
  } catch {
    /* Optional cleanup. */
  }
  capture.dispose()
  captures.delete(entry)
  discardFrames(`capture:${capture.id}`)
}
export function receiveCapture(
  sourceId: string,
  windowId: string,
  message: Record<string, unknown>,
): boolean {
  if (message.type !== 'capture') return false
  if (message.capture === null) {
    const entry = key(sourceId, windowId)
    forgetCaptureTrust(sourceId, windowId)
    if (captures.has(entry)) forget(entry)
    else
      try {
        localStorage.removeItem(viewPrefix(apiContext().id) + entry)
      } catch {
        /* Optional cleanup. */
      }
    return true
  }
  if (!message.capture || typeof message.capture !== 'object') return true
  const current = message.capture as Record<string, unknown>
  if (
    typeof current.id !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(current.id) ||
    typeof current.path !== 'string' ||
    typeof current.paneId !== 'string' ||
    typeof current.title !== 'string' ||
    current.windowId !== windowId
  )
    return true
  try {
    const url = captureUrl(apiUrl(`/api/capture/${current.id}/`), current.path)
    if (!url) return true
    const entry = key(sourceId, windowId),
      previous = captures.get(entry)
    if (
      previous?.id === current.id &&
      previous.url === url.href &&
      previous.title === current.title &&
      previous.preview === current.preview
    )
      return true
    if (previous && previous.id !== current.id) {
      forgetCaptureTrust(sourceId, windowId)
      forget(entry)
    }
    // At most one saved value per native window, not one key per random lease.
    // The scope belongs to the live capture and ends with it, not a card mount.
    const scope = previous?.id === current.id ? undefined : effectScope(true)
    const viewKey =
      previous?.id === current.id ? previous.viewKey : viewPrefix(apiContext().id) + entry
    const hidden = scope
      ? scope.run(() =>
          useLocalStorage<string | null>(viewKey, null, {
            writeDefaults: false,
            listenToStorageChanges: false,
            flush: 'sync',
            onError() {},
          }),
        )!
      : previous!.hidden
    captures.set(entry, {
      id: current.id,
      url: url.href,
      title: current.title.slice(0, 120),
      paneId: current.paneId,
      viewKey,
      hidden,
      dispose: scope ? () => scope.stop() : previous!.dispose,
      ...(current.preview === 'static' ? { preview: 'static' } : {}),
    })
  } catch {
    /* Invalid capture messages never become iframe addresses. */
  }
  return true
}
/** Account or instance changes end every session-scoped frame, including PDF viewers. */
export function clearCaptures() {
  for (const capture of captures.values()) capture.dispose()
  captures.clear()
  discardFrames()
}
export function removeCaptures(sourceId: string, windowId?: string) {
  if (windowId !== undefined) {
    forgetCaptureTrust(sourceId, windowId)
    forget(key(sourceId, windowId))
    return
  }
  for (const entry of [...captures.keys()])
    if (entry.startsWith(sourceId + '/')) {
      forgetCaptureTrust(sourceId, entry.slice(sourceId.length + 1))
      forget(entry)
    }
}

export function pruneCaptureViews(
  instance: string,
  sources: readonly Source[],
  resources: readonly SourceResource[],
  storage?: Storage,
) {
  const configured = new Set(sources.map((source) => source.id))
  const online = new Map(
    resources
      .filter((source) => source.status === 'online' && !source.error)
      .map((source) => [
        source.id,
        new Set(source.spaces.flatMap((space) => space.windows.map((window) => window.id))),
      ]),
  )
  try {
    storage ||= localStorage
    const prefix = viewPrefix(instance)
    for (let index = storage.length - 1; index >= 0; index--) {
      const entry = storage.key(index)
      if (!entry?.startsWith(prefix)) continue
      const id = entry.slice(prefix.length),
        separator = id.indexOf('/'),
        source = id.slice(0, separator),
        window = id.slice(separator + 1)
      if (!configured.has(source) || (online.has(source) && !online.get(source)!.has(window)))
        storage.removeItem(entry)
    }
  } catch {
    /* A source outage must not prevent local presentation. */
  }
}
