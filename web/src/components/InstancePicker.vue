<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import UModal from '@nuxt/ui/components/Modal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import { activeInstance, importInstance, instances, removeInstance, saveInstance, selectInstance } from '../instances'
import InstanceQrScanner from './InstanceQrScanner.vue'
import Icon from './Icon.vue'
import { instanceBuild, observeInstanceBuild } from '../instance-builds'
import { buildLabel } from '../../../shared/build-info'
import { useInstanceProbe } from '../instance-probe'
import { normalizeApiBase, parseInstanceLink, type InstanceLink } from '../instance-url'
import { usePointerDismiss } from '../pointer-dismiss'

const props = defineProps<{ portal?: HTMLElement; beforeChange?: () => Promise<boolean>; disabled?: boolean }>()
const emit = defineEmits<{ connect: [] }>()
const { t } = useI18n()
const open = ref(false), working = ref(false), error = ref('')
const scanning = ref(false), scanned = ref<InstanceLink>()
const menuOpen = ref(false), menuTrigger = ref<HTMLButtonElement>()
const menuDismiss = usePointerDismiss(menuOpen, menuTrigger)
const draft = reactive({ id: '', name: '', base: '' })
const draftBuild = computed(() => draft.id ? instanceBuild(draft) : undefined)
const original = computed(() => instances.value.find(instance => instance.id === draft.id))
const needsProbe = computed(() => {
  try { return !original.value || original.value.base !== normalizeApiBase(draft.base) }
  catch { return true }
})
const probe = useInstanceProbe(() => draft.base, () => open.value && needsProbe.value)
const canSubmit = computed(() => open.value && !scanning.value && !!draft.name.trim() && !!probe.base.value && (!needsProbe.value || probe.ready.value))
const displayedBuild = computed(() => needsProbe.value ? probe.result.value?.build : draftBuild.value?.build)
watch(open, value => { if (!value) { scanning.value = false; scanned.value = undefined } }, { flush: 'sync' })
watch(() => `${activeInstance.value.id}:${activeInstance.value.base}`, () => { open.value = false }, { flush: 'sync' })
watch([canSubmit, scanned], ([ready, details]) => { if (ready && details) void submit() })
async function change(action: () => void) {
  if (working.value || props.disabled) return
  working.value = true
  try { if (!props.beforeChange || await props.beforeChange()) action() }
  finally { working.value = false }
}
function edit(add = false) {
  const { id, name, base } = activeInstance.value
  Object.assign(draft, add ? { id: '', name: '', base: '' } : { id, name, base })
  error.value = ''; scanned.value = undefined; open.value = true
}
function editField(field: 'name' | 'base', value: string | number) {
  scanned.value = undefined; error.value = ''; draft[field] = String(value)
}
function scan(text: string): boolean {
  if (!open.value || working.value || draft.id) return false
  try {
    const parsed = parseInstanceLink(text)
    if (!parsed?.server || parsed.invalid) return false
    scanned.value = parsed.server
    draft.name = instances.value.find(instance => instance.base === parsed.server!.base)?.name || parsed.server.name
    draft.base = parsed.server.base; error.value = ''; scanning.value = false
    if (probe.failed.value) probe.retry()
    return true
  } catch { return false }
}
async function submit() {
  if (!canSubmit.value) return
  const details = scanned.value, submitted = { ...draft }
  error.value = ''
  try { await change(() => {
    if (!canSubmit.value || scanned.value !== details || submitted.id !== draft.id || submitted.name !== draft.name || submitted.base !== draft.base) return
    const build = probe.result.value?.build
    const instance = details ? importInstance(details) : saveInstance(submitted)
    if (build) observeInstanceBuild(instance, build)
    open.value = false
    if (details) emit('connect')
  }) }
  catch (reason) { error.value = reason instanceof Error && reason.message.startsWith('instances.') ? reason.message : 'instances.invalidUrl' }
}
const items = computed<DropdownMenuItem[][]>(() => [
  instances.value.map(instance => ({ label: instance.name, type: 'checkbox' as const, server: instanceBuild(instance),
    checked: instance.id === activeInstance.value.id, onSelect: (): void => { void change(() => selectInstance(instance.id)) } })),
  [{ label: t('instances.add'), onSelect: () => edit(true) },
    { label: t('instances.edit'), onSelect: () => edit() },
    { label: t('instances.remove'), disabled: !!activeInstance.value.builtin,
      onSelect: (): void => { void change(() => removeInstance(activeInstance.value.id)) } }],
])
</script>

