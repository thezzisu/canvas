import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  createEventHook,
  useDocumentVisibility,
  useEventListener,
  useIntervalFn,
  useNow,
} from '@vueuse/core'
import { api, apiContext, apiRevision, isCurrentApi, requireCurrentApi } from '../api/api'
import { subscribeState } from '../api/state-events'
import { t } from '../plugins/i18n'
import { notify } from '../composables/notify'
import { agentIndicator, canvasIndicators } from '../utils/workspace/canvas-status'
import {
  focusedCompletionStatus,
  projectFocusedResources,
  type FocusedStatus,
} from '../utils/workspace/completion-focus'
import { mergeLiveResources, newerListings } from '../utils/workspace/live-resources'
import { RetryDelay } from '../utils/workspace/retry-delay'
import { orderedItems, useSidebarOrder } from '../composables/workspace/sidebar-order'
import { workingSet } from '../utils/workspace/working-set'
import { retainBackgrounds } from '../composables/workspace/backgrounds'
import { applyComposers } from '../composables/terminal/composers'
import { clearCaptureTrust } from '../composables/terminal/capture-trust'
import { hideMobileKeyboard } from '../composables/terminal/mobile-keyboard'
import { liveTerminalMetadata } from '../composables/terminal/terminal-metadata'
import { terminalReadFocus } from '../composables/terminal/terminal-read-focus'
import {
  acknowledgeTerminalMetadata,
  clearTerminals,
  hasLiveTerminal,
  retainTerminalMetadata,
} from '../composables/terminal/terminals'
import { closeTrustedPreview } from '../composables/files/trusted-preview'
import { applyContentFont, resetContentFont } from '../composables/settings/content-font'
import { defaultWindowSize } from '../../../shared/window-size'
import {
  isTerminalNode,
  type Canvas,
  type SharedState,
  type Source,
  type SourceResource,
  type TerminalCanvasNode,
  type WindowSize,
} from '../api/types'
import { useEditsStore } from './edits'
import { useSessionStore } from './session'

/** The connection fields that identify a herdr endpoint; changing one invalidates its windows. */
export function sourceConnection(source: Source) {
  return {
    runtime: source.runtime,
    transport: source.transport,
    herdrSession: source.herdrSession?.trim() || '',
    herdrSocket: source.herdrSocket?.trim() || '',
    ...(source.transport === 'ssh'
      ? {
          target: source.target?.trim() || '',
          sshIdentityFile: source.sshIdentityFile || '',
          sshKnownHostsFile: source.sshKnownHostsFile || '',
        }
      : {}),
  }
}
export const windowKey = (window: { sourceId: string; windowId: string }) =>
  `${window.sourceId}/${window.windowId}`

