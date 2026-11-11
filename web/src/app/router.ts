import { watch } from 'vue'
import { createRouter, createWebHashHistory, type RouteLocationRaw } from 'vue-router'
import {
  canvasPattern,
  instancePattern,
  locationQuery,
  recallLastCanvasLocation,
} from '../canvas/canvas-location'
import {
  activeInstance,
  hasActiveInstance,
  instances,
  invalidInstanceLink,
  selectInstance,
} from '../instances/instances'
import { useSessionStore } from '../stores/session'

/** Where this browser last was on an instance. */
function lastRoute(instance: string): RouteLocationRaw {
  const location = recallLastCanvasLocation(localStorage, instance)
  return {
    name: 'canvas',
    params: { instance, canvas: location.canvas },
    query: locationQuery(location),
  }
}
const known = (id: unknown): id is string =>
  typeof id === 'string' && instances.value.some((instance) => instance.id === id)

/**
 * The address names a saved instance and one of its canvases; the camera rides in the
 * query. Signing in is a state of the instance, not a page, so it has no route.
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('../views/SignInView.vue'),
      beforeEnter: () => (hasActiveInstance.value ? lastRoute(activeInstance.value.id) : true),
    },
    {
      path: `/i/:instance(${instancePattern})`,
      name: 'instance',
      redirect: (to) => lastRoute(String(to.params.instance)),
    },
    {
      path: `/i/:instance(${instancePattern})/:canvas(${canvasPattern})`,
      name: 'canvas',
      component: () => import('../views/WorkspaceView.vue'),
    },
    { path: '/:unmatched(.*)*', redirect: '/' },
  ],
})

/** Keep the active instance and the address in step, and check each instance once chosen. */
export function followInstance() {
  const session = useSessionStore()
  router.beforeEach(async (to, from) => {
    // An address for an instance this browser does not know signs nothing in or out,
    // but the work on the current one must be stored before it is put away.
    if (
      to.params.instance &&
      !known(to.params.instance) &&
      to.params.instance !== from.params.instance
    )
      return session.canLeave()
  })
  router.afterEach((to) => {
    const id = to.params.instance
    const wasUnknown = !!session.unknownInstance
    session.unknownInstance = id && !known(id) ? String(id) : undefined
    if (session.unknownInstance) session.suspend()
    else if (known(id) && id !== activeInstance.value.id) selectInstance(id)
    else if (wasUnknown) void session.activate()
  })
  watch(
    () => `${activeInstance.value.id}:${activeInstance.value.base}`,
    () => {
      const id = activeInstance.value.id
      if (router.currentRoute.value.params.instance !== id)
        void router.push(hasActiveInstance.value ? lastRoute(id) : { name: 'home' })
      void session.activate()
    },
    { flush: 'sync' },
  )
  return router.isReady().then(() => {
    if (session.unknownInstance || invalidInstanceLink) session.suspend()
    else if (
      router.currentRoute.value.params.instance === activeInstance.value.id ||
      !hasActiveInstance.value
    )
      void session.activate()
  })
}
