// A source's runtime, whichever it is: its resources, spaces, windows and terminals.
import { randomUUID } from 'node:crypto'
import type { Source } from './state.ts'
import type { WindowTransport } from './transport.ts'
import type { CompletionToken } from '../shared/completion.ts'
import { type ProgramStatus } from '../shared/status.ts'
import type { WindowProgress } from '../shared/window-metadata.ts'
import { validateSource } from './source-command.ts'
import { serverTime } from './server-time.ts'
import { closeRuntimeConnections, holding } from './source-connections.ts'
import {
  followSource,
  refreshSource,
  type FollowListener,
  type Following,
  type StartWatch,
} from './source-follow.ts'
import { coreRuntime } from './core/runtime.ts'
import { herdrRuntime } from './herdr/runtime.ts'

export interface PaneResource {
  terminalId?: string
  stateSequence?: number
  completion?: CompletionToken
  id: string
  name: string
  active: boolean
  agent?: string
  terminalTitle?: string
  status: ProgramStatus
}
export interface WindowResource {
  id: string
  name: string
  status: ProgramStatus
  panes: PaneResource[]
  /** A program's progress report (OSC 9;4), while the window is open in a browser. */
  progress?: WindowProgress
}
export interface SpaceResource {
  id: string
  name: string
  windows: WindowResource[]
}
export interface SourceResource {
  id: string
  name: string
  status: 'online' | 'offline'
  error?: string
  serverVersion?: string
  /** When the read of it began, on the server's clock. */
  readAt: number
  spaces: SpaceResource[]
}
/** What a runtime lists of a source. */
export type RuntimeListing = Pick<SourceResource, 'spaces' | 'serverVersion'>
export interface TerminalHandle {
  connect(cols: number, rows: number): Promise<WindowTransport>
  cleanup(): Promise<void>
}

/** What Canvas does with a source's runtime. Core is the reference; herdr does what its API allows. */
export interface Runtime {
  /** The server's version, read through a connection of its own. */
  version(source: Source, signal?: AbortSignal): Promise<string>
  resources(source: Source): Promise<RuntimeListing>
  /** Reports what `resources` would list, whenever it may have changed. */
  watch: StartWatch<RuntimeListing>
  /** The socket a canvas helper on the source talks to. */
  nativeSocket(source: Source): Promise<string>
  createSpace(
    source: Source,
    label?: string,
    sourceSpaceId?: string,
  ): Promise<{ spaceId: string; windowId: string }>
  renameSpace(source: Source, spaceId: string, label: string): Promise<void>
  /** The windows the close removed. */
  closeSpace(source: Source, spaceId: string): Promise<string[]>
  createWindow(
    source: Source,
    spaceId: string,
    label?: string,
  ): Promise<{ spaceId: string; windowId: string }>
  renameWindow(source: Source, spaceId: string, windowId: string, label: string): Promise<void>
  closeWindow(source: Source, spaceId: string, windowId: string): Promise<void>
  openTerminal(source: Source, spaceId: string, windowId: string): Promise<TerminalHandle>
}
const runtimeOf = (source: Source): Runtime =>
  source.runtime === 'hc' ? coreRuntime : herdrRuntime

/** A draft probe owns its temporary forward and never joins an existing connection. */
export async function probeSource(
  draft: Omit<Source, 'id' | 'name'>,
  signal?: AbortSignal,
): Promise<{ status: 'online'; serverVersion: string }> {
  const source: Source = { ...draft, id: randomUUID(), name: 'Connection probe' }
  try {
    return { status: 'online', serverVersion: await runtimeOf(source).version(source, signal) }
  } finally {
    await closeRuntimeConnections(source.id)
  }
}

export async function listResources(source: Source): Promise<SourceResource> {
  validateSource(source)
  const result: SourceResource = {
    id: source.id,
    name: source.name,
    status: 'online',
    readAt: serverTime(),
    spaces: [],
  }
  try {
    Object.assign(result, await runtimeOf(source).resources(source))
  } catch (error) {
    result.status = 'offline'
    result.error = error instanceof Error ? error.message : 'Connection failed'
  }
  return result
}

/**
 * The source's windows with the progress their open terminals report. The runtime's listing has
 * none, and a browser takes this listing over the progress it was last sent.
 */
export function withProgress(
  resource: SourceResource,
  progress: ReadonlyMap<string, WindowProgress>,
): SourceResource {
  if (!progress.size) return resource
  return {
    ...resource,
    spaces: resource.spaces.map((space) => ({
      ...space,
      windows: space.windows.map((window) => {
        const value = progress.get(window.id)
        return value ? { ...window, progress: value } : window
      }),
    })),
  }
}

async function requireResource(
  source: Source,
  spaceId: string,
  windowId?: string,
): Promise<SpaceResource> {
  const snapshot = await listResources(source)
  if (snapshot.status !== 'online') throw new Error(snapshot.error || 'Source is offline')
  const space = snapshot.spaces.find((s) => s.id === spaceId)
  if (!space) throw new Error('Space no longer exists; refresh the overview')
  if (windowId && !space.windows.some((w) => w.id === windowId))
    throw new Error('Window no longer belongs to this space; refresh the overview')
  return space
}

export async function nativeSocketForSource(source: Source): Promise<string> {
  validateSource(source)
  return runtimeOf(source).nativeSocket(source)
}
/** Follows what the source lists, until disposed. */
export const followResources = (
  source: Source,
  listener: FollowListener<RuntimeListing>,
): Following => followSource(source, runtimeOf(source).watch, listener)

/** A change Canvas makes is read again: not every runtime announces every one. */
async function changing<T>(source: Source, change: (runtime: Runtime) => Promise<T>): Promise<T> {
  try {
    return await change(runtimeOf(source))
  } finally {
    refreshSource(source)
  }
}
export const createSpace = (source: Source, label?: string, sourceSpaceId?: string) =>
  changing(source, (runtime) => runtime.createSpace(source, label, sourceSpaceId))
export const renameSpace = (source: Source, spaceId: string, label: string) =>
  changing(source, (runtime) => runtime.renameSpace(source, spaceId, label))
export const closeSpace = (source: Source, spaceId: string) =>
  changing(source, (runtime) => runtime.closeSpace(source, spaceId))
export const createWindow = (source: Source, spaceId: string, label?: string) =>
  changing(source, (runtime) => runtime.createWindow(source, spaceId, label))
export const renameWindow = (source: Source, spaceId: string, windowId: string, label: string) =>
  changing(source, (runtime) => runtime.renameWindow(source, spaceId, windowId, label))
export const closeWindow = (source: Source, spaceId: string, windowId: string) =>
  changing(source, (runtime) => runtime.closeWindow(source, spaceId, windowId))

export function openTerminal(
  source: Source,
  spaceId: string,
  windowId: string,
): Promise<TerminalHandle> {
  return holding(source, async () => {
    await requireResource(source, spaceId, windowId)
    return runtimeOf(source).openTerminal(source, spaceId, windowId)
  })
}