<template>
  <UDropdownMenu v-model:open="menuOpen" :modal="false" :items="items" :portal="portal || false" :content="{ side: 'top', align: 'start', sideOffset: 6, ...menuDismiss }"
    :ui="{ content: 'instance-menu' }">
    <template #item-label="{ item }">
      <span class="instance-menu-label"><span>{{ item.label }}</span><small v-if="item.server" class="instance-version" :class="{ stale: !item.server.fresh }" :title="`${t('instances.serverVersion')}: ${item.server.build.version}${item.server.build.revision ? ` · ${item.server.build.revision}` : ''}${!item.server.fresh ? ` · ${t('instances.lastSeen')}` : ''}`">{{ buildLabel(item.server.build) }}<span v-if="!item.server.fresh"> · {{ t('instances.lastSeen') }}</span></small></span>
    </template>
    <button ref="menuTrigger" type="button" class="instance-trigger" :disabled="disabled || working" :aria-busy="working" :title="activeInstance.base" :aria-label="`${t('instances.instance')}: ${activeInstance.name}`">
      <Icon name="server" :size="15" /><span>{{ activeInstance.name }}</span><Icon name="down" :size="12" />
    </button>
  </UDropdownMenu>
  <UModal v-model:open="open" :portal="portal || false" :title="t(draft.id ? 'instances.edit' : 'instances.add')"
    :close="{ 'aria-label': t('common.close') }" :ui="{ content: 'instance-dialog', overlay: 'instance-dialog-overlay', body: 'instance-dialog-body' }">
    <template #body>
      <form id="instance-form" @submit.prevent="submit">
        <UFormField :label="t('instances.name')" name="name" required><UInput :model-value="draft.name" autofocus maxlength="80" class="w-full" :disabled="working" @update:model-value="value => editField('name', value)" /></UFormField>
        <UFormField :label="t('instances.address')" name="address" required><UInput :model-value="draft.base" type="url" placeholder="https://canvas.example/" autocomplete="url" class="w-full" :readonly="!!original?.builtin" :disabled="working" @update:model-value="value => editField('base', value)" /></UFormField>
        <dl v-if="draftBuild" class="instance-build-detail"><dt>{{ t('instances.serverVersion') }}</dt><dd>{{ buildLabel(draftBuild.build) }}<small v-if="!draftBuild.fresh">{{ t('instances.lastSeen') }}</small></dd><template v-if="draftBuild.build.revision"><dt>{{ t('instances.revision') }}</dt><dd class="instance-revision">{{ draftBuild.build.revision }}</dd></template></dl>
        <p v-if="error" role="alert" class="instance-error">{{ t(error) }}</p>
      </form>
    </template>
    <template #footer><div class="instance-probe-footer"><UButton type="submit" form="instance-form" :loading="working" :disabled="!canSubmit">{{ t(draft.id ? 'common.save' : 'instances.connect') }}</UButton><span class="instance-probe-status" role="status"><span v-if="probe.pending.value">{{ t('instances.probing') }}</span><button v-else-if="probe.failed.value" type="button" @click="probe.retry">{{ t('instances.probeFailed') }} · {{ t('instances.retry') }}</button><span v-else-if="displayedBuild" :title="`${t('instances.serverVersion')}: ${displayedBuild.version}${displayedBuild.revision ? ` · ${displayedBuild.revision}` : ''}`">{{ buildLabel(displayedBuild) }}</span></span><UButton v-if="!draft.id" type="button" color="neutral" variant="ghost" icon="i-lucide-scan-qr-code" class="instance-add-scan" :disabled="working" :title="t('instances.scanQr')" :aria-label="t('instances.scanQr')" @click="scanned = undefined; scanning = true" /></div></template>
  </UModal>
  <InstanceQrScanner :open="open && scanning" :accept="scan" :portal="portal" @close="scanning = false" />
</template>

<style>
.instance-trigger{display:flex;align-items:center;gap:7px;min-width:0;width:100%;padding:8px 3px;color:#aeb9c7;text-align:left;font-size:11px}
.instance-trigger>span{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.instance-trigger>svg{flex:none;color:#7f8da0}.instance-trigger:hover{color:#e1d1c2}
.instance-menu{min-width:200px;max-width:min(320px,calc(100vw - 24px));z-index:90}
.instance-menu [data-disabled]{cursor:not-allowed}
.instance-menu-label{display:flex;align-items:center;gap:10px;min-width:0}.instance-menu-label>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.instance-version{flex:0 1 auto;min-width:0;max-width:60%;overflow:hidden;text-overflow:ellipsis;color:#7d899a;font-size:10px;font-weight:400;white-space:nowrap}.instance-version.stale{color:#707b8a}
.instance-build-detail{display:grid;grid-template-columns:auto minmax(0,1fr);gap:7px 12px;margin:0;font-size:11px;color:#8995a6}.instance-build-detail dt{font-weight:400}.instance-build-detail dd{margin:0;color:#bbc5d2;overflow-wrap:anywhere}.instance-build-detail small{margin-left:7px;color:#7d899a}.instance-revision{font-family:monospace;overflow-wrap:anywhere;font-size:10px}
.instance-dialog{width:min(420px,calc(100vw - 28px));max-height:calc(100dvh - 32px);z-index:92}
.instance-dialog-overlay{z-index:91}.instance-add-scan{align-self:stretch;min-width:32px;justify-content:center}
.instance-dialog-body{padding:16px 20px}.instance-dialog form{display:flex;flex-direction:column;gap:16px}
.instance-dialog label{margin-top:0}.instance-dialog input{margin-top:0;font-size:13px}
.instance-error{color:#dfaaa5;font-size:12px}.login-content>.instance-trigger{margin:6px 0 2px}
.instance-probe-footer{display:flex;align-items:center;gap:12px;min-width:0;width:100%}.instance-probe-footer>button{flex:none}.instance-probe-status{display:block;flex:1;min-width:0;margin-left:auto;text-align:right;color:#8391a4;font-size:11px}.instance-probe-status>span,.instance-probe-status>button{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.instance-probe-status>button{margin-left:auto;padding:0;font-size:inherit;color:inherit}
.sidebar-footer>.instance-trigger{flex:1}.sidebar-footer>.instance-trigger>span{max-width:100px}
</style>
