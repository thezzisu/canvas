<script setup lang="ts">
import { computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from './CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCollapsible from '@nuxt/ui/components/Collapsible.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import type { Source } from '../types'

// Presentation only: App owns the draft, its probe and the save.
const props = defineProps<{ probe: { pending: boolean; version?: string; error?: string }; ready: boolean; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; submit: []; retry: [] }>()
const draft = defineModel<Source>('draft', { required: true })
const { t } = useI18n()
const formId = useId()
const runtimes = [{ label: 'Herdr TUI', value: 'tui' }, { label: 'Herdr Core / App', value: 'core' }]
const transports = computed(() => [
  { label: t('app.local'), value: 'local', icon: 'i-lucide-server', disabled: props.busy },
  { label: t('app.remoteSsh'), value: 'ssh', icon: 'i-lucide-globe', disabled: props.busy },
])
const probeText = computed(() => props.probe.pending ? t('app.checkingConnection') : props.probe.error ? t('app.connectionProbeFailed')
  : props.probe.version ? `${draft.value.runtime === 'core' ? 'herdr-core' : 'herdr'} ${props.probe.version}` : '')
</script>

<template>
  <UModal :open="true" :title="t(draft.id ? 'app.editConnection' : 'app.addConnection')" :dismissible="!busy"
    :close="{ 'aria-label': t('app.closeDialog'), disabled: busy }" :ui="{ content: 'source-modal [--dialog-width:30rem]' }" @update:open="value => { if (!value) emit('close') }">
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="emit('submit')">
        <UFormField :label="t('app.connectionName')" required><UInput v-model="draft.name" name="sourceName" :placeholder="t('app.connectionNamePlaceholder')" class="w-full" /></UFormField>
        <UFormField :label="t('app.runtime')"><USelect v-model="draft.runtime" name="runtime" :items="runtimes" class="w-full" /></UFormField>
        <UTabs v-model="draft.transport" :items="transports" :content="false" color="neutral" variant="pill" class="w-full" />
        <UFormField v-if="draft.transport === 'ssh'" :label="t('app.sshAddress')" required><UInput v-model="draft.target" name="target" placeholder="ssh://user@hostname:22" class="w-full" /></UFormField>
        <UFormField :label="t('app.session')" :hint="t('app.optional')"><UInput v-model="draft.herdrSession" name="herdrSession" placeholder="default" class="w-full" /></UFormField>
        <!-- Collapsed fields stay mounted: they belong to the form and keep their values reachable. -->
        <UCollapsible :unmount-on-hide="false" :disabled="busy" class="flex flex-col gap-4">
          <UButton type="button" color="neutral" variant="ghost" trailing-icon="i-lucide-chevron-down" class="group self-start"
            :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-200 motion-reduce:transition-none' }">{{ t('app.advanced') }}</UButton>
          <template #content>
            <div class="flex flex-col gap-4">
              <template v-if="draft.transport === 'ssh'">
                <UFormField :label="t('app.sshIdentity')" :hint="t('app.optional')"><UInput v-model="draft.sshIdentityFile" name="sshIdentityFile" placeholder="/path/to/id_ed25519" class="w-full" /></UFormField>
                <UFormField :label="t('app.sshKnownHosts')" :hint="t('app.optional')"><UInput v-model="draft.sshKnownHostsFile" name="sshKnownHostsFile" placeholder="/path/to/known_hosts" class="w-full" /></UFormField>
              </template>
              <UFormField :label="t('app.socketPath')" :hint="t('app.optional')"><UInput v-model="draft.herdrSocket" name="herdrSocket" :placeholder="draft.runtime === 'core' ? '/path/to/default.sock' : '/path/to/herdr.sock'" class="w-full" /></UFormField>
            </div>
          </template>
        </UCollapsible>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" role="alert" class="[overflow-wrap:anywhere]" />
      </UForm>
    </template>
    <template #footer>
      <div class="source-probe-status flex min-w-0 flex-1 items-center gap-1.5 text-xs" :class="probe.error ? 'text-error' : 'text-muted'" role="status">
        <UIcon v-if="probe.pending" name="i-lucide-loader-circle" class="size-3.5 shrink-0 motion-safe:animate-spin" />
        <span class="truncate" :title="probe.error || probe.version">{{ probeText }}</span>
        <UButton v-if="probe.error" type="button" color="neutral" variant="ghost" size="xs" icon="i-lucide-refresh-cw" :disabled="busy" :aria-label="t('common.retry')" :title="t('common.retry')" @click="emit('retry')" />
      </div>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</UButton>
      <UButton type="submit" :form="formId" :loading="busy" :disabled="!ready || !draft.name.trim()">{{ t('common.save') }}</UButton>
    </template>
  </UModal>
</template>
