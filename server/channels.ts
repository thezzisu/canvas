/**
 * How a value or an event reaches the code that subscribed to it. Every subscription is a
 * standard `Disposable`. Disposing a channel drops its subscribers, so nothing reaches anyone
 * after its owner has closed.
 */
export interface Subscribable<T> {
  subscribe(listener: (value: T) => void): Disposable
}

/** Something that happens: a subscriber hears of it while subscribed, and never afterwards. */
export class Events<T = void> implements Subscribable<T>, Disposable {
  private readonly listeners = new Set<(value: T) => void>()
  private closed = false

  subscribe(listener: (value: T) => void): Disposable {
    if (!this.closed) this.listeners.add(listener)
    return { [Symbol.dispose]: () => void this.listeners.delete(listener) }
  }
  emit(value: T) {
    for (const listener of this.listeners) listener(value)
  }
  [Symbol.dispose]() {
    this.closed = true
    this.listeners.clear()
  }
}

/**
 * Something that has a current value.
 * - A new subscriber is given the latest value in a microtask, unless a newer one reached it
 *   first; it never receives an older value after a newer one.
 * - With `key`, setting a value whose key equals the current one's tells nobody.
 */
export class Latest<T> implements Subscribable<T>, Disposable {
  private readonly subscribers = new Set<{ listener: (value: T) => void; owed: boolean }>()
  private value?: { current: T; key: unknown }
  private closed = false

  constructor(private readonly key?: (value: T) => unknown) {}

  get current(): T | undefined {
    return this.value?.current
  }
  /** Whether `value` became current. */
  set(value: T): boolean {
    if (this.closed) return false
    const key = this.key?.(value)
    if (this.key && this.value && Object.is(this.value.key, key)) return false
    this.value = { current: value, key }
    for (const subscriber of this.subscribers) {
      subscriber.owed = false
      subscriber.listener(value)
    }
    return true
  }
  /** Forgets the current value without telling anyone. */
  clear() {
    this.value = undefined
  }
  /** With `replay` false, only later values are given. */
  subscribe(listener: (value: T) => void, { replay = true } = {}): Disposable {
    const subscriber = { listener, owed: replay }
    if (!this.closed) this.subscribers.add(subscriber)
    if (replay)
      queueMicrotask(() => {
        if (!subscriber.owed || !this.subscribers.has(subscriber) || !this.value) return
        subscriber.owed = false
        listener(this.value.current)
      })
    return { [Symbol.dispose]: () => void this.subscribers.delete(subscriber) }
  }
  [Symbol.dispose]() {
    this.closed = true
    this.subscribers.clear()
  }
}
