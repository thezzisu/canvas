/** Non-secret connection fields needed by the user's external editor. */
export interface EditorAuthority { hostName: string; user?: string; port?: number }

/** Validate once at each trust boundary, and never forward arbitrary SSH fields. */
export function sanitizeEditorAuthority(value: unknown): EditorAuthority {
  if (!value || typeof value !== 'object') throw new Error('Invalid editor address')
  const input = value as Partial<EditorAuthority>
  if (typeof input.hostName !== 'string') throw new Error('Invalid editor host')
  const hostName = input.hostName.startsWith('[') && input.hostName.endsWith(']') ? input.hostName.slice(1, -1) : input.hostName
  if (!/^[a-z\d](?:[a-z\d._-]*[a-z\d])?$/iu.test(hostName)) {
    // URL implements the IPv6 parser in both browser and server runtimes.
    try {
      const address = new URL(`http://[${hostName}]/`)
      if (!address.hostname.startsWith('[') || address.username || address.password || address.port || address.pathname !== '/') throw new Error()
    } catch { throw new Error('Invalid editor host') }
  }
  const { user, port } = input
  if (user !== undefined && (typeof user !== 'string' || !/^[a-z_][a-z\d_.-]*\$?$/iu.test(user))) throw new Error('Invalid editor user')
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('Invalid editor port')
  return { hostName, ...(user === undefined ? {} : { user }), ...(port === undefined ? {} : { port }) }
}
