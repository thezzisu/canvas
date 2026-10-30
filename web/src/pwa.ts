/// <reference types="vite-plugin-pwa/client" />
import { ref, shallowRef } from 'vue'
import { registerSW } from 'virtual:pwa-register'
import { pwaUpdateActions } from './pwa-update'

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>
}
const installPrompt = shallowRef<InstallPrompt>()
export const canInstall = ref(false)
export const updateAvailable = ref(false)
export const updateDismissed = ref(false)
export const pwaBusy = ref(false)
export const pwaFailure = ref(false)
let started = false, registration: ServiceWorkerRegistration | undefined
let updateWorker: () => Promise<void> = async () => {}
const updates = pwaUpdateActions({
  waiting: () => !!registration?.waiting,
  activate: () => updateWorker(),
  reload: () => window.location.reload(),
  notify: () => { updateAvailable.value = true; updateDismissed.value = false },
})
export function initializePwa() {
  if (started || !import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator)) return
  started = true
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    installPrompt.value = event as InstallPrompt
    canInstall.value = !matchMedia('(display-mode: standalone)').matches
  })
  window.addEventListener('appinstalled', () => { installPrompt.value = undefined; canInstall.value = false })
  updateWorker = registerSW({
    onNeedRefresh: () => { updateAvailable.value = true; updateDismissed.value = false },
    onNeedReload: () => updates.activated(),
    onRegisteredSW: (_url, value) => { registration = value },
    // Offline/unavailable registration leaves the ordinary web application usable.
    onRegisterError: () => {},
  })
  const check = () => { if (!document.hidden) void registration?.update().catch(() => {}) }
  document.addEventListener('visibilitychange', check)
  setInterval(check, 60 * 60_000)
}
export async function installPwa() {
  const prompt = installPrompt.value
  if (!prompt || pwaBusy.value) return
  pwaBusy.value = true; pwaFailure.value = false
  try { await prompt.prompt(); installPrompt.value = undefined; canInstall.value = false }
  catch { pwaFailure.value = true }
  finally { pwaBusy.value = false }
}
export async function applyPwaUpdate() {
  if (pwaBusy.value) return
  pwaBusy.value = true; pwaFailure.value = false
  try { await updates.apply() }
  catch { pwaFailure.value = true; pwaBusy.value = false }
}
