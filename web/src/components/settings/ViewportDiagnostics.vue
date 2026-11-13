<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UFieldGroup from '@nuxt/ui/components/FieldGroup.vue'
import type { GlobalSettings } from '../../../../shared/settings'
import { copyText } from '../../utils/clipboard'
import { collectViewportDiagnostics } from '../../composables/settings/viewport-diagnostics'
import {
  viewportFit,
  interactiveWidget,
  viewportReloadRequired,
} from '../../composables/developer-mode'
import { useMobileLayout } from '../../composables/mobile-layout'

const props = defineProps<{ settings?: GlobalSettings | null; reloadBlocked?: boolean }>()
const { t } = useI18n()
const open = ref(false)
const toolbar = ref<{ $el: HTMLElement }>()
const touch = useMobileLayout()
const panel = ref<HTMLElement>()
const bounds = ref<HTMLElement>()
const boundsVisible = ref(false)
const boundsSupported = typeof HTMLElement.prototype.showPopover === 'function'
function preserveTerminalFocus(event: Event) {
  if (document.activeElement?.matches('.terminal-mobile-input, .terminal-desktop-input'))
    event.preventDefault()
}
const popoverContent = computed(() => ({
  align: 'end' as const,
  collisionPadding: 8,
  onOpenAutoFocus: preserveTerminalFocus,
  onCloseAutoFocus: preserveTerminalFocus,
  'aria-label': t('settings.developerAdvanced'),
}))
watch(open, (value, _, cleanup) => {
  if (!value) return
  // Pointer use keeps the terminal focused; Escape belongs to the open popover.
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    open.value = false
  }
  // Terminal touch gestures intentionally suppress the click Reka waits for.
  const outside = (event: PointerEvent) => {
    const target = event.target
    if (
      target instanceof Node &&
      !toolbar.value?.$el.contains(target) &&
      !panel.value?.contains(target)
    )
      open.value = false
  }
  window.addEventListener('keydown', escape, true)
  window.addEventListener('pointerdown', outside, true)
  cleanup(() => {
    window.removeEventListener('keydown', escape, true)
    window.removeEventListener('pointerdown', outside, true)
  })
})
function copy() {
  void copyText(JSON.stringify(collectViewportDiagnostics(props.settings), null, 2))
}
function reloadPage() {
  if (!props.reloadBlocked) window.location.reload()
}
function syncBounds() {
  boundsVisible.value = bounds.value?.matches(':popover-open') === true
}
function toggleBounds() {
  if (!boundsSupported || !bounds.value) return
  if (boundsVisible.value) bounds.value.hidePopover()
  else bounds.value.showPopover()
  syncBounds()
}
function hideBounds() {
  if (boundsVisible.value) bounds.value?.hidePopover()
  boundsVisible.value = false
}
function visibilityChanged() {
  if (document.hidden) hideBounds()
}
onMounted(() => {
  document.addEventListener('fullscreenchange', hideBounds)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
  hideBounds()
  document.removeEventListener('fullscreenchange', hideBounds)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <UFieldGroup
    ref="toolbar"
    :size="touch ? 'xl' : 'sm'"
    class="debug-toolbar"
    @pointerdown.stop
    @click.stop
  >
    <UButton
      color="neutral"
      variant="outline"
      class="viewport-diagnostics"
      :label="t('terminal.copyDiagnostics')"
      @pointerdown.prevent
      @click="copy"
    />
    <UPopover
      v-model:open="open"
      :modal="false"
      :content="popoverContent"
      :ui="{
        content:
          'debug-settings-popover w-[264px] max-w-[calc(var(--mobile-width,var(--ui-viewport-width))-16px)] max-h-(--reka-popover-content-available-height) overflow-auto overscroll-contain',
      }"
    >
      <UButton
        color="neutral"
        variant="outline"
        square
        icon="i-lucide-settings"
        class="debug-settings-trigger"
        :active="open"
        :aria-label="t('settings.adjustAdvanced')"
        :title="t('settings.adjustAdvanced')"
        @pointerdown.prevent
      />
      <template #content>
        <div ref="panel" class="debug-settings grid gap-3.5 p-3" @pointerdown.prevent @click.stop>
          <div class="grid gap-2" role="group" aria-label="viewport-fit">
            <code class="text-xs text-muted">viewport-fit</code>
            <!-- Buttons, not tabs: the panel cancels pointerdown to keep the terminal focused. -->
            <UFieldGroup :size="touch ? 'xl' : 'sm'" class="w-full">
              <UButton
                v-for="value in ['cover', 'contain'] as const"
                :key="value"
                color="neutral"
                variant="outline"
                active-color="primary"
                active-variant="subtle"
                class="flex-1 justify-center"
                :label="value"
                :active="viewportFit === value"
                :aria-pressed="viewportFit === value"
                @click="viewportFit = value"
              />
            </UFieldGroup>
          </div>
          <div class="grid gap-2" role="group" aria-label="interactive-widget">
            <code class="text-xs text-muted">interactive-widget</code>
            <UFieldGroup :size="touch ? 'xl' : 'sm'" orientation="vertical" class="w-full">
              <UButton
                v-for="value in ['resizes-content', 'resizes-visual', 'overlays-content'] as const"
                :key="value"
                color="neutral"
                variant="outline"
                active-color="primary"
                active-variant="subtle"
                class="justify-center"
                :label="value"
                :active="interactiveWidget === value"
                :aria-pressed="interactiveWidget === value"
                @click="interactiveWidget = value"
              />
            </UFieldGroup>
          </div>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span v-if="viewportReloadRequired" class="text-xs text-warning" role="status">{{
              t('settings.reloadRequired')
            }}</span>
            <UButton
              color="neutral"
              variant="outline"
              :size="touch ? 'xl' : 'sm'"
              class="debug-reload"
              :disabled="reloadBlocked"
              @click="reloadPage"
              >{{ t('settings.reload') }}</UButton
            >
          </div>
          <UButton
            color="neutral"
            variant="outline"
            active-color="primary"
            active-variant="subtle"
            :size="touch ? 'xl' : 'sm'"
            class="debug-bounds-toggle justify-self-start"
            :active="boundsVisible"
            :aria-pressed="boundsVisible"
            :disabled="!boundsSupported"
            @click="toggleBounds"
            >Viewport bounds</UButton
          >
        </div>
      </template>
    </UPopover>
  </UFieldGroup>
  <div
    ref="bounds"
    class="viewport-bounds-probe"
    popover="manual"
    aria-hidden="true"
    @toggle="syncBounds"
  />
</template>

<style scoped>
.debug-toolbar {
  position: fixed;
  top: calc(max(8px, var(--mobile-safe-top, var(--ui-safe-top))) + 44px);
  left: 50%;
  transform: translateX(-50%);
  max-width: calc(var(--mobile-width, var(--ui-viewport-width)) - 16px);
}
/* Native top layer escapes ancestor clipping. Eight pixels inside the CSS
   viewport are the positive control; the remaining stripe tests its boundary. */
.viewport-bounds-probe {
  zoom: calc(1 / var(--ui-zoom));
  position: fixed;
  inset: calc(100dvh - 8px) auto auto 0;
  width: 100dvw;
  height: 72px;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  pointer-events: none;
  background: repeating-linear-gradient(135deg, #00e5ff 0 8px, #ff2da4 8px 16px);
  box-shadow: none;
  overflow: clip;
}
.viewport-bounds-probe::before {
  content: '';
  position: absolute;
  top: 7px;
  left: 0;
  right: 0;
  height: 2px;
  background: #fff;
}
.viewport-bounds-probe::backdrop {
  display: none;
}
</style>
