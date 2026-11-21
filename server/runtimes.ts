// A source's runtime, whichever it is: its resources, spaces, windows and terminals.
import { randomUUID } from 'node:crypto'
import type { Source } from './state.ts'
import type { WindowTransport } from './transport.ts'
import type { CompletionToken } from '../shared/completion.ts'
import { type ProgramStatus } from '../shared/status.ts'
import { validateSource } from './source-command.ts'
import { closeRuntimeConnections, holding } from './source-connections.ts'
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
  spaces: SpaceResource[]
}
export interface TerminalHandle {
  connect(cols: number, rows: number): Promise<WindowTransport>
  cleanup(): Promise<void>
}

/** What Canvas does with a source's runtime. Core is the reference; herdr does what its API allows. */
export interface Runtime {
  /** The server's version, read through a connection of its own. */
  version(source: Source, signal?: AbortSignal): Promise<string>
  resources(source: Source): Promise<Pick<SourceResource, 'spaces' | 'serverVersion'>>
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
  source.runtime === 'core' ? coreRuntime : herdrRuntime

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
  const result: SourceResource = { id: source.id, name: source.name, status: 'online', spaces: [] }
  try {
    Object.assign(result, await runtimeOf(source).resources(source))
  } catch (error) {
    result.status = 'offline'
    result.error = error instanceof Error ? error.message : 'Connection failed'
  }
  return result
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
export const createSpace = (source: Source, label?: string, sourceSpaceId?: string) =>
  runtimeOf(source).createSpace(source, label, sourceSpaceId)
export const renameSpace = (source: Source, spaceId: string, label: string) =>
  runtimeOf(source).renameSpace(source, spaceId, label)
export const closeSpace = (source: Source, spaceId: string) =>
  runtimeOf(source).closeSpace(source, spaceId)
export const createWindow = (source: Source, spaceId: string, label?: string) =>
  runtimeOf(source).createWindow(source, spaceId, label)
export const renameWindow = (source: Source, spaceId: string, windowId: string, label: string) =>
  runtimeOf(source).renameWindow(source, spaceId, windowId, label)
export const closeWindow = (source: Source, spaceId: string, windowId: string) =>
  runtimeOf(source).closeWindow(source, spaceId, windowId)

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