/** The signed-in instance's shared state and the native windows discovered behind it. */
export const useWorkspaceStore = defineStore('workspace', () => {
  /** The latest complete server snapshot; undefined until the first one arrives. */
  const state = shallowRef<SharedState>()
  const sources = ref<Source[]>([])
  /** Shared canvases with this browser's unsaved note and layout edits applied. */
  const canvases = ref<Canvas[]>([])
  const windowSizes = ref<Record<string, WindowSize>>({})
  const settings = computed(() => state.value?.settings)
  /** Each system canvas has its own background. */
  const systemBackgrounds = computed(() => ({
    overview: state.value?.overviewBackground ?? null,
    'working-set': state.value?.workingSetBackground ?? null,
  }))

  const listedResources = ref<SourceResource[]>([])
  const rawResources = computed(() =>
    mergeLiveResources(listedResources.value, liveTerminalMetadata.value),
  )
  const focusedStatus = computed<FocusedStatus | undefined>((previous) =>
    focusedCompletionStatus(rawResources.value, terminalReadFocus.value, previous),
  )
  const { order: sidebarOrder, remember: rememberSidebarOrder } = useSidebarOrder(
    () => state.value?.navigationOrder,
    apiRevision,
    async (kind, ids) => {
      const context = apiContext()
      await api(
        `/api/navigation-order/${kind}`,
        { method: 'PATCH', body: JSON.stringify({ ids }) },
        context,
      )
      if (isCurrentApi(context)) await sync()
    },
    notify.error,
  )
  const orderedSources = computed(() => orderedItems(sources.value, sidebarOrder.value.sources))
  const orderedCanvases = computed(() => orderedItems(canvases.value, sidebarOrder.value.canvases))
  /** Discovered sources in sidebar order, showing a just-read window's status as read. */
  const resources = computed(() =>
    orderedItems(
      projectFocusedResources(rawResources.value, focusedStatus.value),
      sidebarOrder.value.sources,
    ),
  )
  const resourcesFresh = ref(false)
  const resourcesLoaded = ref(false)
  const loadFailure = shallowRef<unknown>()
  const refreshing = ref(false)
  const refreshedAt = ref(0)
  const visibility = useDocumentVisibility()
  const pageVisible = computed(() => visibility.value === 'visible')
  /** Attention animates only from a current listing on a visible page. */
  const freshStatuses = computed(() => resourcesFresh.value && pageVisible.value)
  const undiscoveredSources = computed(() =>
    sources.value.filter((source) => !resources.value.some((item) => item.id === source.id)),
  )
  const pending = computed(() => !state.value || !resourcesLoaded.value)
  const discovered = computed(() => resourcesLoaded.value && !undiscoveredSources.value.length)

  const allWindows = computed(() =>
    resources.value.flatMap((source) =>
      source.spaces.flatMap((space) =>
        space.windows.map((window) => ({
          source,
          space,
          window,
          key: `${source.id}/${space.id}/${window.id}`,
        })),
      ),
    ),
  )
  /** Canvases holding each window, in sidebar order; live windows are also in Overview. */
  const canvasesByWindow = computed(() => {
    const result = new Map<string, { id: string; name: string }[]>(),
      overview = { id: 'overview', name: t('app.overview') }
    for (const { source, window } of allWindows.value)
      result.set(`${source.id}/${window.id}`, [overview])
    for (const canvas of orderedCanvases.value)
      for (const key of new Set(canvas.nodes.filter(isTerminalNode).map(windowKey))) {
        const list = result.get(key)
        if (list) list.push(canvas)
        else result.set(key, [canvas])
      }
    return result
  })
  /** Windows that some custom canvas already shows. */
  const placedWindows = computed(
    () =>
      new Set(
        canvases.value.flatMap((canvas) => canvas.nodes.filter(isTerminalNode).map(windowKey)),
      ),
  )
  const indicators = computed(() =>
    discovered.value ? canvasIndicators(canvases.value, resources.value) : {},
  )
  // Recent settled windows age out of the working set without any other change.
  const clock = useNow({ scheduler: (update) => useIntervalFn(update, 30_000) })
  const workingSetEntries = computed(() =>
    discovered.value
      ? workingSet(resources.value, state.value?.windowReads || {}, clock.value.getTime())
      : [],
  )
  const workingSetIndicator = computed(() => agentIndicator(workingSetEntries.value))

  function windowSize(node: Pick<TerminalCanvasNode, 'sourceId' | 'windowId'>): WindowSize {
    return windowSizes.value[windowKey(node)] || defaultWindowSize
  }
  function resourceFor(node: Pick<TerminalCanvasNode, 'sourceId' | 'spaceId' | 'windowId'>) {
    const source = resources.value.find((item) => item.id === node.sourceId)
    const space = source?.spaces.find((item) => item.id === node.spaceId)
    // A window can move to another space while remaining on a canvas.
    const home =
      space?.windows.some((item) => item.id === node.windowId) === true
        ? space
        : source?.spaces.find((item) => item.windows.some((window) => window.id === node.windowId))
    return {
      source,
      space,
      window: home?.windows.find((item) => item.id === node.windowId),
      /** The space that holds the window now. */
      spaceId: home?.id || node.spaceId,
    }
  }
  function canvasName(id: string) {
    if (id === 'overview') return t('app.overview')
    if (id === 'working-set') return t('app.workingSet')
    return canvases.value.find((canvas) => canvas.id === id)?.name || t('app.canvas')
  }
  function windowCanvases(sourceId: string, windowId: string) {
    return canvasesByWindow.value.get(`${sourceId}/${windowId}`) || []
  }

  /** Fires after each applied snapshot, once canvases and sizes reflect it. */
  const applied = createEventHook<{ sourcesChanged: boolean }>()
  const notified = createEventHook<unknown>()
  let stateEvents: ReturnType<typeof subscribeState> | undefined
  let resourceRequest: Promise<void> | undefined
  // A full read that failed is tried again, later each time, until one succeeds. Nothing else
  // asks: changes are pushed, and a source with no listing has nothing to push.
  let listingRetry: ReturnType<typeof setTimeout> | undefined
  const listingDelay = new RetryDelay(2000, 30_000)
  function retryListing() {
    clearTimeout(listingRetry)
    listingRetry = setTimeout(() => {
      listingRetry = undefined
      void refresh(true)
    }, listingDelay.take())
  }
  function settleListing() {
    clearTimeout(listingRetry)
    listingRetry = undefined
    listingDelay.reset()
  }

  function apply(snapshot: SharedState) {
    if (state.value?.instanceId === snapshot.instanceId && snapshot.revision < state.value.revision)
      return
    const edits = useEditsStore()
    edits.adopt(snapshot.canvases)
    state.value = snapshot
    applyComposers(snapshot.composers)
    retainBackgrounds(
      [
        snapshot.overviewBackground,
        snapshot.workingSetBackground,
        ...snapshot.canvases.map((canvas) => canvas.background),
      ].flatMap((background) => (background ? [background.url] : [])),
    )
    applyContentFont(snapshot.settings.contentFont)
    const changedConnections = sources.value
      .filter((previous) => {
        const next = snapshot.sources.find((source) => source.id === previous.id)
        return (
          next &&
          JSON.stringify(sourceConnection(next)) !== JSON.stringify(sourceConnection(previous))
        )
      })
      .map((source) => source.id)
    const sourcesChanged = JSON.stringify(sources.value) !== JSON.stringify(snapshot.sources)
    const sizes = { ...snapshot.windowSizes }
    for (const canvas of snapshot.canvases)
      for (const [id, patch] of edits.pendingLayouts.get(canvas.id) || []) {
        const node = canvas.nodes.find((item) => item.id === id)
        if (
          node &&
          isTerminalNode(node) &&
          (patch.width !== undefined || patch.height !== undefined)
        )
          sizes[windowKey(node)] = {
            ...(sizes[windowKey(node)] || windowSize(node)),
            ...(patch.width === undefined ? {} : { width: patch.width }),
            ...(patch.height === undefined ? {} : { height: patch.height }),
          }
      }
    windowSizes.value = sizes
    sources.value = snapshot.sources
    retainTerminalMetadata(
      snapshot.sources.map((source) => source.id),
      changedConnections,
    )
    const noteDrafts = edits.noteDrafts(snapshot.canvases)
    canvases.value = snapshot.canvases.map((canvas) => ({
      ...canvas,
      nodes: (canvas.nodes || []).map((node) => ({
        ...node,
        ...edits.pendingLayouts.get(canvas.id)?.get(node.id),
        ...(node.type === 'note' ? noteDrafts.get(node.id) : {}),
      })),
    }))
    edits.settle(canvases.value)
    if (sourcesChanged) {
      resourcesFresh.value = false
      listedResources.value = listedResources.value.filter(
        (resource) =>
          !changedConnections.includes(resource.id) &&
          sources.value.some((source) => source.id === resource.id),
      )
      if (resourcesLoaded.value) void refresh(true)
    }
    void applied.trigger({ sourcesChanged })
  }
  async function sync() {
    const previous = state.value
    const snapshot = await api<SharedState>('/api/state')
    if (state.value !== previous && state.value?.instanceId !== snapshot.instanceId) return
    apply(snapshot)
  }

  /** An unreachable source keeps the windows whose terminals are still connected. */
  function withLiveWindows(source: SourceResource): SourceResource {
    if (!source.error) return source
    return {
      ...source,
      spaces: (resources.value.find((previous) => previous.id === source.id)?.spaces || []).flatMap(
        (space) => {
          const windows = space.windows.filter((window) => hasLiveTerminal(source.id, window.id))
          return windows.length ? [{ ...space, windows }] : []
        },
      ),
    }
  }
  /** Takes what the server listed, pushed or asked for, unless a later read of it is here. */
  function list(incoming: readonly SourceResource[]) {
    const news = newerListings(
      listedResources.value,
      incoming.filter((listing) => sources.value.some((source) => source.id === listing.id)),
    ).map(withLiveWindows)
    resourcesFresh.value = true
    refreshedAt.value = Date.now()
    if (news.length) {
      const merged = new Map(listedResources.value.map((listing) => [listing.id, listing]))
      for (const listing of news) merged.set(listing.id, listing)
      listedResources.value = sources.value.flatMap((source) => merged.get(source.id) ?? [])
      acknowledgeTerminalMetadata(news)
    }
    // Pushes alone can complete what a failed first read began.
    if (!undiscoveredSources.value.length) {
      resourcesLoaded.value = true
      loadFailure.value = undefined
    }
  }
  /** Reads every source once. A silent refresh joins one in flight and reports nothing. */
  async function refresh(silent = false): Promise<void> {
    if (resourceRequest) {
      if (silent) return
      await resourceRequest
      return refresh()
    }
    if (!state.value) return
    refreshing.value = !silent
    const context = apiContext()
    const configuration = JSON.stringify(sources.value)
    resourceRequest = (async () => {
      try {
        const body = await api<{ sources: SourceResource[] }>('/api/resources')
        if (configuration !== JSON.stringify(sources.value)) return
        resourcesLoaded.value = true
        loadFailure.value = undefined
        settleListing()
        list(body.sources)
      } catch (reason) {
        if (isCurrentApi(context)) {
          resourcesFresh.value = false
          retryListing()
          if (!resourcesLoaded.value || undiscoveredSources.value.length) loadFailure.value = reason
          else if (!silent) notify.error(reason)
        }
      } finally {
        if (isCurrentApi(context)) {
          refreshing.value = false
          resourceRequest = undefined
          if (configuration !== JSON.stringify(sources.value)) void refresh(true)
        }
      }
    })()
    return resourceRequest
  }
  /** After a change the server made on request: take its snapshot, then rediscover windows. */
  async function reload() {
    await sync()
    await refresh()
  }
  function listen() {
    stateEvents?.close()
    const session = useSessionStore()
    stateEvents = subscribeState({
      // All of it is sent again, perhaps by a restarted server with a clock of its own.
      connected() {
        listedResources.value = listedResources.value.map((listing) => ({ ...listing, readAt: 0 }))
      },
      disconnected() {
        resourcesFresh.value = false
      },
      state: (snapshot) => apply(snapshot as SharedState),
      resources: (listing) => list([listing as SourceResource]),
      account(name) {
        session.username = name
      },
      notification: (event) => void notified.trigger(event),
    })
  }
  async function load() {
    const context = apiContext()
    loadFailure.value = undefined
    try {
      await sync()
      requireCurrentApi(context)
      await refresh()
      requireCurrentApi(context)
      listen()
    } catch (reason) {
      if (isCurrentApi(context)) loadFailure.value = reason
    }
  }
  // A page coming back reads once: its event stream may not have noticed the absence yet.
  useEventListener(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh(true)
  })

  /** Forget the instance: its snapshot, windows, terminals and this browser's pending work. */
  function reset() {
    useEditsStore().suspend()
    stateEvents?.close()
    stateEvents = undefined
    closeTrustedPreview()
    clearCaptureTrust()
    clearTerminals()
    hideMobileKeyboard()
    resetContentFont()
    state.value = undefined
    sources.value = []
    canvases.value = []
    windowSizes.value = {}
    listedResources.value = []
    resourcesFresh.value = false
    resourcesLoaded.value = false
    loadFailure.value = undefined
    refreshing.value = false
    refreshedAt.value = 0
    resourceRequest = undefined
    settleListing()
  }

  return {
    state,
    sources,
    canvases,
    windowSizes,
    settings,
    systemBackgrounds,
    listedResources,
    rawResources,
    resources,
    orderedSources,
    orderedCanvases,
    sidebarOrder,
    rememberSidebarOrder,
    resourcesLoaded,
    loadFailure,
    refreshing,
    refreshedAt,
    pageVisible,
    freshStatuses,
    undiscoveredSources,
    pending,
    discovered,
    allWindows,
    placedWindows,
    indicators,
    workingSetEntries,
    workingSetIndicator,
    windowSize,
    resourceFor,
    windowCanvases,
    canvasName,
    onApplied: applied.on,
    onNotification: notified.on,
    apply,
    sync,
    refresh,
    reload,
    load,
    reset,
  }
})
