<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '../components/CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import WindowPickerTree from './WindowPickerTree.vue'
import { segment, uuid, write } from '../api/api'
import { notify } from '../lib/notify'
import { useSubmit } from '../lib/use-submit'
import { useWorkspaceStore, windowKey } from '../stores/workspace'
import { isTerminalNode, type Canvas, type TerminalCanvasNode } from '../api/types'

// Picks windows and the canvas to add them to. Closes with that canvas's id.
const props = defineProps<{
  /** Preselect one window, offering only canvases that do not show it yet. */
  window?: Pick<TerminalCanvasNode, 'sourceId' | 'spaceId' | 'windowId'>
  /** The canvas to offer first. */
  preferred?: string
}>()
const emit = defineEmits<{ close: [canvasId?: string] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const formId = useId()
const { busy, error, run } = useSubmit()
const shows = (canvas: Canvas, sourceId: string, windowId: string) =>
  canvas.nodes.some(
    (node) => isTerminalNode(node) && node.sourceId === sourceId && node.windowId === windowId,
  )
const candidates = props.window
  ? workspace.canvases.filter(
      (canvas) => !shows(canvas, props.window!.sourceId, props.window!.windowId),
    )
  : workspace.canvases
// A new canvas is one of the destinations; Select items cannot carry an empty value.
const create = 'new'
const destination = ref(
  candidates.find((canvas) => canvas.id === props.preferred)?.id || candidates[0]?.id || create,
)
const search = ref('')
const selected = ref(
  props.window ? [`${props.window.sourceId}/${props.window.spaceId}/${props.window.windowId}`] : [],
)
const target = computed(() => workspace.canvases.find((canvas) => canvas.id === destination.value))
const existing = computed(
  () => new Set(target.value?.nodes.filter(isTerminalNode).map(windowKey) || []),
)
const chosen = computed(() =>
  workspace.allWindows.filter(
    (item) =>
      selected.value.includes(item.key) &&
      !existing.value.has(`${item.source.id}/${item.window.id}`),
  ),
)
// A window that closed, or that the chosen canvas already shows, leaves the selection.
watch(chosen, (items) => {
  if (items.length !== selected.value.length) selected.value = items.map((item) => item.key)
})
async function submit() {
  if (!chosen.value.length) return
  let canvas = target.value
  const added = await run(async () => {
    canvas ||= await write<Canvas>('/api/canvases', 'POST', { name: t('app.myCanvas'), nodes: [] })
    // New cards go below the existing ones, three to a row.
    let x = 0,
      y = canvas.nodes?.length
        ? Math.max(...canvas.nodes.map((node) => node.y + node.height)) + 24
        : 0,
      rowHeight = 0
    const nodes = chosen.value.map((item, index) => {
      if (index && index % 3 === 0) {
        x = 0
        y += rowHeight + 24
        rowHeight = 0
      }
      const size = workspace.windowSize({ sourceId: item.source.id, windowId: item.window.id })
      const node = {
        type: 'terminal' as const,
        id: uuid(),
        sourceId: item.source.id,
        spaceId: item.space.id,
        windowId: item.window.id,
        x,
        y,
        ...size,
      }
      x += size.width + 24
      rowHeight = Math.max(rowHeight, size.height)
      return node
    })
    await write(`/api/canvases/${segment(canvas.id)}/nodes`, 'POST', { nodes })
    await workspace.sync()
  })
  if (!added || !canvas) return
  notify.success(t('app.addedToCanvas', { name: canvas.name }))
  emit('close', canvas.id)
}
// Enter in the search only filters; the footer action adds the selection. IME commits pass through.
function keepSearching(event: KeyboardEvent) {
  if (!event.isComposing) event.preventDefault()
}
const destinations = computed(() =>
  [
    candidates.map((canvas) => ({ label: canvas.name, value: canvas.id })),
    [{ label: t('app.newMyCanvas'), value: create }],
  ].filter((group) => group.length),
)
</script>

<template>
  <UModal
    :title="t('app.addWindows')"
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{ content: 'add-modal [--dialog-width:36rem]' }"
  >
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="submit">
        <UFormField :label="t('app.targetCanvas')"
          ><USelect v-model="destination" name="targetCanvas" :items="destinations" class="w-full"
        /></UFormField>
        <UInput
          v-model="search"
          icon="i-lucide-search"
          :aria-label="t('app.searchWindows')"
          :placeholder="t('app.searchPlaceholder')"
          class="w-full"
          @keydown.enter="keepSearching"
        />
        <p
          v-if="!workspace.discovered"
          class="flex items-center justify-center gap-1.5 py-6 text-xs text-muted"
          role="status"
        >
          <UIcon
            v-if="!workspace.loadFailure"
            name="i-lucide-loader-circle"
            class="size-3.5 motion-safe:animate-spin"
          />{{ t(workspace.loadFailure ? 'app.loadFailed' : 'common.loading') }}
        </p>
        <WindowPickerTree
          v-if="workspace.resourcesLoaded"
          v-model:selected="selected"
          :fresh="workspace.freshStatuses"
          :sources="workspace.sources"
          :resources="workspace.resources"
          :query="search"
          :existing="existing"
        />
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          :title="error"
          role="alert"
          class="[overflow-wrap:anywhere]"
        />
      </UForm>
    </template>
    <template #footer>
      <span class="min-w-0 flex-1 truncate text-xs text-muted">{{
        t('app.selectedWindows', chosen.length)
      }}</span>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">{{
        t('common.cancel')
      }}</UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!chosen.length">{{
        t('app.addToCanvas')
      }}</UButton>
    </template>
  </UModal>
</template>
