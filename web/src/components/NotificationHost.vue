<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { notificationPortal, notificationSurface } from '../notification-surface'

const props = defineProps<{ portal?: HTMLElement }>()
const target = computed(() => notificationSurface.value || props.portal || document.body)
let host: HTMLElement | undefined
function show() {
  if (host?.isConnected && !host.matches(':popover-open')) host.showPopover()
}
function relocate() {
  const parent = target.value as HTMLElement & { moveBefore?(node: Node, child: Node | null): void }
  if (!host || !parent.isConnected) return
  if (host.parentElement !== parent) {
    // Reparent the empty portal without restarting descendant animations,
    // focus or popover state. Nuxt UI still owns the toasts and their timers.
    if (host.isConnected && parent.moveBefore) {
      // Initialize a newly mounted modal's CSS animation before adopting the
      // popover; otherwise Chromium restarts its descendants' animations.
      parent.getAnimations()
      parent.moveBefore(host, null)
    } else parent.appendChild(host)
  }
  show()
}
watch(target, relocate, { flush: 'sync' })
onMounted(() => {
  host = document.createElement('div')
  host.className = 'canvas-notification-host'
  host.popover = 'manual'; host.setAttribute('aria-live', 'off')
  relocate(); notificationPortal.value = host
})
onBeforeUnmount(() => {
  if (notificationPortal.value === host) notificationPortal.value = undefined
  host?.remove()
})
useEventListener(document, 'fullscreenchange', () => { host?.hidePopover(); show() })
</script>

<template><span hidden /></template>

<style>
/* The browser's top layer escapes modal transforms and clipping without
   moving notifications outside the modal's DOM and keyboard focus scope. */
.canvas-notification-host{position:fixed;inset:calc(var(--mobile-top,0px) + var(--mobile-height,var(--ui-viewport-height)) - var(--mobile-keyboard-inset,0px) - max(12px,var(--mobile-safe-bottom,var(--ui-safe-bottom)))) max(12px,var(--ui-safe-right)) auto auto;margin:0;padding:0;border:0;background:transparent;width:min(384px,calc(var(--mobile-width,var(--ui-viewport-width)) - 24px));height:0;overflow:visible;color:inherit}
.canvas-notification-host .canvas-notifications{position:absolute;inset:auto 0 0;width:100%;max-width:none}
</style>
