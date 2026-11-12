import type { CanvasNotification } from '../../../../shared/notification'
import {
  canPlayNotificationSound,
  notificationSystemEnabled,
  playNotificationSound,
  showSystemNotification,
} from '../../composables/notifications/notification-settings'

type Focus = { sourceId: string; windowId: string; paneId?: string }
type Delivery = { backend: string; id: string; sound?: boolean; system?: boolean; quiet?: boolean }
const effectsKey = 'canvas:notifications:effects'
const focusKey = 'canvas:notifications:focus'
const badgeKey = 'canvas:notifications:badge-owner'
const ownerKey = (owner: string) => `canvas:notifications:owner:${owner}`

// Retire the former per-startup caches. The fixed runtime keys below cannot grow
// with server restarts and are separate from persistent notification preferences.
try {
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (
      key?.startsWith('canvas:notifications:delivered:') ||
      key?.startsWith('canvas:notifications:focus:')
    )
      localStorage.removeItem(key)
  }
} catch {
  /* Optional runtime storage may be unavailable. */
}

/** The browser releases this lease even when a tab closes without cleanup. */
export function holdNotificationOwner(owner: string) {
  const controller = new AbortController()
  let release = () => {}
  const lifetime = new Promise<void>((resolve) => {
    release = resolve
  })
  if (navigator.locks)
    void navigator.locks
      .request(ownerKey(owner), { signal: controller.signal }, () => lifetime)
      .catch(() => {})
  return () => {
    release()
    controller.abort()
  }
}
async function ownerAlive(owner: unknown) {
  if (typeof owner !== 'string' || !navigator.locks) return false
  const locks = await navigator.locks.query()
  return !!locks.held?.some((lock) => lock.name === ownerKey(owner))
}

async function locked(name: string, action: () => void | Promise<void>) {
  try {
    if (navigator.locks) await navigator.locks.request(name, action)
    else if (document.hasFocus()) await action()
  } catch {
    /* Optional browser effects never interrupt the workspace. */
  }
}
function read(key: string) {
  // A failed read aborts the enclosing locked operation before effects run; it
  // must not look like an empty deduplication ledger and produce duplicates.
  return JSON.parse(localStorage.getItem(key) || 'null')
}

/** Remember only the currently interacting pane, scoped to this frontend origin. */
export function syncNotificationFocus(
  instance: string,
  owner: string,
  focus?: Focus,
  valid = () => true,
) {
  return locked(effectsKey, () => {
    // A foreground page with no terminal focus still replaces the preceding
    // page's attention. Its later blur may remove only its own record.
    if (valid() && document.hasFocus() && !document.hidden)
      localStorage.setItem(focusKey, JSON.stringify({ backend: instance, owner, ...focus }))
    else if (read(focusKey)?.owner === owner) localStorage.removeItem(focusKey)
  })
}

/** The last foreground tab owns the app badge; another tab cannot clear it. */
export function updateNotificationBadge(
  owner: string,
  count: number,
  claim = false,
  release = false,
) {
  const badge = navigator as Navigator & {
    setAppBadge?(count: number): Promise<void>
    clearAppBadge?(): Promise<void>
  }
  if (!badge.setAppBadge || !badge.clearAppBadge) return Promise.resolve()
  return locked(badgeKey, async () => {
    const stored = read(badgeKey),
      previous = (await ownerAlive(stored)) ? stored : undefined
    if (release) {
      if (stored !== owner) return
      localStorage.removeItem(badgeKey)
      await badge.clearAppBadge!()
      return
    }
    if (claim || !previous) localStorage.setItem(badgeKey, JSON.stringify(owner))
    if (read(badgeKey) === owner) await (count ? badge.setAppBadge!(count) : badge.clearAppBadge!())
  })
}
export function isBadgeOwnerChange(event: StorageEvent) {
  return event.key === badgeKey && event.newValue === null
}

/** Serialize each channel separately, so a muted tab cannot consume another's sound. */
export async function deliverNotificationEffects(
  instance: string,
  event: CanvasNotification,
  options: {
    title: string
    body: string
    url: string
    quiet?: boolean
    suppressSystem?: boolean
    valid(): boolean
  },
) {
  const system =
    notificationSystemEnabled.value &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  const registration =
    system && !options.quiet && !options.suppressSystem
      ? await navigator.serviceWorker?.getRegistration().catch(() => undefined)
      : undefined
  if (!options.valid() || (!options.quiet && !canPlayNotificationSound() && !registration?.active))
    return
  await locked(effectsKey, async () => {
    if (!options.valid()) return
    const value = read(effectsKey)
    const recent: Delivery[] = Array.isArray(value?.events)
      ? value.events
          .slice(-256)
          .filter(
            (item: Delivery) =>
              item && typeof item.backend === 'string' && typeof item.id === 'string',
          )
      : []
    const record = recent.find((item) => item.backend === instance && item.id === event.id) || {
      backend: instance,
      id: event.id,
    }
    if (!recent.includes(record)) recent.push(record)
    if (recent.length > 256) recent.shift()
    const storedFocus = read(focusKey)
    const focus: Focus | undefined =
      storedFocus?.backend === instance && (await ownerAlive(storedFocus.owner))
        ? storedFocus
        : undefined
    if (!options.valid()) return
    const now = Date.now(),
      backends = new Set(recent.map((item) => item.backend))
    const sounds = new Map(
      Object.entries(value?.sounds || {}).filter(
        (entry): entry is [string, number] =>
          backends.has(entry[0]) &&
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1]) &&
          now >= entry[1] &&
          now - entry[1] < 750,
      ),
    )
    const attended =
      focus?.sourceId === event.sourceId &&
      focus.windowId === event.windowId &&
      (!event.paneId || event.paneId === focus.paneId)
    if (options.quiet || (attended && event.kind !== 'done')) record.quiet = true
    if (
      !record.quiet &&
      !record.sound &&
      canPlayNotificationSound() &&
      (event.kind === 'attention' || event.kind === 'done')
    ) {
      if (!sounds.has(instance)) {
        playNotificationSound(event.kind)
        sounds.set(instance, now)
      }
      record.sound = true
    }
    if (
      !record.quiet &&
      !record.system &&
      !options.suppressSystem &&
      !attended &&
      options.valid() &&
      notificationSystemEnabled.value &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      registration?.active
    ) {
      try {
        await showSystemNotification(registration, options.title, {
          body: options.body,
          tag: `canvas:${instance}:${event.sourceId}:${event.paneId || event.windowId || event.id}`,
          data: {
            type: 'canvas-notification',
            url: options.url,
            instance,
            sourceId: event.sourceId,
            windowId: event.windowId,
          },
        })
        record.system = true
      } catch {
        /* A different live tab may still deliver this channel. */
      }
    }
    localStorage.setItem(
      effectsKey,
      JSON.stringify({ events: recent, sounds: Object.fromEntries(sounds) }),
    )
  })
}
