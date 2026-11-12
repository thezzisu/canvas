<script setup lang="ts">
import { ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { useSubmit } from '../composables/use-submit'
import type { ActionRequest } from '../composables/workspace/dialogs'

// A confirmation, optionally with one name field. It runs the request's action itself.
const props = defineProps<ActionRequest>()
const emit = defineEmits<{ close: [done: boolean] }>()
const { t } = useI18n()
const formId = useId()
const value = ref(props.value || '')
const { busy, error, run } = useSubmit()
async function submit() {
  if (await run(() => props.submit(value.value.trim()))) emit('close', true)
}
/** With a name field the form submits; a plain confirmation acts on the button itself. */
function confirm() {
  if (!props.label) void submit()
}
</script>

<template>
  <UModal
    :title="title"
    :description="description || undefined"
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{
      content: '[--dialog-width:28rem]',
      wrapper: 'min-w-0 pe-9',
      title: '[overflow-wrap:anywhere]',
      description: '[overflow-wrap:anywhere]',
    }"
  >
    <template v-if="label || error" #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="submit">
        <UFormField v-if="label" :label="label" :required="!optional">
          <UInput
            v-model="value"
            name="resourceName"
            :placeholder="optional ? t('app.automaticName') : undefined"
            maxlength="100"
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
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close', false)">
        {{ t('common.cancel') }}
      </UButton>
      <UButton
        :type="label ? 'submit' : 'button'"
        :form="label ? formId : undefined"
        :color="danger ? 'error' : 'primary'"
        :loading="busy"
        :disabled="!!label && !optional && !value.trim()"
        @click="confirm"
      >
        {{ button }}
      </UButton>
    </template>
  </UModal>
</template>
