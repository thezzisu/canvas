<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import { activeInstance, importInstance, instances } from '../instances'
import { useInstanceProbe } from '../instance-probe'
import { observeInstanceBuild } from '../instance-builds'
import { buildLabel } from '../../../shared/build-info'

const props = defineProps<{ message?: string }>()
const emit = defineEmits<{ connect: [] }>()
const { t } = useI18n()
const address = ref(''), invalid = ref(false)
const probe = useInstanceProbe(address)
watch(activeInstance, instance => { address.value = instances.value.length ? instance.base : ''; invalid.value = false }, { immediate: true })
function connect() {
  if (!probe.ready.value || !probe.result.value) return
  try { const result = probe.result.value; const instance = importInstance({ base: result.base }); observeInstanceBuild(instance, result.build); invalid.value = false; emit('connect') }
  catch { invalid.value = true }
}
</script>

<template>
  <form class="instance-setup" @submit.prevent="connect">
    <UFormField :label="t('instances.address')" name="server" :error="invalid ? t('instances.invalidUrl') : undefined">
      <UInput v-model="address" type="url" placeholder="https://canvas.example/" autocomplete="url" autofocus class="w-full" />
    </UFormField>
    <p v-if="props.message && !invalid" class="instance-setup-message" role="status">{{ props.message }}</p>
    <div class="instance-probe-footer"><UButton type="submit" class="button primary" size="lg" :disabled="!probe.ready.value">{{ t('instances.connect') }}</UButton><span class="instance-probe-status" role="status"><span v-if="probe.pending.value">{{ t('instances.probing') }}</span><button v-else-if="probe.failed.value" type="button" @click="probe.retry">{{ t('instances.probeFailed') }} · {{ t('instances.retry') }}</button><span v-else-if="probe.result.value" :title="`${t('instances.serverVersion')}: ${probe.result.value.build.version}${probe.result.value.build.revision ? ` · ${probe.result.value.build.revision}` : ''}`">{{ buildLabel(probe.result.value.build) }}</span></span></div>
  </form>
</template>

<style>
.instance-setup{display:flex;flex-direction:column;gap:18px;margin-top:16px}.instance-setup label{margin:0;font-size:11px}.instance-setup input{margin:0;font-size:13px}.instance-setup .button{height:43px}.instance-setup-message{margin:0;font-size:12px;line-height:1.5;color:#909aa9}
</style>
