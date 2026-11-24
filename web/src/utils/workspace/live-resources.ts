import type { WindowMetadata } from '../../../../shared/window-metadata'
import type { SourceResource } from '../../api/types'

export type LiveWindowMetadata = WindowMetadata | null

/** A failed or pending discovery cannot prove that a native window is closed. */
export function windowIsClosed(
  source: SourceResource | undefined,
  windowId: string,
  live?: LiveWindowMetadata,
) {
  return (
    live === null ||
    (!!source &&
      !live &&
      source.status === 'online' &&
      !source.error &&
      !source.spaces.some((space) => space.windows.some((window) => window.id === windowId)))
  )
}

/** A listing may supersede only metadata published before its read began. */
export function metadataAfterListing(
  current: ReadonlyMap<string, LiveWindowMetadata>,
  publishedAt: ReadonlyMap<string, number>,
  listings: readonly Pick<SourceResource, 'id' | 'readAt'>[],
) {
  const readAt = new Map(listings.map((listing) => [listing.id, listing.readAt]))
  return new Map(
    [...current].filter(([key]) => {
      const read = readAt.get(key.slice(0, key.indexOf('/')))
      return read === undefined || (publishedAt.get(key) ?? 0) > read
    }),
  )
}

/** The listings that are news: a push and a request may overtake each other. */
export function newerListings(
  held: readonly SourceResource[],
  incoming: readonly SourceResource[],
): SourceResource[] {
  return incoming.filter(
    (listing) => !held.some((known) => known.id === listing.id && known.readAt > listing.readAt),
  )
}

/** Live endpoint metadata wins over a listing read before it. */
export function mergeLiveResources(
  sources: readonly SourceResource[],
  metadata: ReadonlyMap<string, LiveWindowMetadata>,
): SourceResource[] {
  return sources.map((source) => ({
    ...source,
    spaces: source.spaces.map((space) => ({
      ...space,
      windows: space.windows
        .filter((window) => metadata.get(`${source.id}/${window.id}`) !== null)
        .map((window) => {
          const live = metadata.get(`${source.id}/${window.id}`)
          if (!live) return window
          return {
            ...live,
            panes: live.panes.map((pane) => ({
              ...pane,
              // A pane the server has no title for yet keeps the listed one.
              terminalTitle:
                pane.terminalTitle ??
                window.panes.find((previous) => previous.id === pane.id)?.terminalTitle,
            })),
          }
        }),
    })),
  }))
}
