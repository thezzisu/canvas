<script setup lang="ts">
import { useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'

// A confirmation, optionally with one name field; App owns the request and its submit.
defineProps<{ title: string; description?: string; label?: string; optional?: boolean; danger?: boolean; button: string; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; submit: [] }>()
const value = defineModel<string>({ required: true })
const { t } = useI18n()
const formId = useId()
</script>

<template>
  <UModal :open="true" :title="title" :description="description || undefined" :dismissible="!busy"
    :close="{ 'aria-label': t('app.closeDialog'), disabled: busy }" :ui="{ content: '[--dialog-width:28rem]', wrapper: 'min-w-0 pe-9', title: '[overflow-wrap:anywhere]', description: '[overflow-wrap:anywhere]' }"
    @update:open="open => { if (!open) emit('close') }">
    <template v-if="label || error" #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="emit('submit')">
        <UFormField v-if="label" :label="label" :required="!optional"><UInput v-model="value" name="resourceName" :placeholder="optional ? t('app.automaticName') : undefined" maxlength="100" autofocus class="w-full" /></UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" role="alert" class="[overflow-wrap:anywhere]" />
      </UForm>
    </template>
    <template #footer>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</UButton>
      <!-- A plain confirmation has no form to submit. -->
      <UButton v-if="label" type="submit" :form="formId" :color="danger ? 'error' : 'primary'" :loading="busy" :disabled="!optional && !value.trim()">{{ button }}</UButton>
      <UButton v-else :color="danger ? 'error' : 'primary'" :loading="busy" @click="emit('submit')">{{ button }}</UButton>
    </template>
  </UModal>
</template>
