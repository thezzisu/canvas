<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import UPopover from '@nuxt/ui/components/Popover.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import type { GlobalSettings } from '../../../shared/settings'
import { copyText } from '../clipboard'
import { collectViewportDiagnostics } from '../viewport-diagnostics'
import { viewportFit, interactiveWidget, viewportReloadRequired } from '../developer-mode'
import Icon from './Icon.vue'

const props = defineProps<{ settings?: GlobalSettings | null; portal?: HTMLElement; reloadBlocked?: boolean }>()
const { t } = useI18n()
const open = ref(false)
const toolbar = ref<HTMLElement>()
const panel = ref<HTMLElement>()
const bounds = ref<HTMLElement>()
const boundsVisible = ref(false)
const boundsSupported = typeof HTMLElement.prototype.showPopover === 'function'
const feedback = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
function preserveTerminalFocus(event: Event) {
  if (document.activeElement?.matches('.terminal-mobile-input, .xterm-helper-textarea')) event.preventDefault()
}
const popoverContent = computed(() => ({ align: 'end' as const, collisionPadding: 8,
  onOpenAutoFocus: preserveTerminalFocus, onCloseAutoFocus: preserveTerminalFocus,
  'aria-label': t('settings.developerAdvanced'),
}))
watch(open, (value, _, cleanup) => {
  if (!value) return
  // Pointer use keeps the terminal focused; Escape belongs to the open popover.
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopImmediatePropagation(); open.value = false
  }
  // Terminal touch gestures intentionally suppress the click Reka waits for.
  const outside = (event: PointerEvent) => {
    const target = event.target
    if (target instanceof Node && !toolbar.value?.contains(target) && !panel.value?.contains(target)) open.value = false
  }
  window.addEventListener('keydown', escape, true)
  window.addEventListener('pointerdown', outside, true)
  cleanup(() => {
    window.removeEventListener('keydown', escape, true)
    window.removeEventListener('pointerdown', outside, true)
  })
})
function copy() {
  const snapshot = collectViewportDiagnostics(props.settings)
  const failed = () => { feedback.value = 'failed' }
  if (copyText(JSON.stringify(snapshot, null, 2), failed)) feedback.value = 'copied'
  clearTimeout(timer)
  timer = setTimeout(() => { feedback.value = '' }, 2000)
}
function reloadPage() { if (!props.reloadBlocked) window.location.reload() }
function syncBounds() { boundsVisible.value = bounds.value?.matches(':popover-open') === true }
function toggleBounds() {
  if (!boundsSupported || !bounds.value) return
  if (boundsVisible.value) bounds.value.hidePopover()
  else bounds.value.showPopover()
  syncBounds()
}
function hideBounds() { if (boundsVisible.value) bounds.value?.hidePopover(); boundsVisible.value = false }
function visibilityChanged() { if (document.hidden) hideBounds() }
onMounted(() => {
  document.addEventListener('fullscreenchange', hideBounds)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
  clearTimeout(timer); hideBounds()
  document.removeEventListener('fullscreenchange', hideBounds)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<template>
  <div ref="toolbar" class="debug-toolbar" @pointerdown.stop @click.stop>
    <button class="viewport-diagnostics" type="button" :aria-label="t('terminal.copyDiagnostics')" @pointerdown.prevent @click="copy"><span :style="{ visibility: feedback ? 'hidden' : undefined }">{{ t('terminal.copyDiagnostics') }}</span><span v-if="feedback" class="debug-copy-feedback" aria-live="polite">{{ t(`terminal.clipboard.${feedback}`) }}</span></button>
    <UPopover v-model:open="open" :modal="false" :portal="portal || false"
      :content="popoverContent"
      :ui="{ content: 'debug-settings-popover' }">
      <UButton type="button" color="neutral" variant="ghost" class="debug-settings-trigger" :aria-label="t('settings.adjustAdvanced')" :title="t('settings.adjustAdvanced')" @pointerdown.prevent><Icon name="settings" :size="15" /></UButton>
      <template #content>
        <div ref="panel" class="debug-settings" @pointerdown.prevent @click.stop>
          <div class="debug-setting" role="group" aria-label="viewport-fit">
            <code>viewport-fit</code>
            <div class="debug-setting-options"><UButton v-for="value in (['cover', 'contain'] as const)" :key="value" type="button" color="neutral" :variant="viewportFit === value ? 'solid' : 'outline'" :aria-pressed="viewportFit === value" @click="viewportFit = value">{{ value }}</UButton></div>
          </div>
          <div class="debug-setting" role="group" aria-label="interactive-widget">
            <code>interactive-widget</code>
            <div class="debug-setting-options debug-widget-options"><UButton v-for="value in (['resizes-content', 'resizes-visual', 'overlays-content'] as const)" :key="value" type="button" color="neutral" :variant="interactiveWidget === value ? 'solid' : 'outline'" :aria-pressed="interactiveWidget === value" @click="interactiveWidget = value">{{ value }}</UButton></div>
          </div>
          <div class="debug-reload-row">
            <span v-if="viewportReloadRequired" role="status">{{ t('settings.reloadRequired') }}</span>
            <UButton type="button" color="neutral" variant="outline" size="sm" class="debug-reload" :disabled="reloadBlocked" @click="reloadPage">{{ t('settings.reload') }}</UButton>
          </div>
          <UButton type="button" color="neutral" variant="outline" size="sm" class="debug-reload debug-bounds-toggle" :aria-pressed="boundsVisible" :disabled="!boundsSupported" @click="toggleBounds">Viewport bounds</UButton>
        </div>
      </template>
    </UPopover>
  </div>
  <div ref="bounds" class="viewport-bounds-probe" popover="manual" aria-hidden="true" @toggle="syncBounds" />
</template>

<style scoped>
.debug-toolbar{position:fixed;top:calc(max(8px,var(--mobile-safe-top,var(--ui-safe-top))) + 44px);left:50%;transform:translateX(-50%);z-index:120;display:flex;max-width:calc(var(--mobile-width,var(--ui-viewport-width)) - 16px);border:1px solid #46505b;border-radius:6px;background:#23272ef2;color:#c6ced8;font-size:11px;box-shadow:0 3px 12px #0003}
.viewport-diagnostics{position:relative;min-height:32px;padding:4px 10px;white-space:nowrap}
.debug-copy-feedback{position:absolute;inset:0;display:grid;place-items:center}
.debug-settings-trigger{display:flex;align-items:center;justify-content:center;flex:0 0 32px;width:32px;min-height:32px;padding:0;border:0;border-left:1px solid #46505b;border-radius:0 5px 5px 0;color:#9ba8b9;background:transparent}
.viewport-diagnostics:hover,.debug-settings-trigger:hover,.debug-settings-trigger[data-state=open]{background:#ffffff08;color:#e1e7ef}
.debug-settings{display:grid;gap:14px;padding:12px}
.debug-setting{display:grid;gap:8px}
.debug-setting>code{font-size:11px;color:#929fb0}
.debug-setting-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}
.debug-widget-options{grid-template-columns:minmax(0,1fr)}
.debug-setting-options button{justify-content:center;min-height:36px;padding:6px 4px;border:1px solid #414b59;border-radius:5px;background:#1c222a;color:#aeb9c9;font-size:11px;white-space:nowrap}
.debug-setting-options button[aria-pressed=true]{border-color:#a78770;background:#e9b18812;color:#e9c9b0}
.debug-setting-options button:hover{background:#ffffff08}
.debug-reload-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.debug-reload-row>span{color:#ac9988;font-size:11px}
.debug-reload{justify-content:center;min-height:36px;padding:0 10px;border:1px solid #414b59;border-radius:5px;background:#1c222a;color:#aeb9c9;font-size:11px}
.debug-reload:hover{background:#ffffff08;color:#e1e7ef}
.debug-bounds-toggle{justify-self:start}
.debug-bounds-toggle[aria-pressed=true]{border-color:#a78770;background:#e9b18812;color:#e9c9b0}
/* Native top layer escapes ancestor clipping. Eight pixels inside the CSS
   viewport are the positive control; the remaining stripe tests its boundary. */
.viewport-bounds-probe{zoom:calc(1 / var(--ui-zoom));position:fixed;inset:calc(100dvh - 8px) auto auto 0;width:100dvw;height:72px;max-width:none;max-height:none;margin:0;padding:0;border:0;pointer-events:none;background:repeating-linear-gradient(135deg,#00e5ff 0 8px,#ff2da4 8px 16px);box-shadow:none;overflow:clip}
.viewport-bounds-probe::before{content:'';position:absolute;top:7px;left:0;right:0;height:2px;background:#fff}
.viewport-bounds-probe::backdrop{display:none}
.mobile-layout .debug-toolbar>button,.mobile-layout .debug-settings-trigger{min-height:40px}
.mobile-layout .debug-settings-trigger{width:40px;flex-basis:40px}
.mobile-layout .debug-setting-options button,.mobile-layout .debug-reload{min-height:44px}
</style>
