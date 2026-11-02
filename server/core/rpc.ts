import { createConnection, type Socket } from 'node:net'

const HEADER = 9
export const CORE_MAX_PAYLOAD = 16 * 1024 * 1024
const MAX_QUEUE = 20 * 1024 * 1024
const MAX_WRITE_QUEUE = 20 * 1024 * 1024
const utf8 = new TextDecoder('utf-8', { fatal: true })
export interface CoreHello extends Record<string, unknown> {
  generation: number
  version: string
  core: { id: string; name: string }
  framed: boolean
  methods: string[]
  features: string[]
}
export interface CoreCallOptions { timeoutMs?: number; signal?: AbortSignal }
export interface CoreNotification { method: 'event' | 'heartbeat' | 'missed'; params: Record<string, unknown> }
export type CoreFrame = { kind: 'data'; data: Buffer } | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'close'; reason?: Record<string, unknown> }
type Listener<T> = (value: T) => void | Promise<void>
type Subscription = { dispose(): void }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function json(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(utf8.decode(bytes))
  if (!object(value)) throw new Error('Invalid core JSON message')
  return value
}
export class CoreRpcError extends Error {
  readonly kind?: string
  readonly hint?: string
  readonly code?: number
  constructor(error: Record<string, unknown>) {
    const data = object(error.data) ? error.data : {}
    const message = typeof error.message === 'string' ? error.message.slice(0, 1000) : 'Core request failed'
    const hint = typeof data.hint === 'string' ? data.hint.slice(0, 1000) : undefined
    super(hint ? `${message} (${hint})` : message)
    this.name = 'CoreRpcError'
    this.kind = typeof data.kind === 'string' ? data.kind : undefined
    this.hint = hint
    this.code = typeof error.code === 'number' ? error.code : undefined
  }
}
function frame(channel: number, kind: number, data: Buffer): Buffer {
  if (data.length > CORE_MAX_PAYLOAD) throw new Error('Core frame is too large')
  const header = Buffer.alloc(HEADER)
  header.writeUInt32LE(channel, 0); header[4] = kind; header.writeUInt32LE(data.length, 5)
  return Buffer.concat([header, data])
}
function dimension(value: number): boolean { return Number.isInteger(value) && value > 0 && value <= 65535 }

