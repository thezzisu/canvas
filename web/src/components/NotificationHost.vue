<script setup lang="ts">
import { computed, watchPostEffect } from 'vue'
import { useEventListener } from '@vueuse/core'
import { notificationPortal, notificationSurface } from '../notification-surface'

const props = defineProps<{ portal?: HTMLElement }>()
const target = computed(() => notificationSurface.value || props.portal || document.body)
function show() {
  const host = notificationPortal.value
  if (host?.isConnected && !host.matches(':popover-open')) host.showPopover()
}
watchPostEffect(() => { void target.value; show() })
useEventListener(document, 'fullscreenchange', () => { notificationPortal.value?.hidePopover(); show() })
</script>

<template>
  <Teleport :to="target"><div ref="notificationPortal" popover="manual" aria-live="off" class="canvas-notification-host" /></Teleport>
</template>

<style>
/* The browser's top layer escapes modal transforms and clipping without
   moving notifications outside the modal's DOM and keyboard focus scope. */
.canvas-notification-host{position:fixed;inset:calc(var(--mobile-top,0px) + var(--mobile-height,var(--ui-viewport-height)) - max(12px,var(--mobile-safe-bottom,var(--ui-safe-bottom)))) max(12px,var(--ui-safe-right)) auto auto;margin:0;padding:0;border:0;background:transparent;width:min(384px,calc(var(--mobile-width,var(--ui-viewport-width)) - 24px));height:0;overflow:visible;color:inherit}
.canvas-notification-host .canvas-notifications{position:absolute;inset:auto 0 0;width:100%;max-width:none}
</style>
