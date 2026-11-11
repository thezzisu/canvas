import { shallowReactive } from 'vue'

/** What an owner shows; no status means everything it holds is stored. */
export type WriteStatus = 'saving' | 'saved' | 'failed'
type Flush = (keepalive: boolean) => void
interface Entry {
  work: ReadonlySet<string>
  retry?: () => void
  saved?: boolean
}
const SAVED_MS = 2000

/**
 * Unsaved changes per owner: a note, a composer, a canvas layout or a terminal transfer.
 * Writers report their own progress; the page asks whether closing could lose anything.
 */
export function createPendingWrites() {
  const entries = shallowReactive(new Map<string, Entry>())
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const flushes = new Set<Flush>()
  function update(key: string, next: (entry: Entry) => Entry) {
    clearTimeout(timers.get(key))
    timers.delete(key)
    const entry = next(entries.get(key) ?? { work: new Set() })
    if (!entry.work.size && !entry.retry && !entry.saved) {
      entries.delete(key)
      return
    }
    entries.set(key, entry)
    if (!entry.work.size && !entry.retry)
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          entries.delete(key)
        }, SAVED_MS),
      )
  }
  const without = (work: ReadonlySet<string>, item: string) =>
    new Set([...work].filter((value) => value !== item))
  return {
    status(key: string): WriteStatus | undefined {
      const entry = entries.get(key)
      return entry && (entry.work.size ? 'saving' : entry.retry ? 'failed' : 'saved')
    },
    /** Local changes or a transfer that the server does not have yet. */
    start(key: string, work = 'write') {
      update(key, ({ work: active, retry }) => ({ work: new Set(active).add(work), retry }))
    },
    /** The owner's latest change is stored. */
    saved(key: string, work = 'write') {
      update(key, ({ work: active }) => ({ work: without(active, work), saved: true }))
    },
    /** The change stays local until `retry` stores it. */
    failed(key: string, retry: () => void, work = 'write') {
      update(key, ({ work: active }) => ({ work: without(active, work), retry }))
    },
    /** Work ended without storing anything, such as a cancelled upload. */
    stop(key: string, work = 'write') {
      update(key, (entry) => ({ ...entry, work: without(entry.work, work) }))
    },
    retry(key: string) {
      entries.get(key)?.retry?.()
    },
    /** The owner's unsaved changes are gone; its running transfers still count. */
    discard(key: string) {
      update(key, ({ work: active }) => ({ work: without(active, 'write') }))
    },
    reset() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      entries.clear()
    },
    get pending() {
      return [...entries.values()].some((entry) => entry.work.size || entry.retry)
    },
    /** Writers send unsaved changes immediately; `keepalive` lets them outlive the page. */
    onFlush(flush: Flush) {
      flushes.add(flush)
      return () => {
        flushes.delete(flush)
      }
    },
    flush(keepalive = false) {
      for (const flush of flushes) flush(keepalive)
    },
  }
}
export type PendingWrites = ReturnType<typeof createPendingWrites>
export const pendingWrites = createPendingWrites()

/**
 * Ask before closing while anything is unsaved. Mobile browsers often discard a hidden
 * page without `beforeunload`, so hiding sends pending writes as keepalive requests.
 */
export function guardPageExit(
  writes: PendingWrites,
  unsaved: () => boolean,
  view: EventTarget = window,
  page: EventTarget & { readonly visibilityState: DocumentVisibilityState } = document,
) {
  const hidden = () => {
    if (page.visibilityState === 'hidden') writes.flush(true)
  }
  const leave = () => {
    writes.flush(true)
  }
  const prompt = (event: Event) => {
    if (!writes.pending && !unsaved()) return
    writes.flush(true)
    event.preventDefault()
    ;(event as BeforeUnloadEvent).returnValue = ''
  }
  page.addEventListener('visibilitychange', hidden)
  view.addEventListener('pagehide', leave)
  view.addEventListener('beforeunload', prompt)
  return () => {
    page.removeEventListener('visibilitychange', hidden)
    view.removeEventListener('pagehide', leave)
    view.removeEventListener('beforeunload', prompt)
  }
}

/**
 * A save in flight when its page is hidden may not outlive the page, so its owner sends a keepalive
 * copy of its latest value. This holds the value each owner last sent as a keepalive request while
 * its save runs, so a page hidden again sends only what no such request carries yet.
 */
export function createKeepaliveCopies() {
  const sent = new Map<string, string>()
  return {
    /** Whether `value` still needs a keepalive request; it then counts as sent. */
    claim(key: string, value: string) {
      if (sent.get(key) === value) return false
      sent.set(key, value)
      return true
    },
    /** The request carrying `value` failed, so the next hide sends it again. */
    release(key: string, value: string) {
      if (sent.get(key) === value) sent.delete(key)
    },
    /** The owner's save settled; without a key, every owner's did. */
    forget(key?: string) {
      if (key === undefined) sent.clear()
      else sent.delete(key)
    },
  }
}

/** Browsers reject keepalive bodies beyond 64 KiB in flight; larger writes still go out as ordinary requests. */
export function keepaliveFetch(send: typeof fetch, quota = 65536): typeof fetch {
  let inFlight = 0
  return async (input, init) => {
    const bytes =
      init?.keepalive && typeof init.body === 'string'
        ? new TextEncoder().encode(init.body).length
        : 0
    const keepalive = !!init?.keepalive && inFlight + bytes <= quota
    if (keepalive) inFlight += bytes
    try {
      return await send(input, { ...init, keepalive })
    } finally {
      if (keepalive) inFlight -= bytes
    }
  }
}
