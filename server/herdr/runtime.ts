// The herdr runtime: its sockets, resources, operations and windows.
import { ensureSocketTunnel } from '../ssh-tunnels.ts'
import type { Source } from '../state.ts'
import { createHerdrClient } from '../herdr/client.ts'
import {
  PaneTitles,
  paneTitle,
  subscribePaneUpdates,
  type PaneRecord,
} from '../herdr/pane-titles.ts'
import {
  discoverHerdrPython,
  herdrApiRequest,
  localHerdrSockets,
  parseHerdrSockets,
  validateHerdrLocation,
  type HerdrSockets,
} from '../herdr/api.ts'
import { aggregateStatus, herdrStatus } from '../../shared/status.ts'
import {
  commandEnvironment,
  execute,
  sourcePythonCommand,
  validateSource,
} from '../source-command.ts'
import {
  closeTerminals,
  holding,
  onRelease,
  trackTerminal,
  tunnelRequest,
} from '../source-connections.ts'
import type { PaneResource, Runtime, SourceResource } from '../runtimes.ts'

async function discoverHerdrSockets(source: Source, signal?: AbortSignal): Promise<HerdrSockets> {
  signal?.throwIfAborted()
  validateHerdrLocation(source)
  if (source.transport === 'local') return localHerdrSockets(source)
  const location = { herdrSocket: source.herdrSocket, herdrSession: source.herdrSession }
  return parseHerdrSockets(
    await execute(
      sourcePythonCommand(source, discoverHerdrPython, [JSON.stringify(location)]),
      commandEnvironment(),
      signal,
    ),
  )
}

async function connectedHerdrSockets(source: Source, signal?: AbortSignal): Promise<HerdrSockets> {
  const paths = await discoverHerdrSockets(source, signal)
  signal?.throwIfAborted()
  if (source.transport === 'local') return paths
  const tunnel = await ensureSocketTunnel({
    ...tunnelRequest(source, { 'herdr.sock': paths.api, 'herdr-client.sock': paths.client }),
    signal,
  })
  return { api: tunnel.sockets['herdr.sock']!, client: tunnel.sockets['herdr-client.sock']! }
}

/** Pane titles of each herdr source that has an open window, followed through its API. */
const followedTitles = new Map<string, { titles: PaneTitles; stop(): void }>()
onRelease((sourceId) => {
  for (const [id, followed] of followedTitles)
    if (sourceId === undefined || id === sourceId) {
      followed.stop()
      followedTitles.delete(id)
    }
})

/**
 * Subscribes to the source's `pane.updated` events, then reads `session.snapshot`, so no change
 * falls between the two. A subscription that ends forgets the titles and starts again.
 */
function followPaneTitles(source: Source): PaneTitles {
  const followed = followedTitles.get(source.id)
  if (followed) return followed.titles
  const titles = new PaneTitles()
  let subscription: { close(): void } | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    delay = 1000,
    stopped = false
  const restart = () => {
    if (stopped) return
    titles.clear()
    retry = setTimeout(() => void start(), delay)
    retry.unref()
    delay = Math.min(delay * 2, 30_000)
  }
  const start = async () => {
    let api: string
    try {
      api = (await connectedHerdrSockets(source)).api
    } catch {
      restart()
      return
    }
    if (stopped) return
    subscription = subscribePaneUpdates(api, {
      started: () =>
        void herdrApiRequest(api, 'session.snapshot')
          .then((result) => {
            if (stopped) return
            titles.replace(snapshotPanes(result))
            delay = 1000
          })
          .catch(() => subscription?.close()),
      pane: (record) => titles.update(record),
      ended: restart,
    })
  }
  followedTitles.set(source.id, {
    titles,
    stop: () => {
      stopped = true
      clearTimeout(retry)
      subscription?.close()
      titles.clear()
    },
  })
  void start()
  return titles
}

function snapshotPanes(result: Record<string, unknown>): PaneRecord[] {
  const panes = (result.snapshot as { panes?: unknown } | undefined)?.panes
  return Array.isArray(panes) ? panes.filter((pane) => pane && typeof pane === 'object') : []
}

