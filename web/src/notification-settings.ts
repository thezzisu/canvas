import { useStorage } from '@vueuse/core'
import { computed, ref, watch } from 'vue'

export const notificationSoundEnabled = useStorage('canvas:notifications:sound', false)
export const notificationSystemEnabled = useStorage('canvas:notifications:system', false)
export const notificationSoundSupported = computed(() => typeof AudioContext !== 'undefined')
export const systemNotificationSupported = computed(() => typeof window !== 'undefined' && window.isSecureContext &&
  typeof Notification !== 'undefined' && 'serviceWorker' in navigator &&
  typeof ServiceWorkerRegistration !== 'undefined' && 'showNotification' in ServiceWorkerRegistration.prototype)
export const systemNotificationPermission = ref<NotificationPermission>(typeof Notification === 'undefined' ? 'default' : Notification.permission)
export const systemNotificationRequesting = ref(false)
export const notificationSettingsError = ref('')

let audio: AudioContext | undefined
let soundRequest = 0, permissionRequest = 0

watch(notificationSoundEnabled, enabled => {
  if (enabled) return
  soundRequest++
  const previous = audio
  audio = undefined
  void previous?.close().catch(() => {})
}, { flush: 'sync' })

/** Called only from an explicit setting change or a trusted page interaction. */
export async function unlockNotificationSound(): Promise<void> {
  if (!notificationSoundEnabled.value || !notificationSoundSupported.value) return
  try {
    const current = audio ??= new AudioContext()
    if (current.state !== 'running') await current.resume()
  } catch { /* Browsers can withhold audio until another user interaction. */ }
}

export async function setNotificationSound(enabled: boolean): Promise<void> {
  const current = ++soundRequest
  notificationSettingsError.value = ''
  notificationSoundEnabled.value = enabled
  if (!enabled) return
  await unlockNotificationSound()
  if (current !== soundRequest || !notificationSoundEnabled.value) return
  if (audio?.state !== 'running') {
    notificationSoundEnabled.value = false
    notificationSettingsError.value = 'settings.notificationSoundFailed'
  }
}

export function canPlayNotificationSound(): boolean {
  return notificationSoundEnabled.value && audio?.state === 'running'
}

/** Automatic delivery never resumes audio or asks for browser permission. */
export function playNotificationSound(kind: 'attention' | 'done'): void {
  if (!canPlayNotificationSound()) return
  try { playTone(audio!, kind) } catch { /* Optional audio never interrupts the workspace. */ }
}

function playTone(context: AudioContext, kind: 'attention' | 'done', ended?: () => void) {
  const start = context.currentTime
  const tone = context.createOscillator(), gain = context.createGain()
  tone.type = 'sine'
  tone.frequency.setValueAtTime(kind === 'attention' ? 660 : 523.25, start)
  tone.frequency.setValueAtTime(kind === 'attention' ? 880 : 659.25, start + .11)
  gain.gain.setValueAtTime(0, start)
  gain.gain.linearRampToValueAtTime(.08, start + .012)
  gain.gain.linearRampToValueAtTime(0, start + .23)
  tone.connect(gain); gain.connect(context.destination)
  tone.onended = () => { tone.disconnect(); gain.disconnect(); ended?.() }
  tone.start(start); tone.stop(start + .24)
}

/** A one-off preview does not enable future alerts. */
export async function testNotificationSound(valid: () => boolean): Promise<void> {
  notificationSettingsError.value = ''
  if (!notificationSoundSupported.value) return
  let preview: AudioContext | undefined
  const close = () => { void preview?.close().catch(() => {}) }
  try {
    preview = new AudioContext()
    if (preview.state !== 'running') await preview.resume()
    if (!valid()) return
    if (preview.state !== 'running') throw new Error('Audio unavailable')
    await new Promise<void>(resolve => playTone(preview!, 'done', resolve))
  } catch {
    if (valid()) notificationSettingsError.value = 'settings.notificationSoundFailed'
  } finally { close() }
}

export function showSystemNotification(registration: ServiceWorkerRegistration, title: string, options: NotificationOptions) {
  return registration.showNotification(title, { icon: new URL('icons/icon-192.png', location.href).href, silent: true, ...options })
}

export function refreshNotificationPermission(): void {
  systemNotificationPermission.value = typeof Notification === 'undefined' ? 'default' : Notification.permission
}

/** Called only by a settings toggle or test button gesture. */
async function requestNotificationPermission(valid: () => boolean): Promise<boolean> {
  if (!systemNotificationSupported.value || systemNotificationRequesting.value) return false
  refreshNotificationPermission()
  if (systemNotificationPermission.value === 'granted') return true
  if (systemNotificationPermission.value === 'denied') return false
  systemNotificationRequesting.value = true
  try {
    systemNotificationPermission.value = await Notification.requestPermission()
    if (valid() && systemNotificationPermission.value === 'default') notificationSettingsError.value = 'settings.notificationPermissionMissing'
    return systemNotificationPermission.value === 'granted'
  } catch {
    if (valid()) notificationSettingsError.value = 'settings.notificationPermissionFailed'
    return false
  } finally { systemNotificationRequesting.value = false }
}

export async function setSystemNotifications(enabled: boolean): Promise<void> {
  if (enabled && systemNotificationRequesting.value) return
  const current = ++permissionRequest
  notificationSettingsError.value = ''
  if (!enabled) { notificationSystemEnabled.value = false; return }
  const granted = await requestNotificationPermission(() => current === permissionRequest)
  if (current === permissionRequest) notificationSystemEnabled.value = granted
}

export async function testSystemNotification(title: string, body: string, valid: () => boolean): Promise<void> {
  notificationSettingsError.value = ''
  if (!await requestNotificationPermission(valid) || !valid()) return
  try {
    const registration = await navigator.serviceWorker.getRegistration()
    if (!valid()) return
    if (!registration?.active) throw new Error('No active service worker')
    await showSystemNotification(registration, title, { body, tag: 'canvas:notification-test' })
  } catch {
    if (valid()) notificationSettingsError.value = 'settings.notificationTestFailed'
  }
}
