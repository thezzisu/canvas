import { shallowRef } from 'vue'
import type { WindowMetadata } from '../../../../shared/window-metadata'
import type { LiveWindowMetadata } from '../../utils/workspace/live-resources'
import { refreshReadFocus } from './terminal-read-focus'
import { windowSessions, type Session } from './terminal-session'

/** What connected terminals know of their windows, ahead of the next listing; null once removed. */
export const liveTerminalMetadata = shallowRef<ReadonlyMap<string, LiveWindowMetadata>>(new Map())
/** When each was published, on the server's clock: a listing read later supersedes it. */
export const metadataPublishedAt = new Map<string, number>()
/** The latest time seen on the server's clock, for a removal this browser makes itself. */
let serverSeen = 0
export function sawServerTime(at: unknown): number {
  if (typeof at !== 'number' || !Number.isFinite(at)) return serverSeen
  serverSeen = Math.max(serverSeen, at)
  return at
}
/** The sources the workspace has; metadata of any other is not kept. */
export const metadataSources = new Set<string>()

export const metadataKey = (resource: { sourceId: string; windowId: string }) =>
  `${resource.sourceId}/${resource.windowId}`

/** Records a window's metadata from this session's connection, or forgets it without one. */
export function updateMetadata(session: Session, metadata?: WindowMetadata, at?: unknown) {
  const { sourceId, windowId } = session.resource
  if (metadata && !metadataSources.has(sourceId)) return
  session.metadata = metadata
  if (metadata) session.metadataAt = sawServerTime(at)
  refreshReadFocus()
  if (metadata) session.lastName = metadata.name
  // A native window can move between spaces while its previous view retires.
  // Closing that view must not erase metadata from its replacement connection.
  let publisher = session
  if (!metadata && metadataSources.has(sourceId)) {
    const other = [...windowSessions(sourceId, windowId)].find(
      (other) => other !== session && other.connection?.open && other.metadata,
    )
    if (other) {
      publisher = other
      metadata = other.metadata
    }
  }
  const key = metadataKey(session.resource)
  const previous = liveTerminalMetadata.value.get(key)
  if (previous === null) return
  if (metadata) metadataPublishedAt.set(key, publisher.metadataAt ?? 0)
  if (JSON.stringify(previous) === JSON.stringify(metadata)) return
  const next = new Map(liveTerminalMetadata.value)
  if (metadata) next.set(key, metadata)
  else next.delete(key)
  liveTerminalMetadata.value = next
}
