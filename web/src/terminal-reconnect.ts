const retryDelays = [500, 1500, 3000] as const
const handshakeTimeout = 12_000
const stableConnection = 5000

interface ReconnectOptions {
  active(): boolean
  connect(probe: boolean): void
  waiting(attempt: number): void
  failed(): void
  timeout(): void
}

/** One bounded retry budget survives view remounts and brief socket flaps. */
export class TerminalReconnect {
  private attempt = 0
  private started = false
  private exhausted = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private handshakeTimer?: ReturnType<typeof setTimeout>
  private stableTimer?: ReturnType<typeof setTimeout>
  constructor(private readonly options: ReconnectOptions) {}

  private connect() {
    this.retryTimer = undefined
    if (!this.options.active() || this.exhausted) return
    this.options.waiting(this.attempt)
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = undefined
      if (this.options.active()) this.options.timeout()
    }, handshakeTimeout)
    const probe = this.started
    this.started = true
    this.options.connect(probe)
  }

  resume() {
    if (!this.options.active() || this.exhausted || this.retryTimer !== undefined || this.handshakeTimer !== undefined) return
    if (this.attempt) this.retryTimer = setTimeout(() => this.connect(), retryDelays[this.attempt - 1]!)
    else this.connect()
  }

  restart() {
    this.pause(); this.attempt = 0; this.exhausted = false
    this.connect()
  }

  connected() {
    clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined
    clearTimeout(this.retryTimer); this.retryTimer = undefined
    if (this.stableTimer !== undefined || !this.options.active()) return
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined
      if (this.options.active()) this.attempt = 0
    }, stableConnection)
  }

  failed(retry = true) {
    this.pause()
    // A hidden or detached view cannot spend retries. Reserve its next attempt
    // for resume; a failure arriving in the background cannot exhaust it.
    if (retry && !this.options.active()) {
      this.attempt = Math.max(1, this.attempt)
      this.options.waiting(this.attempt)
      return
    }
    if (!retry || this.attempt === retryDelays.length) {
      this.exhausted = true; this.options.failed(); return
    }
    this.attempt++
    this.options.waiting(this.attempt)
    if (this.options.active()) this.retryTimer = setTimeout(() => this.connect(), retryDelays[this.attempt - 1]!)
  }

  pause() {
    clearTimeout(this.retryTimer); this.retryTimer = undefined
    clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined
    clearTimeout(this.stableTimer); this.stableTimer = undefined
  }
}
