import type { Source, SourceResource } from './types'

/** The native tab, not its name, canvas reference or browser tab, owns the preference. */
export function terminalIdentityKey(instance: string, source: Source, windowId: string) {
  return JSON.stringify([
    instance,
    source.id,
    source.runtime === 'core' ? `core:${source.transport}` : source.transport,
    source.transport === 'ssh' ? source.target?.trim() || '' : '',
    source.herdrSession?.trim() || '',
    source.herdrSocket?.trim() || '',
    windowId,
  ])
}

const prefixes = ['canvas:terminal-settings:', 'canvas:window-canvas:']
/** Remove individual confirmed-closed tabs; unrelated concurrent writes remain untouched. */
export function pruneTerminalPreferences(
  instance: string,
  sources: readonly Source[],
  resources: readonly SourceResource[],
  storage?: Storage,
) {
  const configured = new Map(sources.map((source) => [source.id, source]))
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
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index)
      const prefix = prefixes.find((prefix) => key?.startsWith(prefix))
      if (!key || !prefix) continue
      let identity: unknown
      try {
        identity = JSON.parse(key.slice(prefix.length))
      } catch {
        continue
      }
      if (
        !Array.isArray(identity) ||
        identity.length !== 7 ||
        identity.some((value) => typeof value !== 'string') ||
        identity[0] !== instance
      )
        continue
      const source = configured.get(identity[1]),
        windowId = identity[6]
      if (
        !source ||
        key !== prefix + terminalIdentityKey(instance, source, windowId) ||
        (online.has(source.id) && !online.get(source.id)!.has(windowId))
      )
        storage.removeItem(key)
    }
  } catch {
    /* Storage may be unavailable. */
  }
}
