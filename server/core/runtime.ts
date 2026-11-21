// The herdr-core runtime: its socket, resources, operations and windows.
import { ensureSocketTunnel } from '../ssh-tunnels.ts'
import type { Source } from '../state.ts'
import { CoreRpc } from '../core/rpc.ts'
import { discoverCorePython, localCoreSocket, parseCoreSocket } from '../core/endpoint.ts'
import { CoreLayout } from '../core/layout.ts'
import { createCoreClient } from '../core/client.ts'
import {
  commandEnvironment,
  execute,
  sourcePythonCommand,
  validateSource,
} from '../source-command.ts'
import { holding, trackTerminal, tunnelRequest } from '../source-connections.ts'
import type { Runtime } from '../runtimes.ts'

async function discoverCoreSocket(source: Source, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  if (source.transport === 'local') return localCoreSocket(source, signal)
  const location = { herdrSocket: source.herdrSocket, herdrSession: source.herdrSession }
  return parseCoreSocket(
    await execute(
      sourcePythonCommand(source, discoverCorePython, [JSON.stringify(location)]),
      commandEnvironment(),
      signal,
    ),
  )
}

async function connectedCoreSocket(source: Source, signal?: AbortSignal): Promise<string> {
  const socket = await discoverCoreSocket(source, signal)
  signal?.throwIfAborted()
  if (source.transport === 'local') return socket
  const tunnel = await ensureSocketTunnel({
    ...tunnelRequest(source, { 'core.sock': socket }),
    signal,
  })
  return tunnel.sockets['core.sock']!
}

async function withCore<T>(
  source: Source,
  operation: (layout: CoreLayout, rpc: CoreRpc) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  validateSource(source)
  return holding(source, async () => {
    const rpc = await CoreRpc.connect(await connectedCoreSocket(source, signal), { signal })
    try {
      return await operation(new CoreLayout(rpc), rpc)
    } finally {
      rpc.close()
    }
  })
}

/** herdr-core, through one RPC connection per operation and per open window. */
export const coreRuntime: Runtime = {
  version: (source, signal) => withCore(source, async (_layout, rpc) => rpc.hello.version, signal),
  resources: (source) =>
    withCore(source, async (layout, rpc) => ({
      spaces: layout.resources(await layout.snapshot()),
      serverVersion: rpc.hello.version,
    })),
  nativeSocket: (source) => discoverCoreSocket(source),
  createSpace: (source, label, sourceSpaceId) =>
    withCore(source, (layout) => layout.createSpace(label, sourceSpaceId)),
  renameSpace: (source, spaceId, label) =>
    withCore(source, (layout) => layout.renameSpace(spaceId, label)),
  closeSpace: (source, spaceId) => withCore(source, (layout) => layout.closeSpace(spaceId)),
  createWindow: (source, spaceId, label) =>
    withCore(source, (layout) => layout.createWindow(spaceId, label)),
  renameWindow: (source, spaceId, windowId, label) =>
    withCore(source, (layout) => layout.renameWindow(spaceId, windowId, label)),
  closeWindow: (source, spaceId, windowId) =>
    withCore(source, (layout) => layout.closeWindow(spaceId, windowId)),
  async openTerminal(source, spaceId, windowId) {
    const socket = await connectedCoreSocket(source)
    const controller = new AbortController()
    let rpc: CoreRpc | undefined,
      connecting = false
    const { cleanup } = trackTerminal(source, spaceId, windowId, () => {
      controller.abort()
      rpc?.close()
    })
    return {
      cleanup,
      connect: async (cols, rows) => {
        if (controller.signal.aborted || connecting || rpc)
          throw new Error('Core terminal handle is no longer available')
        connecting = true
        rpc = await CoreRpc.connect(socket, { signal: controller.signal })
        if (controller.signal.aborted) {
          rpc.close()
          throw new Error('Core terminal handle was closed')
        }
        return createCoreClient({
          rpc,
          layout: new CoreLayout(rpc),
          spaceId,
          tabId: windowId,
          cols,
          rows,
        })
      },
    }
  },
}
