<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '../components/CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import { segment, write } from '../api/api'
import { notify } from '../lib/notify'
import { useSubmit } from '../lib/use-submit'
import { useEditsStore } from '../stores/edits'
import { useWorkspaceStore } from '../stores/workspace'
import type { FileCanvasNode, NoteCanvasNode } from '../api/types'

// Adds a note or file card to another canvas; both then show the same content.
const props = defineProps<{ canvasId: string; node: NoteCanvasNode | FileCanvasNode }>()
const emit = defineEmits<{ close: [added: boolean] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore(),
  edits = useEditsStore()
const formId = useId()
const { busy, error, run } = useSubmit()
/** Every other canvas; one that already shows this card cannot take it again. */
const items = computed(() =>
  workspace.canvases
    .filter((canvas) => canvas.id !== props.canvasId)
    .map((canvas) => ({
      label: canvas.name,
      value: canvas.id,
      disabled: canvas.nodes.some(
        (node) =>
          node.id === props.node.id ||
          (node.type === 'file' &&
            props.node.type === 'file' &&
            node.assetId === props.node.assetId),
      ),
    })),
)
const target = ref(items.value.find((item) => !item.disabled)?.value || items.value[0]?.value || '')
const destination = computed(() =>
  workspace.canvases.find(
    (canvas) =>
      canvas.id === target.value &&
      items.value.some((item) => item.value === canvas.id && !item.disabled),
  ),
)
async function submit() {
  const canvas = destination.value
  if (!canvas) return
  const added = await run(async () => {
    if (!(await edits.flushAll())) return
    await write(`/api/canvases/${segment(canvas.id)}/references`, 'POST', {
      sourceCanvasId: props.canvasId,
      nodeId: props.node.id,
      x: Math.max(80, ...canvas.nodes.map((node) => node.x + node.width + 24)),
      y: 80,
    })
    await workspace.sync()
  })
  if (!added) return
  notify.success(t('app.addedToCanvas', { name: canvas.name }))
  emit('close', true)
}
</script>

<template>
  <UModal
    :title="t('app.addToOtherCanvas')"
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{ content: 'share-card-modal [--dialog-width:28rem]' }"
  >
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="submit">
        <UFormField :label="t('app.targetCanvas')">
          <USelect
            v-model="target"
            name="targetCanvas"
            :items="items"
            :placeholder="items.length ? undefined : t('app.noOtherCanvases')"
            :disabled="!items.length"
            class="w-full"
          />
        </UFormField>
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
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close', false)">
        {{ t('common.cancel') }}
      </UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!destination">
        {{ t('app.addToCanvas') }}
      </UButton>
    </template>
  </UModal>
</template>
