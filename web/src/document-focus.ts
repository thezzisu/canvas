import { createSharedComposable, useActiveElement, useEventListener, useWindowFocus } from '@vueuse/core'

// xterm updates many DOM rows. Observe document focus/removal once for the app,
// rather than giving every terminal its own document-wide mutation observer.
export const useDocumentFocus = createSharedComposable(() => {
  const activeElement = useActiveElement({ triggerOnRemoval: true })
  // The parent gets a window blur, not a focus event on the iframe element.
  useEventListener(window, 'blur', () => {
    if (document.activeElement instanceof HTMLIFrameElement) activeElement.value = document.activeElement
  })
  return { activeElement, windowFocused: useWindowFocus() }
})
