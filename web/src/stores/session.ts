import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { useEventListener } from '@vueuse/core'
import {
  api,
  apiContext,
  apiUrl,
  isCurrentApi,
  requireCurrentApi,
  resetApiRequests,
  setSessionToken,
  write,
  ApiError,
} from '../api/api'
import { t } from '../app/i18n'
import {
  activeInstance,
  hasActiveInstance,
  invalidInstanceLink,
  rememberInstance,
  rememberInstanceUsername,
} from '../instances/instances'
import { isCanvasSession } from '../instances/instance-url'
import {
  instanceBuild,
  observeInstanceBuild,
  staleInstanceBuild,
} from '../instances/instance-builds'
import { useEditsStore } from './edits'
import { useWorkspaceStore } from './workspace'

type LeaveGuard = () => Promise<boolean> | boolean

/** Who is signed in to the active instance, and the checks that decide it. */
export const useSessionStore = defineStore('session', () => {
  const workspace = useWorkspaceStore()
  /** False only until the first instance check has started. */
  const ready = ref(false)
  const authenticated = ref(false)
  const checking = ref(false)
  const unavailable = ref(invalidInstanceLink)
  const setupMessage = ref(invalidInstanceLink ? 'instances.invalidUrl' : '')
  const username = ref('')
  const signingIn = ref(false)
  const failure = shallowRef<unknown>()
  /** The address names an instance this browser has not saved. */
  const unknownInstance = ref<string>()
  const serverBuild = computed(() => instanceBuild(activeInstance.value))
  const loginError = computed(() => {
    const reason = failure.value
    if (!reason) return ''
    if (reason instanceof ApiError && reason.status === 401) return t('common.invalidCredentials')
    if (reason instanceof ApiError && reason.status === 429) return t('common.tooManyAttempts')
    return reason instanceof Error ? reason.message : t('app.loginFailed')
  })
  let activation = 0
  let authorizationCheck: Promise<void> | undefined
  const leaveGuards = new Set<LeaveGuard>()

  watch([authenticated, username], ([signedIn, name]) => {
    if (signedIn && name) rememberInstanceUsername(name)
  })

  /** Views with unsaved, undecided work (a layout draft) may keep the user on the instance. */
  function onBeforeLeave(guard: LeaveGuard) {
    leaveGuards.add(guard)
    return () => leaveGuards.delete(guard)
  }
  /** Everything the user did is stored, or they chose to stay. */
  async function canLeave() {
    for (const guard of leaveGuards) if (!(await guard())) return false
    return !authenticated.value || useEditsStore().flushAll()
  }

  function reset() {
    workspace.reset()
    resetApiRequests()
    authenticated.value = false
    signingIn.value = false
    failure.value = undefined
    username.value = activeInstance.value.username || ''
  }
  /** Check the active instance and, when it already has a session, load its workspace. */
  async function activate() {
    const current = ++activation
    reset()
    ready.value = true
    checking.value = true
    unavailable.value = false
    setupMessage.value = ''
    if (!hasActiveInstance.value) {
      checking.value = false
      unavailable.value = true
      return
    }
    const context = apiContext()
    staleInstanceBuild(context)
    try {
      const session = await api<{ authenticated: boolean; username?: string; server: unknown }>(
        '/api/session',
        { signal: AbortSignal.timeout(15_000) },
        context,
      )
      requireCurrentApi(context)
      if (!isCanvasSession(session)) throw new Error('Invalid Canvas session')
      observeInstanceBuild(context, session.server)
      rememberInstance()
      if (!session.authenticated && context.token) setSessionToken('')
      authenticated.value = session.authenticated
      username.value = session.username || activeInstance.value.username || ''
      if (authenticated.value) await workspace.load()
    } catch (reason) {
      if (current === activation && isCurrentApi(context)) {
        if (!authenticated.value) unavailable.value = true
        else failure.value = reason
      }
    } finally {
      if (current === activation) checking.value = false
    }
  }
  /** Put the instance away without checking another, as for an unknown address. */
  function suspend() {
    activation++
    reset()
    ready.value = true
    checking.value = false
  }
  function connect() {
    if (!checking.value) void activate()
  }
  async function login(password: string) {
    const context = apiContext()
    signingIn.value = true
    failure.value = undefined
    try {
      const session = await api<{ token: string; username: string; server: unknown }>(
        '/api/login',
        { method: 'POST', body: JSON.stringify({ username: username.value, password }) },
        context,
      )
      requireCurrentApi(context)
      observeInstanceBuild(context, session.server)
      setSessionToken(session.token)
      username.value = session.username
      authenticated.value = true
      await workspace.load()
      return true
    } catch (reason) {
      if (
        context.id === activeInstance.value.id &&
        !(reason instanceof Error && reason.name === 'AbortError')
      )
        failure.value = reason
      return false
    } finally {
      if (context.id === activeInstance.value.id) signingIn.value = false
    }
  }
  function signOut() {
    setSessionToken('')
    reset()
    checking.value = false
  }
  async function logout() {
    if (!(await canLeave())) return
    const context = apiContext()
    await write('/api/logout', 'POST')
    if (isCurrentApi(context)) signOut()
  }
  /** A 401 may come from a stale request; only the session endpoint decides sign-out. */
  function verifyAuthorization() {
    const context = apiContext()
    if (!context.token || authorizationCheck) return authorizationCheck
    authorizationCheck = (async () => {
      try {
        const response = await fetch(apiUrl('/api/session', context), {
          headers: new Headers({ Authorization: `Bearer ${context.token}` }),
          credentials: 'omit',
          cache: 'no-store',
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
        })
        if (!isCurrentApi(context)) return
        if (response.status === 401) {
          signOut()
          return
        }
        if (!response.ok) return
        const session: unknown = await response.json()
        if (isCurrentApi(context) && isCanvasSession(session) && session.authenticated === false)
          signOut()
      } catch {
        /* A transient transport failure must not sign out a valid session. */
      } finally {
        authorizationCheck = undefined
      }
    })()
    return authorizationCheck
  }
  useEventListener(window, 'canvas:unauthorized', () => void verifyAuthorization())
  // Another tab signed this instance in or out.
  useEventListener(window, 'canvas:session-changed', () => void activate())

  return {
    ready,
    authenticated,
    checking,
    unavailable,
    setupMessage,
    username,
    unknownInstance,
    signingIn,
    loginError,
    serverBuild,
    onBeforeLeave,
    canLeave,
    activate,
    suspend,
    connect,
    login,
    logout,
  }
})
