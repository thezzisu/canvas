/// <reference types="vite-plugin-pwa/client" />
import { computed, ref, shallowRef } from 'vue'
import { registerSW } from 'virtual:pwa-register'
import { checkPwaRegistration, pwaUpdateActions } from './pwa-update'
import { isBuildInfo, type BuildInfo } from '../../shared/build-info'

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>
}
const installPrompt = shallowRef<InstallPrompt>()
export const canInstall = ref(false)
export const updateAvailable = ref(false)
export const updateDismissed = ref(false)
export const pwaBusy = ref(false)
export const pwaFailure = ref(false)
export const updateCheck = ref<'idle' | 'checking' | 'current' | 'failed'>('idle')
/** The deployment that the waiting worker serves, when it could be identified. */
export const updateBuild = shallowRef<BuildInfo>()
let started = false
const registration = shallowRef<ServiceWorkerRegistration>()
export const canCheckUpdate = computed(() => !!registration.value)
let updateWorker: () => Promise<void> = async () => {}
const updates = pwaUpdateActions({
  waiting: () => !!registration.value?.waiting,
  activate: () => updateWorker(),
  reload: () => window.location.reload(),
  notify: () => updateReady(),
})
function updateReady() {
  updateAvailable.value = true
  updateDismissed.value = false
  void fetch(new URL('build-info.json', document.baseURI), { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((value) => {
      if (isBuildInfo(value)) updateBuild.value = value
    })
    .catch(() => {})
}
export function initializePwa() {
  if (
    started ||
    !import.meta.env.PROD ||
    !window.isSecureContext ||
    !('serviceWorker' in navigator)
  )
    return
  started = true
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt.value = event as InstallPrompt
    canInstall.value = !matchMedia(
      '(display-mode: standalone), (display-mode: window-controls-overlay)',
    ).matches
  })
  window.addEventListener('appinstalled', () => {
    installPrompt.value = undefined
    canInstall.value = false
  })
  updateWorker = registerSW({
    onNeedRefresh: updateReady,
    onNeedReload: () => updates.activated(),
    onRegisteredSW: (_url, value) => {
      registration.value = value
    },
    // Offline/unavailable registration leaves the ordinary web application usable.
    onRegisterError: () => {},
  })
  const check = () => {
    if (!document.hidden) void registration.value?.update().catch(() => {})
  }
  document.addEventListener('visibilitychange', check)
  setInterval(check, 60 * 60_000)
}
export async function checkPwaUpdates() {
  const current = registration.value
  if (!current || pwaBusy.value || updateCheck.value === 'checking') return
  updateCheck.value = 'checking'
  try {
    const waiting = await checkPwaRegistration(current)
    // The plugin installs its activation listener before onNeedRefresh exposes Reload.
    updateCheck.value = waiting || updateAvailable.value ? 'idle' : 'current'
  } catch {
    updateCheck.value = 'failed'
  }
}
export async function installPwa() {
  const prompt = installPrompt.value
  if (!prompt || pwaBusy.value) return
  pwaBusy.value = true
  pwaFailure.value = false
  try {
    await prompt.prompt()
    installPrompt.value = undefined
    canInstall.value = false
  } catch {
    pwaFailure.value = true
  } finally {
    pwaBusy.value = false
  }
}
export async function applyPwaUpdate() {
  if (pwaBusy.value) return
  pwaBusy.value = true
  pwaFailure.value = false
  try {
    await updates.apply()
  } catch {
    pwaFailure.value = true
    pwaBusy.value = false
  }
}
