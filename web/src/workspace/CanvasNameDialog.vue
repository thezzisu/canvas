<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '../components/CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { segment, write } from '../api/api'
import { useSubmit } from '../lib/use-submit'
import { useWorkspaceStore } from '../stores/workspace'
import type { Canvas } from '../api/types'

// Names a new canvas or renames one. Closes with the id of a canvas it created.
const props = defineProps<{ canvas?: Canvas }>()
const emit = defineEmits<{ close: [created?: string] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const formId = useId()
const name = ref(props.canvas?.name || '')
const { busy, error, run } = useSubmit()
async function submit() {
  let created: string | undefined
  const saved = await run(async () => {
    const body = { name: name.value.trim() }
    if (props.canvas) await write(`/api/canvases/${segment(props.canvas.id)}`, 'PATCH', body)
    else created = (await write<Canvas>('/api/canvases', 'POST', { ...body, nodes: [] })).id
    await workspace.sync()
  })
  if (saved) emit('close', created)
}
</script>

<template>
  <UModal
    :title="t(canvas ? 'app.renameCanvas' : 'app.newCanvas')"
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{ content: '[--dialog-width:28rem]' }"
  >
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="submit">
        <UFormField :label="t('app.canvasName')" required>
          <UInput
            v-model="name"
            name="canvasName"
            :placeholder="t('app.canvasNamePlaceholder')"
            maxlength="80"
            autofocus
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
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">
        {{ t('common.cancel') }}
      </UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!name.trim()">
        {{ t(canvas ? 'common.save' : 'app.createCanvas') }}
      </UButton>
    </template>
  </UModal>
</template>
