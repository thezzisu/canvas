import type { CanvasNotification } from '../../shared/notification'
import { canPlayNotificationSound, notificationSystemEnabled, playNotificationSound } from './notification-settings'

type Focus = { sourceId: string; windowId: string; paneId?: string }
type Delivery = { id: string; sound?: boolean; system?: boolean; quiet?: boolean }
const focusKey = (instance: string) => `canvas:notifications:focus:${instance}`
const lockKey = (instance: string) => `canvas:notifications:${instance}`
const badgeKey = 'canvas:notifications:badge-owner'
const ownerKey = (owner: string) => `canvas:notifications:owner:${owner}`

/** The browser releases this lease even when a tab closes without cleanup. */
export function holdNotificationOwner(owner: string) {
  const controller = new AbortController()
  let release = () => {}
  const lifetime = new Promise<void>(resolve => { release = resolve })
  if (navigator.locks) void navigator.locks.request(ownerKey(owner), { signal: controller.signal }, () => lifetime).catch(() => {})
  return () => { release(); controller.abort() }
}
async function ownerAlive(owner: unknown) {
  if (typeof owner !== 'string' || !navigator.locks) return false
  const locks = await navigator.locks.query()
  return !!locks.held?.some(lock => lock.name === ownerKey(owner))
}

async function locked(name: string, action: () => void | Promise<void>) {
  try {
    if (navigator.locks) await navigator.locks.request(name, action)
    else if (document.hasFocus()) await action()
  } catch { /* Optional browser effects never interrupt the workspace. */ }
}
function read(key: string) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') } catch { return null }
}

/** Remember only the currently interacting pane, scoped to this frontend origin. */
export function syncNotificationFocus(instance: string, owner: string, focus?: Focus, valid = () => true) {
  return locked(lockKey(instance), () => {
    const key = focusKey(instance)
    if (focus && valid() && document.hasFocus() && !document.hidden) localStorage.setItem(key, JSON.stringify({ owner, ...focus }))
    else if (read(key)?.owner === owner || valid() && document.hasFocus() && !document.hidden) localStorage.removeItem(key)
  })
}

/** The last foreground tab owns the app badge; another tab cannot clear it. */
export function updateNotificationBadge(owner: string, count: number, claim = false, release = false) {
  const badge = navigator as Navigator & { setAppBadge?(count: number): Promise<void>; clearAppBadge?(): Promise<void> }
  if (!badge.setAppBadge || !badge.clearAppBadge) return Promise.resolve()
  return locked(badgeKey, async () => {
    const stored = read(badgeKey), previous = await ownerAlive(stored) ? stored : undefined
    if (release) {
      if (stored !== owner) return
      localStorage.removeItem(badgeKey); await badge.clearAppBadge!(); return
    }
    if (claim || !previous) localStorage.setItem(badgeKey, JSON.stringify(owner))
    if (read(badgeKey) === owner) await (count ? badge.setAppBadge!(count) : badge.clearAppBadge!())
  })
}
export function isBadgeOwnerChange(event: StorageEvent) { return event.key === badgeKey && event.newValue === null }

/** Serialize each channel separately, so a muted tab cannot consume another's sound. */
export async function deliverNotificationEffects(instance: string, event: CanvasNotification, options: {
  title: string; body: string; url: string; quiet?: boolean; valid(): boolean
}) {
  const system = notificationSystemEnabled.value && typeof Notification !== 'undefined' && Notification.permission === 'granted'
  const registration = system && !options.quiet ? await navigator.serviceWorker?.getRegistration().catch(() => undefined) : undefined
  if (!options.valid() || !options.quiet && !canPlayNotificationSound() && !registration?.active) return
  await locked(lockKey(instance), async () => {
    if (!options.valid()) return
    const key = `canvas:notifications:delivered:${instance}`, value = read(key)
    const recent: Delivery[] = Array.isArray(value?.events) ? value.events.filter((item: Delivery) => item && typeof item.id === 'string').slice(-64) : []
    const record = recent.find(item => item.id === event.id) || { id: event.id }
    if (!recent.includes(record)) recent.push(record)
    const storedFocus = read(focusKey(instance))
    const focus: Focus | undefined = await ownerAlive(storedFocus?.owner) ? storedFocus : undefined
    if (!options.valid()) return
    if (options.quiet || focus?.sourceId === event.sourceId && focus.windowId === event.windowId && (!event.paneId || event.paneId === focus.paneId)) record.quiet = true
    if (record.quiet) {
      localStorage.setItem(key, JSON.stringify({ events: recent.slice(-64), soundedAt: value?.soundedAt || 0 })); return
    }
    let soundedAt = typeof value?.soundedAt === 'number' ? value.soundedAt : 0
    if (!record.sound && canPlayNotificationSound() && (event.kind === 'attention' || event.kind === 'done')) {
      const now = Date.now()
      if (now - soundedAt >= 750) { playNotificationSound(event.kind); soundedAt = now }
      record.sound = true
    }
    if (!record.system && options.valid() && notificationSystemEnabled.value && typeof Notification !== 'undefined' && Notification.permission === 'granted' && registration?.active) {
      try {
        await registration.showNotification(options.title, {
          body: options.body, icon: new URL('icons/icon-192.png', location.href).href,
          tag: `canvas:${instance}:${event.sourceId}:${event.paneId || event.windowId || event.id}`,
          silent: true, data: { type: 'canvas-notification', url: options.url, instance, sourceId: event.sourceId, windowId: event.windowId },
        })
        record.system = true
      } catch { /* A different live tab may still deliver this channel. */ }
    }
    localStorage.setItem(key, JSON.stringify({ events: recent.slice(-64), soundedAt }))
  })
}