/** An ordered channel. Credit follows completed parsing, never just receipt. */
export class CoreStream {
  private readonly listeners = new Set<Listener<CoreFrame>>()
  private readonly dataListeners = new Set<Listener<Buffer>>()
  private readonly resizeListeners = new Set<Listener<{ cols: number; rows: number }>>()
  private readonly closeListeners = new Set<(reason?: Record<string, unknown>) => void>()
  private queue: CoreFrame[] = []
  private queuedBytes = 0
  private draining = false
  private started = false
  private ended = false
  private closeReason?: Record<string, unknown>
  constructor(readonly channel: number, private readonly rpc: CoreRpc) {}
  onFrame(listener: Listener<CoreFrame>): Subscription {
    this.listeners.add(listener); this.started = true; this.schedule()
    return { dispose: () => this.listeners.delete(listener) }
  }
  onData(listener: Listener<Buffer>): Subscription {
    this.dataListeners.add(listener); this.started = true; this.schedule()
    return { dispose: () => this.dataListeners.delete(listener) }
  }
  onResize(listener: Listener<{ cols: number; rows: number }>): Subscription {
    this.resizeListeners.add(listener)
    return { dispose: () => this.resizeListeners.delete(listener) }
  }
  onClose(listener: (reason?: Record<string, unknown>) => void): Subscription {
    this.closeListeners.add(listener)
    if (this.ended) queueMicrotask(() => { if (this.closeListeners.has(listener)) listener(this.closeReason) })
    return { dispose: () => this.closeListeners.delete(listener) }
  }
  /** Internal routing is installed before resolving the attach/subscribe reply. */
  receive(value: CoreFrame): void {
    if (this.ended) return
    if (value.kind === 'data') {
      this.queuedBytes += value.data.length
      if (this.queuedBytes > MAX_QUEUE) { this.rpc.fail(new Error('Core stream consumer fell behind')); return }
    }
    this.queue.push(value); this.schedule()
  }
  private schedule(): void {
    if (!this.started || this.draining || this.ended) return
    this.draining = true
    queueMicrotask(() => { void this.drain() })
  }
  private async drain(): Promise<void> {
    try {
      while (!this.ended && this.queue.length) {
        const value = this.queue.shift()!
        for (const listener of this.listeners) await listener(value)
        if (value.kind === 'data') {
          for (const listener of this.dataListeners) await listener(value.data)
          this.queuedBytes -= value.data.length
          if (!this.ended) this.credit(value.data.length)
        } else if (value.kind === 'resize') {
          for (const listener of this.resizeListeners) await listener({ cols: value.cols, rows: value.rows })
        } else this.finish(value.reason)
      }
    } catch (error) { this.rpc.fail(error instanceof Error ? error : new Error('Core stream consumer failed')) }
    finally { this.draining = false; if (this.queue.length) this.schedule() }
  }
  write(data: Buffer | string): void { this.send(0, Buffer.isBuffer(data) ? data : Buffer.from(data)) }
  resize(cols: number, rows: number): void {
    if (!dimension(cols) || !dimension(rows)) throw new Error('Invalid core viewport size')
    const data = Buffer.alloc(4); data.writeUInt16LE(cols); data.writeUInt16LE(rows, 2); this.send(3, data)
  }
  focus(focused: boolean): void { this.send(4, Buffer.from([focused ? 1 : 0])) }
  facts(display: Record<string, unknown>): void { this.send(5, Buffer.from(JSON.stringify(display))) }
  credit(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0xffffffff) throw new Error('Invalid core credit')
    if (!bytes) return
    const data = Buffer.alloc(4); data.writeUInt32LE(bytes); this.send(1, data)
  }
  private send(kind: number, data: Buffer): void { if (!this.ended && this.rpc.connected) this.rpc.send(this.channel, kind, data) }
  close(): void {
    if (this.ended) return
    this.send(2, Buffer.alloc(0)); this.rpc.retire(this.channel); this.finish()
  }
  finish(reason?: Record<string, unknown>): void {
    if (this.ended) return
    this.ended = true; this.closeReason = reason; this.queue = []; this.queuedBytes = 0
    for (const listener of this.closeListeners) listener(reason)
    this.listeners.clear(); this.dataListeners.clear(); this.resizeListeners.clear(); this.closeListeners.clear()
  }
}

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  aborted?: () => void
  signal?: AbortSignal
  stream?: boolean
}
export class CoreRpc {
  hello!: CoreHello
  private readonly socket: Socket
  private input: Buffer = Buffer.alloc(0)
  private framed = false
  private closed = false
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly streams = new Map<number, CoreStream>()
  private readonly retired = new Set<number>()
  private readonly closeListeners = new Set<(error: Error) => void>()
  private failure?: Error
  private resolveReady!: (rpc: CoreRpc) => void
  private rejectReady!: (error: Error) => void
  private readonly ready: Promise<CoreRpc>
  private readonly deadline: ReturnType<typeof setTimeout>
  get connected(): boolean { return !this.closed }
  private constructor(socketPath: string, options: CoreCallOptions) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    this.socket = createConnection(socketPath)
    this.deadline = setTimeout(() => this.fail(new Error('Core handshake timed out')), options.timeoutMs ?? 15000)
    this.deadline.unref()
    const abort = () => this.fail(new DOMException('Core connection cancelled', 'AbortError'))
    options.signal?.addEventListener('abort', abort, { once: true })
    void this.ready.then(() => options.signal?.removeEventListener('abort', abort), () => options.signal?.removeEventListener('abort', abort))
    this.socket.once('connect', () => {
      if (!this.closed) this.socket.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'hello', params: { generation: 1, framed: true } }) + '\n')
    })
    this.socket.on('data', data => { try { this.receive(Buffer.isBuffer(data) ? data : Buffer.from(data)) } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid core protocol')) } })
    this.socket.once('error', error => this.fail(new Error(`Core connection failed: ${error.message}`)))
    this.socket.once('end', () => this.fail(new Error(this.input.length ? 'Core closed with a truncated frame' : 'Core connection closed')))
    this.socket.once('close', () => this.fail(new Error('Core connection closed')))
  }
  static connect(socketPath: string, options: CoreCallOptions = {}): Promise<CoreRpc> {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Core connection cancelled', 'AbortError'))
    return new CoreRpc(socketPath, options).ready
  }
  onClose(listener: (error: Error) => void): Subscription {
    this.closeListeners.add(listener)
    if (this.failure) queueMicrotask(() => { if (this.closeListeners.has(listener)) listener(this.failure!) })
    return { dispose: () => this.closeListeners.delete(listener) }
  }
  call<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, options: CoreCallOptions = {}): Promise<T> {
    return this.request(method, params, options, false) as Promise<T>
  }
  private request(method: string, params: Record<string, unknown>, options: CoreCallOptions, stream: boolean): Promise<unknown> {
    if (this.closed) return Promise.reject(this.failure || new Error('Core connection closed'))
    if (options.signal?.aborted) return Promise.reject(new DOMException('Core request cancelled', 'AbortError'))
    if (!this.hello.methods.includes(method)) return Promise.reject(new Error(`Core method unavailable: ${method}`))
    if (this.pending.size >= 64) return Promise.reject(new Error('Too many pending core requests'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.clear(id); reject(error)
        // A late attach result would otherwise leave an unreachable viewer alive.
        if (stream) this.fail(error)
      }
      const timer = setTimeout(() => cancel(new Error(`Core request timed out: ${method}`)), options.timeoutMs ?? 15000)
      timer.unref()
      const aborted = () => cancel(new DOMException('Core request cancelled', 'AbortError'))
      this.pending.set(id, { method, resolve, reject, timer, signal: options.signal, aborted, stream })
      options.signal?.addEventListener('abort', aborted, { once: true })
      try { this.send(0, 0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))) }
      catch (error) { this.clear(id); reject(error); if (stream) this.fail(error instanceof Error ? error : new Error('Core request failed')) }
    })
  }
  async attach(params: Record<string, unknown>, options: CoreCallOptions = {}): Promise<{ terminal: Record<string, unknown>; channel: number; stream: CoreStream; resize_notifications: boolean }> {
    const attached = await this.request('terminal.attach', params, options, true) as { result: Record<string, unknown>; stream: CoreStream }
    if (!object(attached.result.terminal)) { attached.stream.close(); throw new Error('Invalid core attach terminal') }
    return { terminal: attached.result.terminal, channel: attached.stream.channel, stream: attached.stream, resize_notifications: attached.result.resize_notifications === true }
  }
  async subscribe(params: Record<string, unknown>, listener: Listener<CoreNotification>, options: CoreCallOptions = {}): Promise<{ snapshot: { seq: number; terminals: Record<string, unknown>[] }; stream: CoreStream; start(): void; close(): void }> {
    const subscribed = await this.request('events.subscribe', params, options, true) as { result: Record<string, unknown>; stream: CoreStream }
    const { result, stream } = subscribed
    if (!Number.isSafeInteger(result.seq) || (result.seq as number) < 0 || !Array.isArray(result.terminals) || !result.terminals.every(object)) {
      stream.close(); throw new Error('Invalid core subscription snapshot')
    }
    let started = false, bytes: Buffer = Buffer.alloc(0)
    return {
      snapshot: { seq: result.seq as number, terminals: result.terminals as Record<string, unknown>[] }, stream,
      start: () => {
        if (started) return
        started = true
        stream.onData(async data => {
          bytes = Buffer.concat([bytes, data])
          let end: number
          while ((end = bytes.indexOf(10)) >= 0) {
            if (end > CORE_MAX_PAYLOAD) throw new Error('Core event message is too large')
            const value = json(bytes.subarray(0, end)); bytes = bytes.subarray(end + 1)
            if (value.jsonrpc !== '2.0' || !['event', 'heartbeat', 'missed'].includes(value.method as string) || !object(value.params)
              || !Number.isSafeInteger(value.params.seq) || (value.params.seq as number) < 0) throw new Error('Invalid core event notification')
            await listener(value as unknown as CoreNotification)
          }
          if (bytes.length > CORE_MAX_PAYLOAD) throw new Error('Core event message is too large')
        })
      }, close: () => stream.close(),
    }
  }
  private clear(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    if (pending) { clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.aborted!); this.pending.delete(id) }
    return pending
  }
  private receive(data: Buffer): void {
    this.input = Buffer.concat([this.input, data])
    if (!this.framed) {
      const end = this.input.indexOf(10)
      if (end < 0) { if (this.input.length > 1024 * 1024) throw new Error('Core hello is too large'); return }
      if (end > 1024 * 1024) throw new Error('Core hello is too large')
      const reply = json(this.input.subarray(0, end)); this.input = this.input.subarray(end + 1)
      if (reply.jsonrpc !== '2.0' || reply.id !== 0) throw new Error('Invalid core hello reply')
      if (object(reply.error)) throw new CoreRpcError(reply.error)
      const hello = reply.result
      if (!object(hello) || hello.generation !== 1 || hello.framed !== true || !object(hello.core)
        || typeof hello.core.id !== 'string' || !hello.core.id || hello.core.id.length > 256 || /[\x00-\x1f\x7f]/u.test(hello.core.id)
        || typeof hello.core.name !== 'string' || typeof hello.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(hello.version)
        || !Array.isArray(hello.methods) || !hello.methods.every(value => typeof value === 'string')
        || !Array.isArray(hello.features) || !hello.features.every(value => typeof value === 'string')
        || !['framed', 'attach', 'events'].every(feature => (hello.features as string[]).includes(feature))
        || !['terminal.list', 'terminal.attach', 'events.subscribe', 'doc.get'].every(method => (hello.methods as string[]).includes(method))) throw new Error('Incompatible herdr-core hello')
      this.hello = hello as unknown as CoreHello
      this.framed = true; clearTimeout(this.deadline); this.resolveReady(this)
    }
    while (this.input.length >= HEADER) {
      const channel = this.input.readUInt32LE(0), kind = this.input[4]!, length = this.input.readUInt32LE(5)
      if (length > CORE_MAX_PAYLOAD) throw new Error('Core frame is too large')
      if (this.input.length < HEADER + length) break
      const payload = this.input.subarray(HEADER, HEADER + length); this.input = this.input.subarray(HEADER + length)
      if (channel === 0) {
        if (kind !== 0) throw new Error('Invalid core control frame')
        this.reply(json(payload)); continue
      }
      const stream = this.streams.get(channel)
      if (!stream) { if (this.retired.has(channel)) continue; throw new Error('Unknown core stream channel') }
      if (kind === 0) stream.receive({ kind: 'data', data: payload })
      else if (kind === 3 && payload.length === 4 && dimension(payload.readUInt16LE(0)) && dimension(payload.readUInt16LE(2)))
        stream.receive({ kind: 'resize', cols: payload.readUInt16LE(0), rows: payload.readUInt16LE(2) })
      else if (kind === 2) { this.retire(channel); stream.receive({ kind: 'close', ...(payload.length ? { reason: json(payload) } : {}) }) }
      else if (kind !== 1 || payload.length !== 4) throw new Error('Invalid core stream frame')
    }
  }
  private reply(value: Record<string, unknown>): void {
    if (value.jsonrpc !== '2.0' || !Number.isSafeInteger(value.id)) throw new Error('Invalid core reply')
    const pending = this.clear(value.id as number)
    if (!pending) return // A timed-out non-stream call is never retried.
    if (object(value.error)) { pending.reject(new CoreRpcError(value.error)); return }
    if (!Object.hasOwn(value, 'result')) { pending.reject(new Error('Core reply has no result')); return }
    if (!pending.stream) { pending.resolve(value.result); return }
    if (!object(value.result) || !Number.isInteger(value.result.channel) || (value.result.channel as number) < 1 || (value.result.channel as number) > 0xffffffff
      || this.streams.has(value.result.channel as number) || this.retired.has(value.result.channel as number)) {
      const error = new Error('Invalid core stream channel'); pending.reject(error); throw error
    }
    const stream = new CoreStream(value.result.channel as number, this)
    this.streams.set(stream.channel, stream)
    pending.resolve({ result: value.result, stream })
  }
  send(channel: number, kind: number, data: Buffer): void {
    if (this.closed) throw this.failure || new Error('Core connection closed')
    if (this.socket.writableLength + data.length > MAX_WRITE_QUEUE) { const error = new Error('Core input queue is full'); this.fail(error); throw error }
    this.socket.write(frame(channel, kind, data))
  }
  retire(channel: number): void {
    this.streams.delete(channel); this.retired.add(channel)
    if (this.retired.size > 4096) this.retired.delete(this.retired.values().next().value!)
  }
  fail(error: Error): void {
    if (this.closed) return
    this.closed = true; this.failure = error; clearTimeout(this.deadline); this.socket.destroy(); this.rejectReady(error)
    for (const [id, pending] of this.pending) { this.clear(id); pending.reject(error) }
    for (const stream of this.streams.values()) stream.finish({ reason: 'disconnected', message: error.message })
    this.streams.clear(); this.input = Buffer.alloc(0)
    for (const listener of this.closeListeners) listener(error)
    this.closeListeners.clear()
  }
  close(): void { this.fail(new Error('Core connection closed by Canvas')) }
}
