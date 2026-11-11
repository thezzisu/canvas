/** Typing saves once it pauses for `idle`, and at least every `maxWait` while it continues. */
export const AUTOSAVE_IDLE_MS = 1000
export const AUTOSAVE_MAX_WAIT_MS = 5000

export function createAutosave(
  idle = AUTOSAVE_IDLE_MS,
  maxWait = AUTOSAVE_MAX_WAIT_MS,
  now = () => Date.now(),
) {
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>()
  return {
    /** Restart the idle wait for `key`, bounded by the first unsaved edit. */
    schedule(key: string, save: () => void) {
      const current = pending.get(key),
        since = current?.since ?? now()
      clearTimeout(current?.timer)
      const delay = Math.max(0, Math.min(idle, since + maxWait - now()))
      pending.set(key, {
        since,
        timer: setTimeout(() => {
          pending.delete(key)
          save()
        }, delay),
      })
    },
    has(key: string) {
      return pending.has(key)
    },
    cancel(key: string) {
      clearTimeout(pending.get(key)?.timer)
      pending.delete(key)
    },
    clear() {
      for (const { timer } of pending.values()) clearTimeout(timer)
      pending.clear()
    },
  }
}
