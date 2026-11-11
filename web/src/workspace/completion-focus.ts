import { aggregateStatus, type ProgramStatus } from '../../../shared/status'
import { sameCompletion, type CompletionToken } from '../../../shared/completion'
import type { SourceResource } from '../api/types'

export interface WindowFocus {
  sourceId: string
  windowId: string
}
export interface PaneFocus extends WindowFocus {
  paneId: string
  painted?: CompletionToken
}
export interface FocusedStatus extends PaneFocus {
  status: ProgramStatus
}

export function samePane(a?: PaneFocus, b?: PaneFocus): boolean {
  return (
    !!a && !!b && a.sourceId === b.sourceId && a.windowId === b.windowId && a.paneId === b.paneId
  )
}

/** Retain the prior displayed state until the matching result has painted. */
export function focusedCompletionStatus(
  resources: readonly SourceResource[],
  focus: PaneFocus | undefined,
  previous?: FocusedStatus,
): FocusedStatus | undefined {
  if (!focus) return
  const source = resources.find(
    (source) => source.id === focus.sourceId && source.status === 'online' && !source.error,
  )
  const pane = source?.spaces
    .flatMap((space) => space.windows)
    .find((window) => window.id === focus.windowId)
    ?.panes?.find((pane) => pane.id === focus.paneId)
  if (!pane) return
  let status = pane.status
  if (status === 'done' && pane.completion) {
    if (sameCompletion(pane.completion, focus.painted)) status = 'idle'
    else if (samePane(focus, previous) && previous?.status !== 'done') status = previous!.status
  }
  return { ...focus, status }
}

/** Only the attended pane is projected; siblings retain their own unread state. */
export function projectFocusedResources(
  resources: readonly SourceResource[],
  focus?: FocusedStatus,
): SourceResource[] {
  if (!focus) return resources as SourceResource[]
  return resources.map((source) =>
    source.id !== focus.sourceId
      ? source
      : {
          ...source,
          spaces: source.spaces.map((space) => ({
            ...space,
            windows: space.windows.map((window) =>
              window.id !== focus.windowId || !window.panes?.length
                ? window
                : {
                    ...window,
                    panes: window.panes.map((pane) =>
                      pane.id === focus.paneId ? { ...pane, status: focus.status } : pane,
                    ),
                    status: aggregateStatus(
                      window.panes.map((pane) =>
                        pane.id === focus.paneId ? focus.status : pane.status,
                      ),
                    ),
                  },
            ),
          })),
        },
  )
}
