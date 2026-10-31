import type { WindowMetadata } from '../../shared/window-metadata'
import type { SourceResource } from './types'

/** A poll may supersede only metadata that was already known when it began. */
export function metadataAfterPoll(current: ReadonlyMap<string, WindowMetadata>, started: ReadonlyMap<string, WindowMetadata>, sourceIds: readonly string[]) {
  const sources = new Set(sourceIds)
  return new Map([...current].filter(([key, value]) => !sources.has(key.slice(0, key.indexOf('/'))) || started.get(key) !== value))
}

/** Live endpoint metadata wins over an older or slow all-source poll. */
export function mergeLiveResources(sources: readonly SourceResource[], metadata: ReadonlyMap<string, WindowMetadata>): SourceResource[] {
  return sources.map(source => ({ ...source, spaces: source.spaces.map(space => ({ ...space,
    windows: space.windows.map(window => {
      const live = metadata.get(`${source.id}/${window.id}`)
      if (!live) return window
      return { ...live, panes: live.panes.map(pane => ({ ...pane,
        // The endpoint only includes titles for agent panes. Keep ordinary
        // shell titles from session.snapshot until that API reports a change.
        terminalTitle: pane.terminalTitle ?? window.panes?.find(previous => previous.id === pane.id)?.terminalTitle,
      })) }
    }),
  })) }))
}
