<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import USelect from '@nuxt/ui/components/Select.vue'

// Adds a note or file card to another canvas; App owns the reference write.
const props = defineProps<{ targets: Array<{ id: string; name: string; disabled: boolean }>; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; submit: [] }>()
const target = defineModel<string>({ required: true })
const { t } = useI18n()
const formId = useId()
const items = computed(() => props.targets.map(canvas => ({ label: canvas.name, value: canvas.id, disabled: canvas.disabled })))
const ready = computed(() => props.targets.some(canvas => canvas.id === target.value && !canvas.disabled))
</script>

<template>
  <UModal :open="true" :title="t('app.addToOtherCanvas')" :dismissible="!busy"
    :close="{ 'aria-label': t('app.closeDialog'), disabled: busy }" :ui="{ content: 'share-card-modal [--dialog-width:28rem]' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="emit('submit')">
        <UFormField :label="t('app.targetCanvas')">
          <USelect v-model="target" name="targetCanvas" :items="items" :placeholder="items.length ? undefined : t('app.noOtherCanvases')" :disabled="!items.length" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" role="alert" class="[overflow-wrap:anywhere]" />
      </UForm>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!ready">{{ t('app.addToCanvas') }}</UButton>
    </template>
  </UModal>
</template>
