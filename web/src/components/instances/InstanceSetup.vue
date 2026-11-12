<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import InstanceQrScanner from './InstanceQrScanner.vue'
import { activeInstance, importInstance, instances } from '../../composables/instances/instances'
import { parseInstanceLink, type InstanceLink } from '../../utils/instances/instance-url'
import { useInstanceProbe } from '../../composables/instances/instance-probe'
import { observeInstanceBuild } from '../../composables/instances/instance-builds'
import { buildLabel } from '../../../../shared/build-info'

const props = defineProps<{ message?: string }>()
const emit = defineEmits<{ connect: [] }>()
const { t } = useI18n()
const address = ref(''),
  invalid = ref(false),
  scanning = ref(false),
  scanned = ref<InstanceLink>()
const probe = useInstanceProbe(address)
watch(
  activeInstance,
  (instance) => {
    address.value = instances.value.length ? instance.base : ''
    invalid.value = false
  },
  { immediate: true },
)
watch(probe.result, (result) => {
  if (result && scanned.value?.base === result.base) connect()
})
function editAddress(value: string | number) {
  scanned.value = undefined
  invalid.value = false
  address.value = String(value)
}
function scan(text: string): boolean {
  try {
    const parsed = parseInstanceLink(text)
    if (!parsed?.server || parsed.invalid) return false
    scanned.value = parsed.server
    address.value = parsed.server.base
    invalid.value = false
    scanning.value = false
    if (probe.ready.value) connect()
    else if (probe.failed.value) probe.retry()
    return true
  } catch {
    return false
  }
}
function connect() {
  if (!probe.ready.value || !probe.result.value) return
  try {
    const result = probe.result.value
    const details = scanned.value?.base === result.base ? scanned.value : undefined
    const instance = importInstance({
      base: result.base,
      name: details?.name,
      username: details?.username,
    })
    scanned.value = undefined
    observeInstanceBuild(instance, result.build)
    invalid.value = false
    emit('connect')
  } catch {
    invalid.value = true
  }
}
</script>

<template>
  <form class="instance-setup mt-4 flex flex-col gap-4" @submit.prevent="connect">
    <UFormField
      :label="t('instances.address')"
      name="server"
      :error="invalid ? t('instances.invalidUrl') : undefined"
    >
      <UInput
        :model-value="address"
        type="url"
        placeholder="https://canvas.example/"
        autocomplete="url"
        autofocus
        size="lg"
        class="w-full"
        @update:model-value="editAddress"
      />
    </UFormField>
    <p
      v-if="props.message && !invalid && !probe.base.value"
      class="instance-setup-message m-0 text-sm text-muted"
      role="status"
    >
      {{ props.message }}
    </p>
    <div class="flex min-w-0 items-center gap-3">
      <UButton type="submit" size="lg" :disabled="!probe.ready.value">{{
        t('instances.connect')
      }}</UButton
      ><span
        class="instance-probe-status min-w-0 flex-1 truncate text-right text-xs text-muted"
        role="status"
        ><template v-if="probe.pending.value">{{ t('instances.probing') }}</template
        ><UButton
          v-else-if="probe.failed.value"
          color="neutral"
          variant="link"
          size="xs"
          class="p-0"
          @click="probe.retry"
          >{{ t('instances.probeFailed') }} · {{ t('instances.retry') }}</UButton
        ><span
          v-else-if="probe.result.value"
          :title="`${t('instances.serverVersion')}: ${probe.result.value.build.version}${probe.result.value.build.revision ? ` · ${probe.result.value.build.revision}` : ''}`"
          >{{ buildLabel(probe.result.value.build) }}</span
        ></span
      ><UButton
        type="button"
        color="neutral"
        variant="ghost"
        size="lg"
        square
        icon="i-lucide-scan-qr-code"
        class="instance-scan-button"
        :title="t('instances.scanQr')"
        :aria-label="t('instances.scanQr')"
        @click="scanning = true"
      />
    </div>
  </form>
  <InstanceQrScanner :open="scanning" :accept="scan" @close="scanning = false" />
</template>
