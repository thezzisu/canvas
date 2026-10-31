import { createSharedComposable, useActiveElement, useWindowFocus } from '@vueuse/core'

// xterm updates many DOM rows. Observe document focus/removal once for the app,
// rather than giving every terminal its own document-wide mutation observer.
export const useDocumentFocus = createSharedComposable(() => ({
  activeElement: useActiveElement({ triggerOnRemoval: true }),
  windowFocused: useWindowFocus(),
}))
