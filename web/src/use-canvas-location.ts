import { onScopeDispose, shallowRef, type Ref } from 'vue'
import {
  bindCanvasHistory,
  recallCanvasLocation,
  recallLastCanvasLocation,
  rememberCanvasLocation,
  type CanvasLocation,
  type Feature,
  type WorkspaceLocation,
} from './canvas-location'

/** The screen position of a window's top-left corner that a canvas jump keeps fixed. */
export interface CanvasAnchor {
  sourceId: string
  windowId: string
  x: number
  y: number
  zoom: number
}
/** Explicit targets bypass the saved camera: fit all/one, or retain a window's screen position. */
export type CanvasTarget =
  | { fitNodeId: string; anchor?: never; fitAll?: never }
  | { anchor: CanvasAnchor; fitNodeId?: never; fitAll?: never }
  | { fitAll: true; anchor?: never; fitNodeId?: never }
export type CanvasNavigation = {
  location: WorkspaceLocation
  revision: number
} & Partial<CanvasTarget>
interface Options {
  instanceId: Readonly<Ref<string>>
  hasInstance(id: string): boolean
  selectInstance(id: string): void
  canRemember?(): boolean
}

/** App applies a request only after that instance's authenticated state and nodes are ready. */
export function useCanvasLocation(options: Options) {
  const requested = shallowRef<CanvasNavigation>()
  const unknownInstance = shallowRef<string>()
  let revision = 0,
    initial = true
  const stage = (location: WorkspaceLocation | undefined, target?: CanvasTarget) => {
    requested.value = location ? { location, revision: ++revision, ...target } : undefined
    unknownInstance.value =
      location && !options.hasInstance(location.instance) ? location.instance : undefined
    if (location && !unknownInstance.value && location.instance !== options.instanceId.value)
      options.selectInstance(location.instance)
  }
  const history = bindCanvasHistory(window, stage)
  onScopeDispose(history.dispose)
  const remember = (location: WorkspaceLocation) => {
    if (options.canRemember?.() !== false) rememberCanvasLocation(localStorage, location)
  }
  return {
    requested,
    unknownInstance,
    // Call before the initial session request, while the instance watcher is still gated.
    read() {
      if (initial && !window.location.hash) {
        const last = recallLastCanvasLocation(localStorage, options.instanceId.value)
        if (last && options.hasInstance(last.instance)) {
          history.write(last, 'replace')
          stage(last)
        }
      }
      initial = false
      history.read()
    },
    saved: (instance: string, canvas: string) =>
      recallCanvasLocation(localStorage, instance, canvas),
    visit(instance: string, canvas?: string, target?: CanvasTarget) {
      if (!options.hasInstance(instance)) return false
      const location = target
        ? { instance, canvas: canvas || 'overview' }
        : canvas
          ? recallCanvasLocation(localStorage, instance, canvas) || { instance, canvas }
          : recallLastCanvasLocation(localStorage, instance) || { instance, canvas: 'overview' }
      history.write(location, 'push')
      stage(location, target)
      return true
    },
    openFeature(instance: string, feature: Feature) {
      if (!options.hasInstance(instance)) return false
      const location = { instance, feature }
      history.write(location, 'push')
      stage(location)
      return true
    },
    fallback(instance: string) {
      const location: CanvasLocation = { instance, canvas: 'overview' }
      history.write(location, 'replace')
      stage(location)
    },
    save(location: WorkspaceLocation) {
      if (
        requested.value ||
        unknownInstance.value ||
        location.instance !== options.instanceId.value
      )
        return false
      remember(location)
      history.write(location, 'replace')
      return true
    },
    cancel(actual: WorkspaceLocation) {
      requested.value = undefined
      unknownInstance.value = undefined
      remember(actual)
      history.write(actual, 'replace')
    },
    restored(request: CanvasNavigation | undefined, actual: WorkspaceLocation) {
      if (
        requested.value !== request ||
        unknownInstance.value ||
        actual.instance !== options.instanceId.value ||
        (request && request.location.instance !== actual.instance)
      )
        return false
      requested.value = undefined
      remember(actual)
      history.write(actual, 'replace')
      return true
    },
  }
}
