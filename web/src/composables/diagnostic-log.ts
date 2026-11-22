import { useLocalStorage } from '@vueuse/core'
import { computed, shallowRef, watch } from 'vue'
import { frontendBuild } from '../utils/build-info'
import {
  logIdentifier,
  logLine,
  logTime,
  logType,
  type LogEvent,
  type LogFields,
} from '../../../shared/log-line'
import { batchesToDrop, logFileName, serverBuild, setLogSink } from '../utils/diagnostics/log'
import { developerMode, viewportPolicy } from './developer-mode'

// The diagnostic log of this browser: what the page did and when, kept in IndexedDB so that it
// outlives the page, and handed to nobody until it is downloaded. Lines are written in batches;
// `text` holds each batch, `sizes` its bytes and time span, `total` the bytes of them all.

const chosen = useLocalStorage('canvas:developer:diagnostic-log', false)
export const diagnosticLog = computed({
  get: () => developerMode.value && chosen.value,
  set: (value) => (chosen.value = value),
})
/** The stored log's size and the times of its first and last line. */
export const diagnosticLogStatus = shallowRef<{ bytes: number; from?: number; to?: number }>()

type Size = [bytes: number, from: number, to: number]
const session = Math.random().toString(36).slice(2, 8)
let database: Promise<IDBDatabase> | undefined
function open() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('canvas-diagnostic-log', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('text', { autoIncrement: true })
      request.result.createObjectStore('sizes')
      request.result.createObjectStore('total')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))
}
const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
const settled = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })

let pending: { line: string; epoch: number }[] = []
let timer: ReturnType<typeof setTimeout> | undefined
function record(event: LogEvent, fields?: LogFields) {
  const epoch = Date.now()
  pending.push({
    line: logLine({ epoch, monotonic: performance.now(), session }, event, fields),
    epoch,
  })
  timer ??= setTimeout(() => void flush(), 1000)
}
/** Stores the lines not yet stored, and drops the oldest batches if the log is full. */
async function flush() {
  clearTimeout(timer)
  timer = undefined
  if (!pending.length) return
  const lines = pending
  pending = []
  // A line is ASCII: its length is its bytes.
  const text = lines.map((entry) => entry.line + '\n').join('')
  const transaction = (await open()).transaction(['text', 'sizes', 'total'], 'readwrite')
  const [texts, sizes, total] = ['text', 'sizes', 'total'].map((name) =>
    transaction.objectStore(name),
  ) as [IDBObjectStore, IDBObjectStore, IDBObjectStore]
  const done = settled(transaction)
  let bytes = ((await result(total.get(0))) as number | undefined) ?? 0
  if (batchesToDrop([bytes], text.length)) {
    const [keys, stored] = await Promise.all([
      result(sizes.getAllKeys()),
      result(sizes.getAll() as IDBRequest<Size[]>),
    ])
    const drop = batchesToDrop(
      stored.map((size) => size[0]),
      text.length,
    )
    for (let index = 0; index < drop; index++) {
      texts.delete(keys[index]!)
      sizes.delete(keys[index]!)
      bytes -= stored[index]![0]
    }
  }
  const key = await result(texts.add(text))
  sizes.put([text.length, lines[0]!.epoch, lines.at(-1)!.epoch] satisfies Size, key)
  total.put(bytes + text.length, 0)
  await done
  void refreshDiagnosticLogStatus()
}

