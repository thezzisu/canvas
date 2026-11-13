import { shallowRef } from 'vue'
import type { WindowMetadata } from '../../../../shared/window-metadata'
import type { LiveWindowMetadata } from '../../utils/workspace/live-resources'
import { refreshReadFocus } from './terminal-read-focus'
import { windowSessions, type Session } from './terminal-session'

/** What connected terminals know of their windows, ahead of the next poll; null once removed. */
export const liveTerminalMetadata = shallowRef<ReadonlyMap<string, LiveWindowMetadata>>(new Map())
/** The sources the workspace has; metadata of any other is not kept. */
export const metadataSources = new Set<string>()

export const metadataKey = (resource: { sourceId: string; windowId: string }) =>
  `${resource.sourceId}/${resource.windowId}`

/** Records a window's metadata from this session's connection, or forgets it without one. */
export function updateMetadata(session: Session, metadata?: WindowMetadata) {
  const { sourceId, windowId } = session.resource
  if (metadata && !metadataSources.has(sourceId)) return
  session.metadata = metadata
  refreshReadFocus()
  if (metadata) session.lastName = metadata.name
  // A native window can move between spaces while its previous view retires.
  // Closing that view must not erase metadata from its replacement connection.
  metadata ??= metadataSources.has(sourceId)
    ? [...windowSessions(sourceId, windowId)].find(
        (other) => other !== session && other.connection?.open && other.metadata,
      )?.metadata
    : undefined
  const key = metadataKey(session.resource)
  const previous = liveTerminalMetadata.value.get(key)
  if (previous === null) return
  if (JSON.stringify(previous) === JSON.stringify(metadata)) return
  const next = new Map(liveTerminalMetadata.value)
  if (metadata) next.set(key, metadata)
  else next.delete(key)
  liveTerminalMetadata.value = next
}
