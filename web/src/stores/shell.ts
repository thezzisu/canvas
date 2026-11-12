import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import { useMediaQuery } from '@vueuse/core'
import { useOverlay } from '@nuxt/ui/composables/useOverlay'
import { apiRevision } from '../api/api'
import { useMobileLayout } from '../composables/mobile-layout'
import { useMobileViewport } from '../composables/viewport'
import { notificationSurface } from '../composables/notifications/notification-surface'
import { richPasteRequest } from '../composables/terminal/rich-paste-dialog'
import { directoryRequest } from '../composables/terminal/directories'
import { urlRequest } from '../composables/terminal/urls'
import { dismissMobileKeyboard } from '../composables/terminal/mobile-keyboard'
import { downloadPreview } from '../composables/files/downloads'
import { trustedPreviewRequest } from '../composables/files/trusted-preview'
import type { Canvas } from '../api/types'

export interface ScanTarget {
  sourceId: string
  spaceId: string
  windowId: string
  name: string
}

/** Panels and overlays around the canvas: what is open, and what that blocks. */
export const useShellStore = defineStore('shell', () => {
  const mobile = useMobileLayout()
  /** The part of the window the app may draw in, and the CSS variables that follow it. */
  const { viewport, style: viewportStyle } = useMobileViewport(mobile)
  const narrow = useMediaQuery('(max-width: 620px)')
  const { overlays, closeAll } = useOverlay()
  /** The canvas fills the browser window; set by the canvas view that owns the mode. */
  const fullscreen = ref(false)
  /** A note or file card is maximized over the workspace. */
  const cardMaximized = ref(false)
  /** The sidebar is a drawer on small screens and beside a fullscreen canvas. */
  const sidebarDrawer = computed(() => mobile.value || narrow.value || fullscreen.value)
  const sidebarOpen = ref(false)
  const connectionsOpen = ref(false)
  const accountMenuOpen = ref(false)
  const settingsOpen = ref(false)
  const accountOpen = ref(false)
  /** The window whose screen is being scanned for files and links. */
  const scanTarget = shallowRef<ScanTarget | null>(null)
  /** The canvas whose background is being edited. */
  const backgroundCanvas = shallowRef<Canvas | null>(null)
  /** Where Nuxt UI portals overlays: the mounted view's last child, so one layer stacks them. */
  const overlayRoot = shallowRef<HTMLElement>()
  function adoptOverlayRoot(element: unknown) {
    if (element instanceof HTMLElement) overlayRoot.value = element
    else if (!overlayRoot.value?.isConnected) overlayRoot.value = undefined
  }
  /** Undo notices keep their own toast slots beside the ordinary ones. */
  const pinnedToasts = ref(0)
  /** Any dialog, preview or menu surface that owns keyboard and pointer input. */
  const modalOpen = computed(
    () =>
      overlays.some((overlay) => overlay.isOpen) ||
      settingsOpen.value ||
      accountOpen.value ||
      !!scanTarget.value ||
      !!backgroundCanvas.value ||
      accountMenuOpen.value ||
      !!trustedPreviewRequest.value ||
      !!notificationSurface.value ||
      !!richPasteRequest.value ||
      !!directoryRequest.value ||
      !!urlRequest.value ||
      !!downloadPreview.value,
  )
  /** A dialog other than Settings is open; notifications shown there cannot navigate away. */
  const dialogOpen = computed(
    () =>
      overlays.some((overlay) => overlay.isOpen) ||
      accountOpen.value ||
      !!scanTarget.value ||
      !!backgroundCanvas.value,
  )

  function closePanels() {
    sidebarOpen.value = false
    connectionsOpen.value = false
  }
  watch(sidebarDrawer, (drawer) => {
    if (!drawer) sidebarOpen.value = false
  })
  watch(connectionsOpen, (open) => {
    if (open && sidebarDrawer.value) sidebarOpen.value = false
  })
  watch(modalOpen, (open) => {
    if (open) dismissMobileKeyboard()
  })
  // A different account or instance: nothing opened for the previous one stays.
  watch(apiRevision, () => {
    closePanels()
    closeAll()
    settingsOpen.value = false
    accountOpen.value = false
    scanTarget.value = null
    backgroundCanvas.value = null
    accountMenuOpen.value = false
    fullscreen.value = false
    cardMaximized.value = false
  })

  return {
    mobile,
    viewport,
    viewportStyle,
    fullscreen,
    cardMaximized,
    sidebarDrawer,
    sidebarOpen,
    connectionsOpen,
    accountMenuOpen,
    settingsOpen,
    accountOpen,
    scanTarget,
    backgroundCanvas,
    pinnedToasts,
    overlayRoot,
    adoptOverlayRoot,
    modalOpen,
    dialogOpen,
    closePanels,
  }
})
