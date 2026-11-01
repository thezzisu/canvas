import { shallowRef } from 'vue'
import { createSharedComposable, useActiveElement, useEventListener } from '@vueuse/core'

// xterm updates many DOM rows. Observe document focus/removal once for the app,
// rather than giving every terminal its own document-wide mutation observer.
export const useDocumentFocus = createSharedComposable(() => {
  const activeElement = useActiveElement({ triggerOnRemoval: true })
  const windowFocused = shallowRef(document.hasFocus())
  // Moving into a PDF frame blurs the parent window without leaving the document.
  const refresh = () => { windowFocused.value = document.hasFocus() }
  useEventListener(window, ['focus', 'blur'], refresh)
  useEventListener(document, 'visibilitychange', refresh)
  return { activeElement, windowFocused }
})
