<script setup lang="ts">
import { computed, reactive, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UModal from '../CanvasModal.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UCollapsible from '@nuxt/ui/components/Collapsible.vue'
import UForm from '@nuxt/ui/components/Form.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import USelect from '@nuxt/ui/components/Select.vue'
import UTabs from '@nuxt/ui/components/Tabs.vue'
import { api, apiContext, isCurrentApi, segment, write } from '../../api/api'
import { errorMessage, notify } from '../../composables/notify'
import { useSubmit } from '../../composables/use-submit'
import { sourceConnection, useWorkspaceStore } from '../../stores/workspace'
import type { Source } from '../../api/types'

// Adds or edits a connection. It can be saved once herdr has answered at the address.
const props = defineProps<{ source?: Source }>()
const emit = defineEmits<{ close: [saved: boolean] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const formId = useId()
const draft = reactive<Source>({
  id: '',
  name: '',
  runtime: 'tui',
  transport: 'local',
  target: '',
  herdrSession: '',
  herdrSocket: '',
  sshIdentityFile: '',
  sshKnownHostsFile: '',
  ...props.source,
})
const { busy, error, run } = useSubmit()

const PROBE_DELAY_MS = 500
const probe = ref<{ key: string; pending: boolean; version?: string; error?: string }>({
  key: '',
  pending: false,
})
const retries = ref(0)
const connection = computed(() => JSON.stringify(sourceConnection(draft)))
/** An existing connection whose address was not edited needs no new check. */
const unchanged = computed(
  () => !!props.source && JSON.stringify(sourceConnection(props.source)) === connection.value,
)
const ready = computed(
  () => unchanged.value || (probe.value.key === connection.value && !!probe.value.version),
)
watch(
  [connection, retries, unchanged],
  ([key], _previous, onCleanup) => {
    probe.value = { key: '', pending: false }
    if (unchanged.value) {
      const version = workspace.resources.find((item) => item.id === draft.id)?.serverVersion
      probe.value = { key, pending: false, version }
      return
    }
    if (draft.transport === 'ssh' && !draft.target?.trim()) return
    const controller = new AbortController(),
      context = apiContext(),
      body = sourceConnection(draft)
    probe.value = { key: '', pending: true }
    const timer = setTimeout(async () => {
      const current = () => !controller.signal.aborted && isCurrentApi(context)
      try {
        const result = await api<{ status: string; serverVersion?: string }>(
          '/api/sources/probe',
          { method: 'POST', body: JSON.stringify(body), signal: controller.signal },
          context,
        )
        if (!current()) return
        if (result.status !== 'online' || !result.serverVersion)
          throw new Error(t('app.connectionVersionMissing'))
        probe.value = { key, pending: false, version: result.serverVersion }
      } catch (reason) {
        if (current()) probe.value = { key: '', pending: false, error: errorMessage(reason) }
      }
    }, PROBE_DELAY_MS)
    onCleanup(() => {
      clearTimeout(timer)
      controller.abort()
    })
  },
  { immediate: true },
)
async function submit() {
  if (!ready.value || !draft.name.trim()) return
  const saved = await run(async () => {
    const { id, ...body } = {
      ...draft,
      name: draft.name.trim(),
      target: draft.target?.trim(),
      herdrSession: draft.herdrSession?.trim() || '',
      herdrSocket: draft.herdrSocket?.trim() || '',
    }
    if (body.transport === 'ssh' && !body.target) throw new Error(t('app.sshRequired'))
    if (id) await write(`/api/sources/${segment(id)}`, 'PATCH', { id, ...body })
    else await write('/api/sources', 'POST', body)
    await workspace.reload()
  })
  if (!saved) return
  notify.success(t('app.connectionSaved'))
  emit('close', true)
}
const runtimes = [
  { label: 'Herdr TUI', value: 'tui' },
  { label: 'Herdr Core / App', value: 'core' },
]
const transports = computed(() => [
  { label: t('app.local'), value: 'local', icon: 'i-lucide-server', disabled: busy.value },
  { label: t('app.remoteSsh'), value: 'ssh', icon: 'i-lucide-globe', disabled: busy.value },
])
const probeText = computed(() =>
  probe.value.pending
    ? t('app.checkingConnection')
    : probe.value.error
      ? t('app.connectionProbeFailed')
      : probe.value.version
        ? `${draft.runtime === 'core' ? 'herdr-core' : 'herdr'} ${probe.value.version}`
        : '',
)
</script>

<template>
  <UModal
    :title="t(draft.id ? 'app.editConnection' : 'app.addConnection')"
    :dismissible="!busy"
    :close="{ disabled: busy }"
    :ui="{ content: 'source-modal [--dialog-width:30rem]' }"
  >
    <template #body>
      <UForm :id="formId" :disabled="busy" class="flex flex-col gap-4" @submit="submit">
        <UFormField :label="t('app.connectionName')" required
          ><UInput
            v-model="draft.name"
            name="sourceName"
            :placeholder="t('app.connectionNamePlaceholder')"
            class="w-full"
        /></UFormField>
        <UFormField :label="t('app.runtime')"
          ><USelect v-model="draft.runtime" name="runtime" :items="runtimes" class="w-full"
        /></UFormField>
        <UTabs
          v-model="draft.transport"
          :items="transports"
          :content="false"
          color="neutral"
          variant="pill"
          class="w-full"
        />
        <UFormField v-if="draft.transport === 'ssh'" :label="t('app.sshAddress')" required
          ><UInput
            v-model="draft.target"
            name="target"
            placeholder="ssh://user@hostname:22"
            class="w-full"
        /></UFormField>
        <UFormField :label="t('app.session')" :hint="t('app.optional')"
          ><UInput
            v-model="draft.herdrSession"
            name="herdrSession"
            placeholder="default"
            class="w-full"
        /></UFormField>
        <!-- Collapsed fields stay mounted: they belong to the form and keep their values reachable. -->
        <UCollapsible :unmount-on-hide="false" :disabled="busy" class="flex flex-col gap-4">
          <UButton
            type="button"
            color="neutral"
            variant="ghost"
            trailing-icon="i-lucide-chevron-down"
            class="group self-start"
            :ui="{
              trailingIcon:
                'group-data-[state=open]:rotate-180 transition-transform duration-200 motion-reduce:transition-none',
            }"
            >{{ t('app.advanced') }}</UButton
          >
          <template #content>
            <div class="flex flex-col gap-4">
              <template v-if="draft.transport === 'ssh'">
                <UFormField :label="t('app.sshIdentity')" :hint="t('app.optional')"
                  ><UInput
                    v-model="draft.sshIdentityFile"
                    name="sshIdentityFile"
                    placeholder="/path/to/id_ed25519"
                    class="w-full"
                /></UFormField>
                <UFormField :label="t('app.sshKnownHosts')" :hint="t('app.optional')"
                  ><UInput
                    v-model="draft.sshKnownHostsFile"
                    name="sshKnownHostsFile"
                    placeholder="/path/to/known_hosts"
                    class="w-full"
                /></UFormField>
              </template>
              <UFormField :label="t('app.socketPath')" :hint="t('app.optional')"
                ><UInput
                  v-model="draft.herdrSocket"
                  name="herdrSocket"
                  :placeholder="
                    draft.runtime === 'core' ? '/path/to/default.sock' : '/path/to/herdr.sock'
                  "
                  class="w-full"
              /></UFormField>
            </div>
          </template>
        </UCollapsible>
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
      <div
        class="source-probe-status flex min-w-0 flex-1 items-center gap-1.5 text-xs"
        :class="probe.error ? 'text-error' : 'text-muted'"
        role="status"
      >
        <UIcon
          v-if="probe.pending"
          name="i-lucide-loader-circle"
          class="size-3.5 shrink-0 motion-safe:animate-spin"
        />
        <span class="truncate" :title="probe.error || probe.version">{{ probeText }}</span>
        <UButton
          v-if="probe.error"
          type="button"
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-refresh-cw"
          :disabled="busy"
          :aria-label="t('common.retry')"
          :title="t('common.retry')"
          @click="retries++"
        />
      </div>
      <UButton color="neutral" variant="outline" :disabled="busy" @click="emit('close', false)">{{
        t('common.cancel')
      }}</UButton>
      <UButton
        type="submit"
        :form="formId"
        :loading="busy"
        :disabled="!ready || !draft.name.trim()"
        >{{ t('common.save') }}</UButton
      >
    </template>
  </UModal>
</template>
