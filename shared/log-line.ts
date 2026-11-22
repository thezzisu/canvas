/**
 * The diagnostic log's line, written alike by the browser and the server. A line says when
 * something happened and names it; it never carries what was typed or shown. That is a rule of
 * the types here: a field is a number, a boolean, an identifier, or one of the words in `LogWord`.
 */

/** What can happen. */
export type LogEvent =
  | 'session'
  | 'socket'
  | 'probe'
  | 'channel'
  | 'state'
  | 'cells'
  | 'cells-error'
  | 'painted'
  | 'input'
  | 'hold'
  | 'view'
  | 'cover'
  | 'loading'
  | 'place'
  | 'ask'
  | 'page'
  | 'viewport'
  | 'long-task'
  | 'frame-gap'
  | 'event-loop'
  | 'tunnel'
  | 'watch'
  | 'network'
  | 'send'
  | 'receive'
  | 'message'
  | 'ack'
  | 'stall'
  | 'resumed'
  | 'screen-held'

/** Every word a field may hold. */
export type LogWord =
  // socket and channel
  | 'opening'
  | 'open'
  | 'close'
  | 'error'
  | 'ok'
  | 'expired'
  | 'failed'
  | 'stalled'
  // a link in doubt, and why
  | 'doubt'
  | 'clear'
  | 'silent'
  | 'held'
  | 'network'
  // who ended a channel
  | 'browser'
  | 'server'
  | 'superseded'
  | 'socket'
  // a window's status
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closed'
  // a source's watch
  | 'read'
  // cell messages
  | 'frame'
  | 'patch'
  // input
  | 'key'
  | 'paste'
  | 'mouse'
  | 'wheel'
  | 'focus'
  // the page
  | 'visible'
  | 'hidden'
  | 'online'
  | 'offline'
  | 'pageshow'
  | 'pagehide'
  | 'freeze'
  | 'resume'
  | 'controller'

/** An identifier: of a window, a socket, a view or an address, which both logs name alike. */
export type LogId = string & { [logId]: true }
declare const logId: unique symbol
export const logIdentifier = (value: string) => value as LogId
/** `w` names the window: its source and its own identifier, which the server's log names too. */
export const logWindow = (resource: { sourceId: string; windowId: string }) =>
  `${resource.sourceId}/${resource.windowId}` as LogId
export type LogFields = Record<string, number | boolean | LogWord | LogId | undefined>
/** A protocol message's type is a word of ours; anything else is not named. */
export const logType = (value: unknown) =>
  typeof value === 'string' && /^[a-z][a-z-]{0,31}$/u.test(value) ? logIdentifier(value) : undefined
/** An identifier is letters, digits and a few marks; anything else is not written. */
const identifier = /^[\w.:/-]{1,96}$/u

const two = (value: number) => String(value).padStart(2, '0')
/** Local time to the millisecond with its offset, as a journal prints it. */
export function logTime(epoch: number, offsetMinutes = -new Date(epoch).getTimezoneOffset()) {
  const local = new Date(epoch + offsetMinutes * 60_000).toISOString().slice(0, -1),
    ahead = Math.abs(offsetMinutes)
  return `${local}${offsetMinutes < 0 ? '-' : '+'}${two(Math.floor(ahead / 60))}:${two(ahead % 60)}`
}

/**
 * One line: `t` the wall clock, `m` milliseconds since the page or the server started, which
 * order the lines of one run exactly, `s` that run, `e` the event.
 */
export function logLine(
  clock: { epoch: number; monotonic: number; session: string; offsetMinutes?: number },
  event: LogEvent,
  fields: LogFields = {},
): string {
  const line: Record<string, unknown> = {
    t: logTime(clock.epoch, clock.offsetMinutes),
    m: Math.round(clock.monotonic * 10) / 10,
    s: clock.session,
    e: event,
  }
  for (const [name, value] of Object.entries(fields))
    if (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean')
      line[name] = typeof value === 'number' ? Math.round(value * 100) / 100 : value
    else if (typeof value === 'string' && identifier.test(value)) line[name] = value
  return JSON.stringify(line)
}

/** What the bytes of an input are, by their first marks; never the bytes themselves. */
export function inputKind(
  data: string,
): Extract<LogWord, 'key' | 'paste' | 'mouse' | 'wheel' | 'focus'> {
  if (data === '\x1b[I' || data === '\x1b[O') return 'focus'
  if (data.startsWith('\x1b[200~')) return 'paste'
  const mouse = /^\x1b\[<(\d+);/u.exec(data)
  return mouse ? (Number(mouse[1]) & 64 ? 'wheel' : 'mouse') : 'key'
}
