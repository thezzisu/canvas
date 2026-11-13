import type { ContentFontSettings } from '../../../../shared/settings'
import type { SourceResource } from '../../api/types'
import { t } from '../../plugins/i18n'
import type { FontPresentation } from '../../utils/settings/fonts'
import { preventFileNavigation } from '../../utils/terminal/uploads'
import { metadataAfterPoll, type LiveWindowMetadata } from '../../utils/workspace/live-resources'
import { clearDownloads } from '../files/downloads'
import { clearCaptures, removeCaptures } from './capture'
import { clearDirectories } from './directories'
import { disposeSession } from './terminal-create'
import { focusTerminal, ownsWheel } from './terminal-keys'
import { liveTerminalMetadata, metadataKey, metadataSources } from './terminal-metadata'
import { setTerminalFont } from './terminal-presentation'
import { clearReadFocus, finishTerminalReadGesture } from './terminal-read-focus'
import {
  interactive,
  sessionKey,
  sessions,
  setState,
  windowSessions,
  type Session,
} from './terminal-session'
import { disconnect, terminalVisibilityChanged, windowRemoved } from './terminal-stream'
import { clearUrls } from './urls'

// Every terminal of the signed-in workspace: what the rest of the app asks of them together.

export function hasLiveTerminal(sourceId: string, windowId: string): boolean {
  return [...windowSessions(sourceId, windowId)].some(
    (session) =>
      session.host?.isConnected &&
      session.state.status !== 'disconnected' &&
      session.state.status !== 'closed',
  )
}
/** The window already has a painted terminal that a new card only adopts. */
export function hasTerminalFrame(resource: Session['resource']): boolean {
  return !!sessions.get(sessionKey(resource))?.state.screenReady
}
/** What a terminal that has been shown remembers of a window the poll no longer lists. */
export function cachedTerminalView(sourceId: string, windowId: string) {
  const [session] = windowSessions(sourceId, windowId)
  return session ? { name: session.lastName } : undefined
}
/** The wheel over a focused terminal scrolls it, rather than the canvas around it. */
export function terminalConsumesWheel(event: WheelEvent): boolean {
  const target = event.target
  return (
    target instanceof Node &&
    [...sessions.values()].some(
      (session) => session.surface.contains(target) && ownsWheel(session, event),
    )
  )
}
export function focusWindow(
  sourceId: string,
  spaceId: string,
  windowId: string,
  keyboard = false,
): boolean {
  const session = sessions.get(sessionKey({ sourceId, spaceId, windowId }))
  if (!session?.host?.isConnected || !interactive(session)) return false
  focusTerminal(session, keyboard)
  return session.surface.contains(document.activeElement)
}
/** The authenticated app loads bundled fonts before applying this presentation. */
export function setContentFont(settings: ContentFontSettings, presentation: FontPresentation) {
  setTerminalFont({ family: presentation.family, ligatures: settings.ligatures })
}

/** The workspace's sources changed: forget the removed ones, reconnect the changed ones. */
export function retainTerminalMetadata(
  sourceIds: readonly string[],
  changedSources: readonly string[] = [],
) {
  for (const sourceId of metadataSources)
    if (!sourceIds.includes(sourceId)) removeCaptures(sourceId)
  for (const sourceId of changedSources) removeCaptures(sourceId)
  metadataSources.clear()
  for (const sourceId of sourceIds) metadataSources.add(sourceId)
  const next = new Map(liveTerminalMetadata.value)
  for (const session of sessions.values()) {
    const { sourceId } = session.resource
    const changed = changedSources.includes(sourceId)
    if (metadataSources.has(sourceId) && !changed) continue
    if (changed) {
      session.selectionRevision = (session.selectionRevision || 0) + 1
      session.uploads.invalidate(t('terminal.upload.targetChanged'))
      session.reconnect.pause()
      disconnect(session)
      setState(session, {
        ...session.state,
        status: 'disconnected',
        error: undefined,
        retryAttempt: undefined,
      })
    }
    session.metadata = undefined
    session.lastName = undefined
    if (session.state.status === 'closed')
      setState(session, { ...session.state, status: 'disconnected' })
    next.delete(metadataKey(session.resource))
  }
  if (next.size !== liveTerminalMetadata.value.size) liveTerminalMetadata.value = next
}
/** A poll answered: live metadata it has caught up with is dropped, and vanished windows close. */
export function acknowledgeTerminalMetadata(
  started: ReadonlyMap<string, LiveWindowMetadata>,
  resources: readonly SourceResource[],
) {
  const current = liveTerminalMetadata.value
  const online = new Map(
    resources
      .filter((source) => source.status === 'online' && !source.error)
      .map((source) => [source.id, source]),
  )
  const next = metadataAfterPoll(current, started, [...online.keys()])
  if (next.size !== liveTerminalMetadata.value.size) liveTerminalMetadata.value = next
  for (const session of sessions.values()) {
    const source = online.get(session.resource.sourceId)
    if (!source) continue
    const key = metadataKey(session.resource)
    const present = source.spaces.some((space) =>
      space.windows.some((window) => window.id === session.resource.windowId),
    )
    if (present) {
      if (session.state.status === 'closed' && next.get(key) !== null)
        session.reconnect.resume(true)
    } else if (current.get(key) === started.get(key)) windowRemoved(session)
  }
}

const visibilityChanged = () => {
  for (const session of sessions.values()) terminalVisibilityChanged(session)
}
let eventsInstalled = false
/** Page-wide listeners that every terminal shares, from the first mount until sign-out. */
export function installTerminalEvents() {
  if (eventsInstalled) return
  document.addEventListener('dragover', preventFileNavigation)
  document.addEventListener('drop', preventFileNavigation)
  document.addEventListener('visibilitychange', visibilityChanged)
  window.addEventListener('mouseup', finishTerminalReadGesture)
  window.addEventListener('focus', finishTerminalReadGesture)
  eventsInstalled = true
}
/** Sign-out: every session ends and nothing of the workspace's terminals remains. */
export function clearTerminals() {
  clearReadFocus()
  liveTerminalMetadata.value = new Map()
  metadataSources.clear()
  clearDownloads()
  clearDirectories()
  clearUrls()
  clearCaptures()
  for (const session of sessions.values()) {
    disconnect(session)
    disposeSession(session)
  }
  sessions.clear()
  document.removeEventListener('dragover', preventFileNavigation)
  document.removeEventListener('drop', preventFileNavigation)
  document.removeEventListener('visibilitychange', visibilityChanged)
  window.removeEventListener('mouseup', finishTerminalReadGesture)
  window.removeEventListener('focus', finishTerminalReadGesture)
  eventsInstalled = false
}
