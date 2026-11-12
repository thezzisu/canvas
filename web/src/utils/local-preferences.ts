import { systemCanvases } from './canvas/canvas-location'
const objectPrefixes = [
  'canvas:view:',
  'canvas:overview:',
  'canvas:file-mode:',
  'canvas:file-view:',
  'canvas:note-scroll:',
  'canvas:card-zoom:',
  'canvas:capture-view:',
]
const terminalPrefixes = ['canvas:terminal-settings:', 'canvas:window-canvas:']
const browserViews = new Set([
  'canvas:view:minimap',
  'canvas:view:navigation',
  'canvas:view:auto-yield-controls',
  'canvas:view:features',
])

/** Storage cleanup is an explicit lifecycle operation, not another reactive mirror. */
function removeWhere(matches: (key: string) => boolean, storage?: Storage) {
  try {
    storage ||= localStorage
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      if (key && matches(key)) storage.removeItem(key)
    }
  } catch {
    /* An unavailable browser store must not prevent navigation. */
  }
}
function terminalInstance(key: string): string | undefined {
  const prefix = terminalPrefixes.find((prefix) => key.startsWith(prefix))
  if (!prefix) return
  try {
    const identity: unknown = JSON.parse(key.slice(prefix.length))
    if (
      Array.isArray(identity) &&
      identity.length === 7 &&
      identity.every((value) => typeof value === 'string')
    )
      return identity[0]
  } catch {
    /* Unrelated keys are never adopted as Canvas preferences. */
  }
}

/** Removing or repointing an instance retires only its local object preferences. */
export function clearInstancePreferences(instance: string, storage?: Storage) {
  removeWhere(
    (key) =>
      key === `canvas:last-canvas:${instance}` ||
      terminalInstance(key) === instance ||
      objectPrefixes.some((prefix) => key.startsWith(`${prefix}${instance}:`)),
    storage,
  )
}

/** Object preferences cannot outlive a registered frontend instance. This also
 * retires unowned startup-UUID records without guessing which server owned them. */
export function pruneInstancePreferences(instances: readonly { id: string }[], storage?: Storage) {
  const valid = new Set(instances.map((instance) => instance.id))
  removeWhere((key) => {
    if (browserViews.has(key)) return false
    if (terminalPrefixes.some((prefix) => key.startsWith(prefix)))
      return !valid.has(terminalInstance(key) || '')
    const prefix = [...objectPrefixes, 'canvas:last-canvas:', 'canvas:capture-hidden:'].find(
      (prefix) => key.startsWith(prefix),
    )
    if (!prefix) return false
    return !valid.has(key.slice(prefix.length).split(':')[0]!)
  }, storage)
}

/** An authoritative canvas list may retire cameras; filtering/offline views may not. */
export function pruneCanvasLocations(
  instance: string,
  canvases: readonly { id: string }[],
  storage?: Storage,
) {
  const prefix = `canvas:view:${instance}:`,
    valid = new Set<string>([...systemCanvases, ...canvases.map((canvas) => canvas.id)])
  removeWhere(
    (key) => key.startsWith(prefix) && !valid.has(key.slice(prefix.length).replace(/:free$/, '')),
    storage,
  )
  try {
    storage ||= localStorage
    const key = `canvas:last-canvas:${instance}`,
      canvas = storage.getItem(key)
    if (canvas && !valid.has(canvas)) storage.removeItem(key)
  } catch {
    /* Last-view restoration is optional. */
  }
}
