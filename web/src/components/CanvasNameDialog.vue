<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'

// Names a new canvas or renames one; App owns the draft and the save.
defineProps<{ busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; submit: [] }>()
const draft = defineModel<{ id: string; name: string }>('draft', { required: true })
const { t } = useI18n()
const formId = useId()
</script>

<template>
  <UModal :open="true" :title="t(draft.id ? 'app.renameCanvas' : 'app.newCanvas')" :dismissible="!busy"
    :close="{ 'aria-label': t('app.closeDialog'), disabled: busy }" :ui="{ content: '[--dialog-width:28rem]' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="emit('submit')">
        <UFormField :label="t('app.canvasName')" required><UInput v-model="draft.name" name="canvasName" :placeholder="t('app.canvasNamePlaceholder')" maxlength="80" autofocus class="w-full" /></UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" role="alert" class="[overflow-wrap:anywhere]" />
      </UForm>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!draft.name.trim()">{{ t(draft.id ? 'common.save' : 'app.createCanvas') }}</UButton>
    </template>
  </UModal>
</template>
