<script setup lang="ts">
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { api, apiContext, isCurrentApi, ApiError } from '../api'
import { activeInstance } from '../instances'
import { formatInstanceLink } from '../instance-url'
import InstanceQrShare from './InstanceQrShare.vue'

const props = defineProps<{ open: boolean; username: string; portal?: HTMLElement }>()
const emit = defineEmits<{ close: []; saved: [username: string] }>()
const { t } = useI18n()
const formId = useId()
const sharing = ref(false)
const shareButton = useTemplateRef('shareButton'), backButton = useTemplateRef('backButton')
const shareLink = computed(() => formatInstanceLink(new URL(import.meta.env.BASE_URL, location.href).href, {
  base: activeInstance.value.base, name: activeInstance.value.name, username: props.username,
}))
const name = ref(''), currentPassword = ref(''), password = ref(''), confirmation = ref('')
const saving = ref(false), error = ref('')
const mismatch = computed(() => confirmation.value && password.value !== confirmation.value)
const ready = computed(() => !!name.value.trim() && !!currentPassword.value &&
  (!password.value || password.value.length >= 8 && password.value === confirmation.value) &&
  (name.value.trim() !== props.username || !!password.value))
watch(() => props.open, open => {
  sharing.value = false
  error.value = ''; currentPassword.value = ''; password.value = ''; confirmation.value = ''
  if (open) name.value = props.username
})
watch(() => activeInstance.value.id, () => { sharing.value = false })
async function showShare(value: boolean) {
  sharing.value = value
  await nextTick()
  ;(value ? backButton.value : shareButton.value)?.$el?.focus({ preventScroll: true })
}
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
  <UModal :open="open" :portal="portal || false" :title="t(sharing ? 'account.shareQr' : 'account.title')" :dismissible="!saving"
    :close="{ 'aria-label': t('common.close'), disabled: saving }" :ui="{ content: 'account-dialog', overlay: 'app-dialog-overlay' }" @update:open="value => { if (!value) close() }">
    <template #body>
      <InstanceQrShare v-if="sharing" :link="shareLink" :name="activeInstance.name" :base="activeInstance.base" :username="username" />
      <form v-else :id="formId" class="account-form" @submit.prevent="save">
        <UFormField :label="t('app.username')" required><UInput v-model="name" name="username" autocomplete="username" maxlength="200" class="w-full" :disabled="saving" /></UFormField>
        <UFormField :label="t('account.currentPassword')" required><UInput v-model="currentPassword" name="currentPassword" type="password" autocomplete="current-password" maxlength="1024" class="w-full" :disabled="saving" /></UFormField>
        <UFormField :label="t('account.newPassword')" :hint="t('app.optional')"><UInput v-model="password" name="newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="1024" class="w-full" :disabled="saving" /></UFormField>
        <UFormField v-if="password" :label="t('account.confirmPassword')" :error="mismatch ? t('account.passwordMismatch') : undefined" required><UInput v-model="confirmation" name="confirmPassword" type="password" autocomplete="new-password" maxlength="1024" class="w-full" :disabled="saving" /></UFormField>
        <p v-if="password" class="account-session-hint">{{ t('account.otherSessions') }}</p>
        <p v-if="error" class="account-error" role="alert">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="account-actions">
        <UButton v-if="sharing" ref="backButton" type="button" icon="i-lucide-arrow-left" color="neutral" variant="ghost" class="account-share-button" :aria-label="t('common.back')" :title="t('common.back')" @click="showShare(false)" />
        <template v-else>
          <UButton ref="shareButton" type="button" icon="i-lucide-qr-code" color="neutral" variant="ghost" class="account-share-button" :aria-label="t('account.shareQr')" :title="t('account.shareQr')" :disabled="saving" @click="showShare(true)" />
          <UButton color="neutral" variant="outline" :disabled="saving" @click="close">{{ t('common.cancel') }}</UButton>
          <UButton type="submit" :form="formId" :loading="saving" :disabled="!ready">{{ t('common.save') }}</UButton>
        </template>
      </div>
    </template>
  </UModal>
</template>

<style>
.account-dialog{z-index:50;width:min(420px,calc(100vw - 28px));max-height:calc(100dvh - 32px)}
.account-form{display:flex;flex-direction:column;gap:16px}.account-form label,.account-form input{margin-top:0}.account-form input{font-size:13px}
.account-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;width:100%}.account-share-button{margin-right:auto;align-self:stretch;min-width:32px;justify-content:center}.account-session-hint{font-size:11px;color:#96a0af;line-height:1.5}.account-error{font-size:12px;color:#e0aaa5}
</style>
