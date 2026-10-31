<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { api, apiContext, isCurrentApi, ApiError } from '../api'

const props = defineProps<{ open: boolean; username: string; portal?: HTMLElement }>()
const emit = defineEmits<{ close: []; saved: [username: string] }>()
const { t } = useI18n()
const formId = useId()
const name = ref(''), currentPassword = ref(''), password = ref(''), confirmation = ref('')
const saving = ref(false), error = ref('')
const mismatch = computed(() => confirmation.value && password.value !== confirmation.value)
const ready = computed(() => !!name.value.trim() && !!currentPassword.value &&
  (!password.value || password.value.length >= 8 && password.value === confirmation.value) &&
  (name.value.trim() !== props.username || !!password.value))
watch(() => props.open, open => {
  error.value = ''; currentPassword.value = ''; password.value = ''; confirmation.value = ''
  if (open) name.value = props.username
})
function close() { if (!saving.value) emit('close') }
async function save() {
  if (!ready.value || saving.value) return
  const context = apiContext()
  saving.value = true; error.value = ''
  try {
    const result = await api<{ username: string }>('/api/account', { method: 'PATCH', body: JSON.stringify({
      username: name.value.trim(), currentPassword: currentPassword.value, ...(password.value ? { password: password.value } : {}),
    }) }, context)
    if (!isCurrentApi(context)) return
    emit('saved', result.username); emit('close')
  } catch (reason) {
    if (!isCurrentApi(context)) return
    error.value = reason instanceof ApiError && reason.status === 403 ? t('account.incorrectPassword')
      : reason instanceof ApiError && reason.status === 429 ? t('common.tooManyAttempts') : t('account.saveFailed')
  } finally { saving.value = false }
}
</script>

<template>
  <UModal :open="open" :portal="portal || false" :title="t('account.title')" :dismissible="!saving"
    :close="{ 'aria-label': t('common.close'), disabled: saving }" :ui="{ content: 'account-dialog' }" @update:open="value => { if (!value) close() }">
    <template #body>
      <form :id="formId" class="account-form" @submit.prevent="save">
        <UFormField :label="t('app.username')" required><UInput v-model="name" name="username" autocomplete="username" maxlength="200" class="w-full" :disabled="saving" /></UFormField>
        <UFormField :label="t('account.currentPassword')" required><UInput v-model="currentPassword" name="currentPassword" type="password" autocomplete="current-password" maxlength="1024" class="w-full" :disabled="saving" /></UFormField>
        <UFormField :label="t('account.newPassword')" :hint="t('app.optional')"><UInput v-model="password" name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="1024" class="w-full" :disabled="saving" /></UFormField>
        <UFormField v-if="password" :label="t('account.confirmPassword')" :error="mismatch ? t('account.passwordMismatch') : undefined" required><UInput v-model="confirmation" name="confirmPassword" type="password" autocomplete="new-password" maxlength="1024" class="w-full" :disabled="saving" /></UFormField>
        <p v-if="password" class="account-session-hint">{{ t('account.otherSessions') }}</p>
        <p v-if="error" class="account-error" role="alert">{{ error }}</p>
      </form>
    </template>
    <template #footer><div class="account-actions"><UButton color="neutral" variant="outline" :disabled="saving" @click="close">{{ t('common.cancel') }}</UButton><UButton type="submit" :form="formId" :loading="saving" :disabled="!ready">{{ t('common.save') }}</UButton></div></template>
  </UModal>
</template>

<style>
.account-dialog{width:min(420px,calc(100vw - 28px));max-height:calc(100dvh - 32px)}
.account-form{display:flex;flex-direction:column;gap:16px}.account-form label,.account-form input{margin-top:0}.account-form input{font-size:13px}
.account-actions{display:flex;justify-content:flex-end;gap:8px;width:100%}.account-session-hint{font-size:11px;color:#96a0af;line-height:1.5}.account-error{font-size:12px;color:#e0aaa5}
</style>
