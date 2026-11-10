<script setup lang="ts">
import { computed, ref, shallowRef, toRef, useId, watch, onBeforeUnmount } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UContextMenu, { type ContextMenuItem } from '@nuxt/ui/components/ContextMenu.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { useToast } from '@nuxt/ui/composables/useToast'
import UModal from './CanvasModal.vue'
import { usePointerDismiss } from '../pointer-dismiss'
import { apiContext, isCurrentApi } from '../api'
import type { PaneAction, PaneContext } from '../../../shared/pane-context'

const props = defineProps<{ host?: HTMLElement; enabled: boolean;
  allowsMenu(): boolean;
  lookup(x: number, y: number, signal: AbortSignal): Promise<PaneContext | null>;
  action(pane: PaneContext, command: PaneAction): Promise<void> }>()
const { t } = useI18n(), toast = useToast(), form = useId()
const open = ref(false), loading = ref(false), failed = ref(false), busy = ref(false)
const pane = shallowRef<PaneContext>(), menu = shallowRef<HTMLElement>()
const point = ref({ x: 0, y: 0 }), name = ref(''), error = ref('')
const dialog = shallowRef<{ kind: 'rename' | 'close'; pane: PaneContext }>()
const dismiss = usePointerDismiss(open, menu)
let request: AbortController | undefined
let mounted = true
let revision = 0

async function lookup() {
  request?.abort()
  const current = request = new AbortController()
  pane.value = undefined; loading.value = true; failed.value = false
  try {
    const target = await props.lookup(point.value.x, point.value.y, current.signal)
    if (current.signal.aborted) return
    if (target) pane.value = target
    else open.value = false
  } catch { if (!current.signal.aborted) failed.value = true }
  finally { if (request === current) loading.value = false }
}
function show(event: MouseEvent) {
  if (!props.enabled) return
  event.preventDefault(); event.stopImmediatePropagation()
  if (!props.allowsMenu()) return
  if (busy.value) return
  point.value = { x: event.clientX, y: event.clientY }
  open.value = true
  void lookup()
}
useEventListener(toRef(props, 'host'), 'contextmenu', show, { capture: true })
watch(open, value => { if (!value) request?.abort() })
watch([() => props.enabled, () => props.host], ([enabled, host], [, previousHost]) => {
  if (!enabled || host !== previousHost) { revision++; open.value = false; dialog.value = undefined }
})
onBeforeUnmount(() => { mounted = false; request?.abort() })

function edit(kind: 'rename' | 'close') {
  if (!pane.value || busy.value) return
  dialog.value = { kind, pane: { ...pane.value } }
  name.value = pane.value.name; error.value = ''
}
async function perform(target: PaneContext, command: PaneAction) {
  if (busy.value) return
  const context = apiContext(), currentDialog = dialog.value, currentRevision = revision
  const current = () => mounted && props.enabled && revision === currentRevision && isCurrentApi(context) && dialog.value === currentDialog
  busy.value = true; error.value = ''
  try { await props.action(target, command); if (current()) dialog.value = undefined }
  catch (reason) {
    if (!current()) return
    const message = reason instanceof Error ? reason.message : t('terminal.paneMenu.failed')
    if (dialog.value) error.value = message
    else toast.add({ title: t('terminal.paneMenu.failed'), description: message, color: 'error' })
  } finally { if (mounted) busy.value = false }
}
function submit() {
  if (dialog.value) void perform(dialog.value.pane, dialog.value.kind === 'rename' ? { action: 'rename', name: name.value } : { action: 'close' })
}
const items = computed<ContextMenuItem[]>(() => loading.value || busy.value ? [{ label: t('common.loading'), icon: 'i-lucide-loader-circle', disabled: true }]
  : failed.value ? [{ label: t('terminal.paneMenu.unavailable'), disabled: true }, { label: t('common.retry'), icon: 'i-lucide-refresh-cw', onSelect: event => { event.preventDefault(); void lookup() } }]
    : [
      { label: t('terminal.paneMenu.rename'), icon: 'i-lucide-pencil', onSelect: () => edit('rename') },
      { label: t('terminal.paneMenu.splitRight'), icon: 'i-lucide-columns-2', onSelect: () => { if (pane.value) void perform(pane.value, { action: 'split-right' }) } },
      { label: t('terminal.paneMenu.splitDown'), icon: 'i-lucide-rows-2', onSelect: () => { if (pane.value) void perform(pane.value, { action: 'split-down' }) } },
      { label: t('terminal.paneMenu.zoom'), icon: 'i-lucide-maximize', onSelect: () => { if (pane.value) void perform(pane.value, { action: 'zoom' }) } },
      { label: t('terminal.paneMenu.close'), icon: 'i-lucide-x', color: 'error', onSelect: () => edit('close') },
    ])
const content = computed(() => ({ reference: { getBoundingClientRect: () => new DOMRect(point.value.x, point.value.y, 0, 0) },
  ...dismiss, onOpenAutoFocus(event: Event) { if (event.target instanceof HTMLElement) menu.value = event.target } }))
</script>

<template>
  <UContextMenu v-model:open="open" :items="items" :modal="false" :content="content" :ui="{ content: 'pane-context-menu' }" />
  <UModal :open="!!dialog" :title="t(dialog?.kind === 'rename' ? 'terminal.paneMenu.rename' : 'terminal.paneMenu.close')" :dismissible="!busy"
    :close="{ 'aria-label': t('common.close'), disabled: busy }" :ui="{ content: 'pane-dialog', overlay: 'app-dialog-overlay' }" @update:open="value => { if (!value && !busy) dialog = undefined }">
    <template #body>
      <form :id="form" @submit.prevent="submit">
        <UFormField v-if="dialog?.kind === 'rename'" :label="t('terminal.paneMenu.name')"><UInput v-model="name" autofocus maxlength="200" class="w-full" :disabled="busy" /></UFormField>
        <p v-else>{{ t('terminal.paneMenu.closeConfirm') }}</p>
        <p v-if="error" class="pane-action-error" role="alert">{{ error }}</p>
      </form>
    </template>
    <template #footer><div class="pane-dialog-actions">
      <UButton color="neutral" variant="outline" :disabled="busy" @click="dialog = undefined">{{ t('common.cancel') }}</UButton>
      <UButton type="submit" :form="form" :color="dialog?.kind === 'close' ? 'error' : 'primary'" :loading="busy">{{ t(dialog?.kind === 'close' ? 'common.close' : 'common.save') }}</UButton>
    </div></template>
  </UModal>
</template>

<style>
.pane-context-menu{width:192px;max-width:calc(var(--ui-viewport-width) - 16px)}.pane-dialog{width:min(380px,calc(var(--ui-viewport-width) - 28px));max-height:calc(var(--mobile-height,var(--ui-viewport-height)) - 32px)}
.pane-dialog label,.pane-dialog input{margin-top:0}.pane-dialog p{font-size:13px}.pane-action-error{color:#e0aaa5;margin-top:12px}
.pane-dialog-actions{display:flex;justify-content:flex-end;gap:8px;width:100%}
</style>
