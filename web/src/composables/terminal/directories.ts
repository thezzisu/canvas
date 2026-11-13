import type { TerminalConnection } from '../../utils/terminal/terminal-channels'
import { computed, shallowRef } from 'vue'
import { vscodeDirectoryUri } from '../../utils/terminal/editor-links'

interface DirectoryRequest {
  id: string
  path: string
  uri: string
}
const requests = shallowRef<DirectoryRequest[]>([])
let received = new WeakMap<TerminalConnection, Set<string>>()
export const directoryRequest = computed(() => requests.value[0])
export function dismissDirectory() {
  requests.value = requests.value.slice(1)
}

export function receiveDirectory(
  connection: TerminalConnection,
  message: Record<string, unknown>,
): boolean {
  if (message.type !== 'open-directory') return false
  if (
    typeof message.id !== 'string' ||
    !message.id ||
    message.id.length > 256 ||
    typeof message.path !== 'string'
  )
    return true
  let uri: string
  try {
    uri = vscodeDirectoryUri(message.authority, message.path)
  } catch {
    return true
  }
  const ids = received.get(connection) || new Set<string>()
  if (!ids.has(message.id)) {
    requests.value = [...requests.value, { id: message.id, path: message.path, uri }]
    ids.add(message.id)
    if (ids.size > 256) ids.delete(ids.values().next().value!)
    received.set(connection, ids)
  }
  // Receipt, not editor launch, releases the terminal helper.
  connection.send({ type: 'directory-received', id: message.id })
  return true
}

export function clearDirectories() {
  requests.value = []
  received = new WeakMap()
}
