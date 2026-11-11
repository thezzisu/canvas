import { computed, shallowRef, watch } from 'vue'
import { isNavigationFailure, NavigationFailureType, useRoute, useRouter } from 'vue-router'
import {
  locationQuery,
  parseLocation,
  recallCanvasLocation,
  rememberCanvasLocation,
  type CanvasLocation,
} from '../canvas-location'
import type { CanvasTarget } from '../canvas-jump'
import { useWorkspaceStore } from '../../stores/workspace'

/** A navigation that arrived from outside the camera: a link, history or `visit`. The
 * view applies it once the canvas has its nodes, then reports the camera it settled on. */
export type CanvasRequest = { location: CanvasLocation; revision: number } & Partial<CanvasTarget>

export function useCanvasRoute() {
  const route = useRoute(),
    router = useRouter(),
    workspace = useWorkspaceStore()
  const instanceId = computed(() => String(route.params.instance))
  const canvasId = computed(() => String(route.params.canvas))
  const request = shallowRef<CanvasRequest>()
  /** Explicit target of the navigation in flight; `visit` sets it before the route moves. */
  let target: CanvasTarget | undefined
  /** Routes this view wrote itself while following the camera; they are not requests. */
  const written = new Set<string>()
  let revision = 0

  const toRoute = (location: CanvasLocation) => ({
    name: 'canvas' as const,
    params: { instance: location.instance, canvas: location.canvas },
    query: locationQuery(location),
  })
  function stage() {
    const location = parseLocation(instanceId.value, canvasId.value, route.query)
    request.value = location && { location, revision: ++revision, ...target }
    target = undefined
    written.clear()
  }
  stage()
  watch(
    () => route.fullPath,
    (path) => {
      if (!written.delete(path)) stage()
    },
    { flush: 'sync' },
  )

  /** A background tab follows its own address but never overwrites the remembered view. */
  function write(location: CanvasLocation, remember = workspace.pageVisible) {
    if (remember) rememberCanvasLocation(localStorage, location)
    const next = toRoute(location),
      path = router.resolve(next).fullPath
    if (path === route.fullPath) return
    written.add(path)
    void router.replace(next)
  }

  return {
    instanceId,
    canvasId,
    request,
    /** The view the address names right now. */
    current: () => parseLocation(instanceId.value, canvasId.value, route.query),
    /** The target of a navigation that has not committed yet, for its leave guard. */
    pendingTarget: () => target,
    /** Open a canvas at its remembered view, or at an explicit target. */
    async visit(canvas: string, next?: CanvasTarget) {
      const instance = instanceId.value
      const location = (!next && recallCanvasLocation(localStorage, instance, canvas)) || {
        instance,
        canvas,
      }
      target = next
      const failure = await router.push(toRoute(location))
      // The same address again still applies its target, such as fitting one node.
      if (isNavigationFailure(failure, NavigationFailureType.duplicated)) stage()
      else if (failure) target = undefined
    },
    /** Follow the camera in the address bar; ignored while a request is being applied. */
    save(location: CanvasLocation, remember?: boolean) {
      if (request.value || location.instance !== instanceId.value) return false
      write(location, remember)
      return true
    },
    /** The request reached its camera: the address now names where the view actually is. */
    restored(applied: CanvasRequest | undefined, actual: CanvasLocation) {
      if (request.value !== applied || actual.instance !== instanceId.value) return false
      request.value = undefined
      write(actual)
      return true
    },
  }
}
export type CanvasRoute = ReturnType<typeof useCanvasRoute>