async function requestHerdr(
  source: Source,
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  validateSource(source)
  return holding(source, async () =>
    herdrApiRequest((await connectedHerdrSockets(source, signal)).api, method, params, { signal }),
  )
}

function name(value: string): string {
  if (!value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/u.test(value))
    throw new Error('Name must contain 1–100 characters without control characters')
  return value.trim()
}

async function resources(
  source: Source,
  signal?: AbortSignal,
): Promise<Pick<SourceResource, 'spaces' | 'serverVersion'>> {
  const response = await requestHerdr(source, 'session.snapshot', {}, signal)
  const snapshot = response.snapshot as {
    version?: unknown
    agents?: Array<{
      pane_id: string
      state_change_seq?: number
      completion_seq?: number
      agent_status?: string
    }>
    workspaces: Array<{ workspace_id: string; label: string }>
    tabs: Array<{ workspace_id: string; tab_id: string; label: string; agent_status?: string }>
    layouts?: Array<{ tab_id: string; focused_pane_id: string }>
    panes?: Array<{
      tab_id: string
      pane_id: string
      label?: string
      display_agent?: string
      agent?: string
      focused?: boolean
      agent_status?: string
      terminal_title_stripped?: string
    }>
  }
  if (!snapshot || !Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.tabs))
    throw new Error('Unexpected herdr snapshot response')
  // A followed source's titles may be newer than this snapshot: per pane, the newer wins.
  const titles = followedTitles.get(source.id)?.titles
  titles?.replace(snapshotPanes(response))
  // PaneInfo.focused is global; layouts retain each tab's selected pane.
  const focusedPanes = new Map(
    (Array.isArray(snapshot.layouts) ? snapshot.layouts : []).map((layout) => [
      layout.tab_id,
      layout.focused_pane_id,
    ]),
  )
  const spaces = snapshot.workspaces.map((workspace: { workspace_id: string; label: string }) => ({
    id: workspace.workspace_id,
    name: workspace.label || workspace.workspace_id,
    windows: snapshot.tabs
      .filter((tab: { workspace_id: string }) => tab.workspace_id === workspace.workspace_id)
      .map((tab: { tab_id: string; label: string; agent_status?: string }) => {
        const panes: PaneResource[] = (Array.isArray(snapshot.panes) ? snapshot.panes : [])
          .filter((pane: { tab_id: string }) => pane.tab_id === tab.tab_id)
          .map(
            (
              pane: {
                pane_id: string
                label?: string
                display_agent?: string
                agent?: string
                focused?: boolean
                agent_status?: string
                terminal_title_stripped?: string
              },
              index: number,
            ) => ({
              id: pane.pane_id,
              name: pane.label || pane.display_agent || pane.agent || String(index + 1),
              active: focusedPanes.get(tab.tab_id) === pane.pane_id,
              terminalTitle: titles?.title(pane.pane_id) ?? paneTitle(pane.terminal_title_stripped),
              ...(pane.display_agent || pane.agent
                ? { agent: pane.display_agent || pane.agent }
                : {}),
              status: herdrStatus(pane.agent_status),
              ...(() => {
                const seq = snapshot.agents?.find(
                  (agent) => agent.pane_id === pane.pane_id,
                )?.state_change_seq
                return Number.isSafeInteger(seq) && seq! >= 0 ? { stateSequence: seq } : {}
              })(),
            }),
          )
        return {
          id: tab.tab_id,
          name: tab.label || tab.tab_id,
          status: panes.length
            ? aggregateStatus(panes.map((pane) => pane.status))
            : herdrStatus(tab.agent_status),
          panes,
        }
      }),
  }))
  // This is the connected server's build identity, already included in its resource snapshot.
  const version = typeof snapshot.version === 'string' ? snapshot.version.trim() : ''
  const serverVersion =
    version && version.length <= 128 && !/[\x00-\x1f\x7f-\x9f]/u.test(version) ? version : undefined
  return { spaces, ...(serverVersion ? { serverVersion } : {}) }
}

/** A draft probe owns its temporary forward and never joins an existing connection. */