export async function refreshDiagnosticLogStatus() {
  const transaction = (await open()).transaction(['sizes', 'total'])
  const sizes = transaction.objectStore('sizes')
  const [bytes, first, last] = await Promise.all([
    result(transaction.objectStore('total').get(0) as IDBRequest<number | undefined>),
    result(sizes.openCursor()),
    result(sizes.openCursor(null, 'prev')),
  ])
  diagnosticLogStatus.value = {
    bytes: bytes ?? 0,
    from: (first?.value as Size | undefined)?.[1],
    to: (last?.value as Size | undefined)?.[2],
  }
}
export async function clearDiagnosticLog() {
  pending = []
  const transaction = (await open()).transaction(['text', 'sizes', 'total'], 'readwrite')
  for (const name of ['text', 'sizes', 'total']) transaction.objectStore(name).clear()
  await settled(transaction)
  await refreshDiagnosticLogStatus()
}
/** The whole log as a file: a line about this browser and build, then every line stored. */
export async function downloadDiagnosticLog() {
  await flush()
  const now = Date.now()
  const header = JSON.stringify({
    t: logTime(now),
    e: 'header',
    ...frontendBuild,
    server: serverBuild,
    userAgent: navigator.userAgent,
    viewport: `${innerWidth}x${innerHeight}`,
    devicePixelRatio,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...viewportPolicy.value,
  })
  const batches = await result(
    (await open()).transaction('text').objectStore('text').getAll() as IDBRequest<string[]>,
  )
  const link = document.createElement('a')
  link.href = URL.createObjectURL(
    new Blob([header + '\n', ...batches], { type: 'application/x-ndjson' }),
  )
  link.download = logFileName(now)
  link.click()
  URL.revokeObjectURL(link.href)
}

/** What Chrome says of the link; other browsers have none of it. */
interface NetworkState extends EventTarget {
  type?: string
  effectiveType?: string
  rtt?: number
  downlink?: number
}
/** What the page itself does, logged only while the log is on. */
function watchPage() {
  const stop = new AbortController(),
    listen = (target: EventTarget, type: string, listener: () => void) =>
      target.addEventListener(type, listener, { signal: stop.signal })
  let frame = 0,
    last = 0
  const tick = (now: number) => {
    if (last && document.visibilityState === 'visible' && now - last >= 250)
      record('frame-gap', { ms: now - last })
    last = now
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  listen(document, 'visibilitychange', () => {
    record('page', { state: document.visibilityState })
    // A frame after an absence follows no frame that was due.
    last = 0
    if (document.visibilityState === 'hidden') void flush()
  })
  for (const state of ['online', 'offline', 'pageshow', 'pagehide'] as const)
    listen(window, state, () => {
      record('page', { state })
      if (state === 'pagehide') void flush()
    })
  for (const state of ['freeze', 'resume'] as const)
    listen(document, state, () => record('page', { state }))
  const viewport = () =>
    record('viewport', {
      width: visualViewport!.width,
      height: visualViewport!.height,
      scale: visualViewport!.scale,
      inner: innerHeight,
    })
  if (visualViewport) listen(visualViewport, 'resize', viewport)
  if (navigator.serviceWorker)
    listen(navigator.serviceWorker, 'controllerchange', () =>
      record('page', { state: 'controller' }),
    )
  const tasks = PerformanceObserver.supportedEntryTypes.includes('longtask')
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (entry.duration >= 100) record('long-task', { ms: entry.duration })
      })
    : undefined
  tasks?.observe({ type: 'longtask' })
  const connection = (navigator as Navigator & { connection?: NetworkState }).connection
  const network = () =>
    record('network', {
      online: navigator.onLine,
      type: logType(connection?.type),
      effective: connection?.effectiveType ? logIdentifier(connection.effectiveType) : undefined,
      rtt: connection?.rtt,
      downlink: connection?.downlink,
    })
  if (connection) listen(connection, 'change', network)
  network()
  record('session', { width: innerWidth, height: innerHeight, dpr: devicePixelRatio })
  return () => {
    stop.abort()
    cancelAnimationFrame(frame)
    tasks?.disconnect()
  }
}

let unwatch: (() => void) | undefined
watch(
  diagnosticLog,
  (on) => {
    if (on) {
      setLogSink(record)
      unwatch = watchPage()
    } else {
      setLogSink(undefined)
      unwatch?.()
      unwatch = undefined
      void flush()
    }
  },
  { immediate: true },
)
