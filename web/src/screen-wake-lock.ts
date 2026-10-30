import { useStorage } from '@vueuse/core'
import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

type WakeLockState = 'off' | 'pending' | 'active' | 'released' | 'denied'
interface ScreenLock extends EventTarget { readonly released: boolean; release(): Promise<void> }

/** A pending browser request cannot be cancelled; release obsolete results. */
export class ScreenWakeLockController {
  private active = false
  private disposed = false
  private pending = false
  private revision = 0
  private lock?: ScreenLock
  private onRelease?: () => void
  constructor(private readonly request: () => Promise<ScreenLock>, private readonly changed: (state: WakeLockState) => void) {}

  setActive(active: boolean) {
    if (this.disposed || active === this.active) return
    this.active = active; this.revision++
    if (active) this.acquire()
    else { this.release(); this.changed('off') }
  }

  retry() {
    if (this.disposed || !this.active || this.pending || this.lock) return
    this.revision++; this.acquire()
  }

  private acquire() {
    if (this.pending || !this.active || this.disposed) return
    const revision = this.revision
    this.pending = true; this.changed('pending')
    void (async () => {
      try {
        const lock = await this.request()
        if (this.disposed || !this.active || revision !== this.revision) { await lock.release().catch(() => {}); return }
        if (lock.released) { this.changed('released'); return }
        this.lock = lock
        this.onRelease = () => {
          if (this.lock !== lock) return
          lock.removeEventListener('release', this.onRelease!)
          this.lock = undefined; this.onRelease = undefined
          this.changed('released')
        }
        lock.addEventListener('release', this.onRelease)
        this.changed('active')
      } catch {
        if (!this.disposed && this.active && revision === this.revision) this.changed('denied')
      } finally {
        this.pending = false
        if (!this.disposed && this.active && revision !== this.revision) this.acquire()
      }
    })()
  }

  private release() {
    const lock = this.lock
    if (!lock) return
    if (this.onRelease) lock.removeEventListener('release', this.onRelease)
    this.lock = undefined; this.onRelease = undefined
    void lock.release().catch(() => {})
  }

  dispose() {
    this.disposed = true; this.active = false; this.revision++
    this.release(); this.changed('off')
  }
}

export const keepScreenAwake = useStorage('canvas:display:keep-awake', false)
export const screenWakeLockState = ref<WakeLockState>('off')
export const screenWakeLockUnavailable = typeof window === 'undefined' || !window.isSecureContext
  ? '需要 HTTPS' : typeof navigator.wakeLock?.request !== 'function' ? '浏览器不支持' : ''
let retry = () => {}
export function retryScreenWakeLock() { retry() }

export function useScreenWakeLock(authenticated: Ref<boolean>) {
  const controller = new ScreenWakeLockController(() => navigator.wakeLock.request('screen'), state => { screenWakeLockState.value = state })
  let mounted = false
  const update = () => controller.setActive(mounted && authenticated.value && keepScreenAwake.value &&
    !screenWakeLockUnavailable && document.visibilityState === 'visible')
  const hide = () => controller.setActive(false)
  retry = () => controller.retry()
  const stop = watch([authenticated, keepScreenAwake], update, { flush: 'sync' })
  onMounted(() => {
    mounted = true
    document.addEventListener('visibilitychange', update)
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', update)
    update()
  })
  onBeforeUnmount(() => {
    mounted = false; stop(); retry = () => {}; controller.dispose()
    document.removeEventListener('visibilitychange', update)
    window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', update)
  })
}
