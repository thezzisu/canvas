// The server's diagnostic log, in the browser log's line format (shared/log-line.ts).
// - Detail is off unless `NODE_DEBUG` names its category: `canvas:link` for sockets, channels
//   and what travels on them, `canvas:source` for the connections kept to each source.
//   `NODE_DEBUG=canvas:*` names both. Lines go to stderr.
// - Problems are process warnings of type `CanvasWarning`, on unless Node is started with
//   `--disable-warning=CanvasWarning` (or `--no-warnings`).
import { randomBytes } from 'node:crypto'
import { debuglog } from 'node:util'
import { logLine, type LogEvent, type LogFields } from '../shared/log-line.ts'

export type LogCategory = 'link' | 'source'
export type WarningCode = 'CANVAS_EVENT_LOOP' | 'CANVAS_TUNNEL' | 'CANVAS_STALL'

const session = randomBytes(3).toString('hex')
const line = (event: LogEvent, fields?: LogFields) =>
  logLine({ epoch: Date.now(), monotonic: performance.now(), session }, event, fields)

const categories: Record<LogCategory, boolean> = {
  link: debuglog('canvas:link').enabled,
  source: debuglog('canvas:source').enabled,
}
export function log(category: LogCategory, event: LogEvent, fields?: LogFields) {
  if (categories[category]) process.stderr.write(line(event, fields) + '\n')
}
export function warn(code: WarningCode, event: LogEvent, fields?: LogFields) {
  process.emitWarning(line(event, fields), { type: 'CanvasWarning', code })
}

/** Names the categories that are on, once, so a misspelt one is seen to be missing. */
export function announceLogging() {
  const on = Object.entries(categories).filter(([, enabled]) => enabled)
  if (on.length)
    console.error(`Canvas diagnostics: ${on.map(([category]) => `canvas:${category}`).join(', ')}`)
}

/** Warns when the event loop was held for a quarter second or more. */
export function watchEventLoop(): Disposable {
  let tick = performance.now()
  const timer = setInterval(() => {
    const now = performance.now(),
      held = now - tick - 100
    tick = now
    if (held >= 250) warn('CANVAS_EVENT_LOOP', 'event-loop', { ms: held })
  }, 100)
  timer.unref()
  return { [Symbol.dispose]: () => clearInterval(timer) }
}
