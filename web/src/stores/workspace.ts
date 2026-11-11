import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { createEventHook, useDocumentVisibility, useIntervalFn, useNow } from '@vueuse/core'
import { api, apiContext, apiRevision, isCurrentApi, requireCurrentApi } from '../api/api'
import { subscribeState } from '../api/state-events'
import { t } from '../app/i18n'
import { notify } from '../lib/notify'
import { agentIndicator, canvasIndicators } from '../workspace/canvas-status'
import {
  focusedCompletionStatus,
  projectFocusedResources,
  type FocusedStatus,
} from '../workspace/completion-focus'
import { mergeLiveResources } from '../workspace/live-resources'
import { orderedItems, useSidebarOrder } from '../workspace/sidebar-order'
import { workingSet } from '../workspace/working-set'
import { retainBackgrounds } from '../workspace/backgrounds'
import { applyComposers } from '../terminal/composers'
import { clearCaptureTrust } from '../terminal/capture-trust'
import { hideMobileKeyboard } from '../terminal/mobile-keyboard'
import {
  acknowledgeTerminalMetadata,
  clearTerminals,
  hasLiveTerminal,
  liveTerminalMetadata,
  retainTerminalMetadata,
  terminalReadFocus,
} from '../terminal/terminals'
import { closeTrustedPreview } from '../files/trusted-preview'
import { applyContentFont, resetContentFont } from '../settings/content-font'
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
    runtime: source.runtime || 'tui',
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
  const overviewBackground = computed(() => state.value?.overviewBackground ?? null)

  const polledResources = ref<SourceResource[]>([])
  const rawResources = computed(() =>
    mergeLiveResources(polledResources.value, liveTerminalMetadata.value),
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
  /** Attention animates only from a current poll on a visible page. */
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
      polledResources.value = polledResources.value.filter(
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

  /** Discover native windows. A silent refresh joins one in flight and reports nothing. */
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
    const metadataAtStart = liveTerminalMetadata.value
    resourceRequest = (async () => {
      try {
        const body = await api<{ sources: SourceResource[] }>('/api/resources')
        if (configuration !== JSON.stringify(sources.value)) return
        // An unreachable source keeps the windows whose terminals are still connected.
        const discoveredSources = body.sources.map((source) =>
          source.error
            ? {
                ...source,
                spaces: (
                  resources.value.find((previous) => previous.id === source.id)?.spaces || []
                ).flatMap((space) => {
                  const windows = space.windows.filter((window) =>
                    hasLiveTerminal(source.id, window.id),
                  )
                  return windows.length ? [{ ...space, windows }] : []
                }),
              }
            : source,
        )
        resourcesFresh.value = true
        resourcesLoaded.value = true
        loadFailure.value = undefined
        polledResources.value = discoveredSources
        acknowledgeTerminalMetadata(metadataAtStart, discoveredSources)
        refreshedAt.value = Date.now()
      } catch (reason) {
        if (isCurrentApi(context)) {
          resourcesFresh.value = false
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
    stateEvents = subscribeState(
      (snapshot) => apply(snapshot as SharedState),
      (name) => {
        session.username = name
      },
      (event) => void notified.trigger(event),
    )
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
  useIntervalFn(() => {
    if (pageVisible.value) void refresh(true)
  }, 2000)
  watch(pageVisible, (visible) => {
    if (visible) void refresh(true)
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
    polledResources.value = []
    resourcesFresh.value = false
    resourcesLoaded.value = false
    loadFailure.value = undefined
    refreshing.value = false
    refreshedAt.value = 0
    resourceRequest = undefined
  }

  return {
    state,
    sources,
    canvases,
    windowSizes,
    settings,
    overviewBackground,
    polledResources,
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
