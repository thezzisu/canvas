/**
 * The browser's diagnostic log: where its lines go and how much of them it keeps. The line
 * itself, and what a line may carry, is `shared/log-line.ts`.
 */
import { logTime, type LogEvent, type LogFields } from '../../../../shared/log-line'

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

/** The server last spoken to, which a downloaded log names beside the frontend. */
export let serverBuild: { version?: string; revision?: string } | undefined
export function sawServer(build: typeof serverBuild) {
  serverBuild = build
}

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
