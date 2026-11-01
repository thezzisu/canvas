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

/** Alert delivery never resumes audio or asks for browser permission. */
export function playNotificationSound(kind: 'attention' | 'done'): void {
  if (!notificationSoundEnabled.value || audio?.state !== 'running') return
  try {
    const context = audio, start = context.currentTime
    const tone = context.createOscillator(), gain = context.createGain()
    tone.type = 'sine'
    tone.frequency.setValueAtTime(kind === 'attention' ? 660 : 523.25, start)
    tone.frequency.setValueAtTime(kind === 'attention' ? 880 : 659.25, start + .11)
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(.08, start + .012)
    gain.gain.linearRampToValueAtTime(0, start + .23)
    tone.connect(gain); gain.connect(context.destination)
    tone.onended = () => { tone.disconnect(); gain.disconnect() }
    tone.start(start); tone.stop(start + .24)
  } catch { /* Audio loss must not interrupt the visual notification. */ }
}

export function refreshNotificationPermission(): void {
  systemNotificationPermission.value = typeof Notification === 'undefined' ? 'default' : Notification.permission
}

/** Permission is requested only by the settings toggle's user gesture. */
export async function setSystemNotifications(enabled: boolean): Promise<void> {
  if (enabled && systemNotificationRequesting.value) return
  const current = ++permissionRequest
  notificationSettingsError.value = ''
  if (!enabled) { notificationSystemEnabled.value = false; systemNotificationRequesting.value = false; return }
  if (!systemNotificationSupported.value) return
  refreshNotificationPermission()
  if (systemNotificationPermission.value === 'granted') { notificationSystemEnabled.value = true; return }
  systemNotificationRequesting.value = true
  try {
    const permission = await Notification.requestPermission()
    systemNotificationPermission.value = permission
    if (current !== permissionRequest) return
    notificationSystemEnabled.value = permission === 'granted'
    if (permission === 'default') notificationSettingsError.value = 'settings.notificationPermissionMissing'
  } catch {
    if (current === permissionRequest) {
      notificationSystemEnabled.value = false
      notificationSettingsError.value = 'settings.notificationPermissionFailed'
    }
  } finally {
    if (current === permissionRequest) systemNotificationRequesting.value = false
  }
}
