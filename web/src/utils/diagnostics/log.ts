/**
 * The diagnostic log's lines and its size arithmetic. A line says when something happened and
 * names it; it never carries what was typed or shown. That is a rule of the types here: a
 * field is a number, a boolean, an identifier of a window, or one of the words in `LogWord`.
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
  // a window's status
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'closed'
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

/** `w` names the window: its source and its own identifier, which the server's log names too. */
export type LogFields = Record<string, number | boolean | LogWord | WindowId | undefined>
declare const windowId: unique symbol
export type WindowId = string & { [windowId]: true }
/** An identifier is letters, digits and a few marks; anything else is not written. */
export const logWindow = (resource: { sourceId: string; windowId: string }) =>
  `${resource.sourceId}/${resource.windowId}` as WindowId
const identifier = /^[\w.:/-]{1,96}$/u

const two = (value: number) => String(value).padStart(2, '0')
/** Local time to the millisecond with its offset, as a journal prints it. */
export function logTime(epoch: number, offsetMinutes = -new Date(epoch).getTimezoneOffset()) {
  const local = new Date(epoch + offsetMinutes * 60_000).toISOString().slice(0, -1),
    ahead = Math.abs(offsetMinutes)
  return `${local}${offsetMinutes < 0 ? '-' : '+'}${two(Math.floor(ahead / 60))}:${two(ahead % 60)}`
}

/**
 * One line: `t` the wall clock, `m` milliseconds since the page loaded, which order the lines
 * of a session exactly, `s` the session, `e` the event.
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

/** The log keeps at most this much, and drops its oldest batches for the newest. */
export const LOG_CAP = 50 * 1024 * 1024
/**
 * How many of the oldest batches leave so that `incoming` bytes fit under the cap. They leave
 * a megabyte at a time, so the store is not trimmed on every write once it is full.
 */
export function batchesToDrop(sizes: readonly number[], incoming: number, cap = LOG_CAP): number {
  let total = sizes.reduce((sum, size) => sum + size, 0) + incoming
  if (total <= cap) return 0
  const target = cap - Math.min(1024 * 1024, cap / 2)
  let drop = 0
  while (drop < sizes.length && total > target) total -= sizes[drop++]!
  return drop
}

export const logFileName = (epoch: number, offsetMinutes?: number) =>
  `canvas-log-${logTime(epoch, offsetMinutes).slice(0, 19).replace(/[-:]/gu, '').replace('T', '-')}.ndjson`

let sink: ((event: LogEvent, fields?: LogFields) => void) | undefined
/** Writes to the diagnostic log; while it is off, this is all that runs. */
export function log(event: LogEvent, fields?: LogFields) {
  sink?.(event, fields)
}
/** Whether the log is on, for a caller that would measure something only to log it. */
export const logging = () => !!sink
export function setLogSink(next: typeof sink) {
  sink = next
}
