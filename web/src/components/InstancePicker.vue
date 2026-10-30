<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { activeInstance, instances, removeInstance, saveInstance, selectInstance } from '../instances'
import Icon from './Icon.vue'

const props = defineProps<{ portal?: HTMLElement; beforeChange?: () => Promise<boolean>; disabled?: boolean }>()
const { t } = useI18n()
const open = ref(false), working = ref(false), error = ref('')
const draft = reactive({ id: '', name: '', base: '' })
async function change(action: () => void) {
  if (working.value || props.disabled) return
  working.value = true
  try { if (!props.beforeChange || await props.beforeChange()) action() }
  finally { working.value = false }
}
function edit(add = false) {
  if (!add && activeInstance.value.builtin) return
  Object.assign(draft, add ? { id: '', name: '', base: '' } : activeInstance.value)
  error.value = ''; open.value = true
}
async function submit() {
  error.value = ''
  try { await change(() => { saveInstance(draft); open.value = false }) }
  catch (reason) { error.value = reason instanceof Error && reason.message.startsWith('instances.') ? reason.message : 'instances.invalidUrl' }
}
const items = computed<DropdownMenuItem[][]>(() => [
  instances.value.map(instance => ({ label: instance.name, type: 'checkbox' as const,
    checked: instance.id === activeInstance.value.id, onSelect: (): void => { void change(() => selectInstance(instance.id)) } })),
  [{ label: t('instances.add'), onSelect: () => edit(true) },
    { label: t('instances.edit'), disabled: !!activeInstance.value.builtin, onSelect: () => edit() },
    { label: t('instances.remove'), disabled: !!activeInstance.value.builtin,
      onSelect: (): void => { void change(() => removeInstance(activeInstance.value.id)) } }],
])
</script>

<template>
  <UDropdownMenu :items="items" :portal="portal || false" :content="{ side: 'top', align: 'start', sideOffset: 6 }"
    :ui="{ content: 'instance-menu' }">
    <button type="button" class="instance-trigger" :disabled="disabled || working" :aria-busy="working" :title="activeInstance.base" :aria-label="`${t('instances.instance')}: ${activeInstance.name}`">
      <Icon name="server" :size="15" /><span>{{ activeInstance.name }}</span><Icon name="down" :size="12" />
    </button>
  </UDropdownMenu>
  <UModal v-model:open="open" :portal="portal || false" :title="t(draft.id ? 'instances.edit' : 'instances.add')"
    :close="{ 'aria-label': t('common.close') }" :ui="{ content: 'instance-dialog', body: 'instance-dialog-body' }">
    <template #body>
      <form id="instance-form" @submit.prevent="submit">
        <UFormField :label="t('instances.name')" name="name" required><UInput v-model="draft.name" autofocus maxlength="80" class="w-full" :disabled="working" /></UFormField>
        <UFormField :label="t('instances.address')" name="address" required><UInput v-model="draft.base" type="url" placeholder="https://canvas.example/" autocomplete="url" class="w-full" :disabled="working" /></UFormField>
        <p v-if="error" role="alert" class="instance-error">{{ t(error) }}</p>
      </form>
    </template>
    <template #footer><UButton type="submit" form="instance-form" :loading="working" :disabled="!draft.name.trim() || !draft.base.trim()">{{ t(draft.id ? 'common.save' : 'instances.connect') }}</UButton></template>
  </UModal>
</template>

<style>
.instance-trigger{display:flex;align-items:center;gap:7px;min-width:0;width:100%;padding:8px 3px;color:#aeb9c7;text-align:left;font-size:11px}
.instance-trigger>span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.instance-trigger>svg{flex:none;color:#7f8da0}.instance-trigger:hover{color:#e1d1c2}
.instance-menu{min-width:200px;max-width:min(320px,calc(100vw - 24px));z-index:90}
.instance-menu [data-disabled]{cursor:not-allowed}
.instance-dialog{width:min(420px,calc(100vw - 28px));max-height:calc(100dvh - 32px);z-index:92}
.instance-dialog-body{padding:16px 20px}.instance-dialog form{display:flex;flex-direction:column;gap:16px}
.instance-dialog label{margin-top:0}.instance-dialog input{margin-top:0;font-size:13px}
.instance-error{color:#dfaaa5;font-size:12px}.login-content>.instance-trigger{margin:6px 0 2px}
.sidebar-footer>.instance-trigger{flex:1}.sidebar-footer>.instance-trigger>span{max-width:100px}
</style>