function createdWindow(response: Record<string, unknown>): { spaceId: string; windowId: string } {
  const tab = response.tab as { workspace_id?: unknown; tab_id?: unknown } | undefined
  if (
    typeof tab?.workspace_id !== 'string' ||
    !tab.workspace_id ||
    typeof tab.tab_id !== 'string' ||
    !tab.tab_id
  )
    throw new Error('Unexpected herdr creation response')
  return { spaceId: tab.workspace_id, windowId: tab.tab_id }
}

async function requireSpace(source: Source, spaceId: string, windowId?: string) {
  const { spaces } = await resources(source)
  const space = spaces.find((space) => space.id === spaceId)
  if (!space) throw new Error('Space no longer exists; refresh the overview')
  if (windowId && !space.windows.some((window) => window.id === windowId))
    throw new Error('Window no longer belongs to this space; refresh the overview')
  return space
}

/** herdr, through its API socket and its native client endpoint. */
export const herdrRuntime: Runtime = {
  async version(source, signal) {
    const { serverVersion } = await resources(source, signal)
    if (!serverVersion) throw new Error('Herdr did not report a server version')
    return serverVersion
  },
  resources: (source) => resources(source),
  nativeSocket: async (source) => (await discoverHerdrSockets(source)).api,
  async createSpace(source, label, sourceSpaceId) {
    if (sourceSpaceId) await requireSpace(source, sourceSpaceId)
    return createdWindow(
      await requestHerdr(source, 'workspace.create', {
        ...(label?.trim() ? { label: name(label) } : {}),
        ...(sourceSpaceId ? { source_workspace_id: sourceSpaceId } : {}),
        focus: false,
      }),
    )
  },
  async renameSpace(source, spaceId, label) {
    label = name(label)
    await requireSpace(source, spaceId)
    await requestHerdr(source, 'workspace.rename', { workspace_id: spaceId, label })
  },
  async closeSpace(source, spaceId) {
    const space = await requireSpace(source, spaceId)
    await closeTerminals(
      (terminal) => terminal.sourceId === source.id && terminal.spaceId === spaceId,
    )
    await requestHerdr(source, 'workspace.close', { workspace_id: spaceId })
    // Membership can change while the close is in flight. Never remove a tab
    // that survived in another space, or infer removal from a failed discovery.
    let after
    try {
      after = await resources(source)
    } catch {
      return []
    }
    const remaining = new Set(
      after.spaces.flatMap((space) => space.windows.map((window) => window.id)),
    )
    return space.windows.map((window) => window.id).filter((id) => !remaining.has(id))
  },
  async createWindow(source, spaceId, label) {
    await requireSpace(source, spaceId)
    return createdWindow(
      await requestHerdr(source, 'tab.create', {
        workspace_id: spaceId,
        ...(label?.trim() ? { label: name(label) } : {}),
        focus: false,
      }),
    )
  },
  async renameWindow(source, spaceId, windowId, label) {
    label = name(label)
    await requireSpace(source, spaceId, windowId)
    await requestHerdr(source, 'tab.rename', { tab_id: windowId, label })
  },
  async closeWindow(source, spaceId, windowId) {
    await requireSpace(source, spaceId, windowId)
    await closeTerminals(
      (terminal) => terminal.sourceId === source.id && terminal.windowId === windowId,
    )
    await requestHerdr(source, 'tab.close', { tab_id: windowId })
  },
  async openTerminal(source, spaceId, windowId) {
    const sockets = await connectedHerdrSockets(source)
    const { cleanup } = trackTerminal(source, spaceId, windowId)
    return {
      connect: (cols, rows) =>
        createHerdrClient({
          socketPath: sockets.client,
          tabId: windowId,
          cols,
          rows,
          readSelection: (params) => herdrApiRequest(sockets.api, 'pane.selection.read', params),
          readContent: async (params) =>
            (await herdrApiRequest(sockets.api, 'pane.read', params, { timeoutMs: 5000 })).read,
          titles: followPaneTitles(source),
        }),
      cleanup,
    }
  },
}
