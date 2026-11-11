<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import UAlert from '@nuxt/ui/components/Alert.vue'
import UModal from '../components/CanvasModal.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UInput from '@nuxt/ui/components/Input.vue'
import UFormField from '@nuxt/ui/components/FormField.vue'
import {
  activeInstance,
  importInstance,
  instances,
  removeInstance,
  saveInstance,
  selectInstance,
} from './instances'
import InstanceQrScanner from './InstanceQrScanner.vue'
import { instanceBuild, observeInstanceBuild } from './instance-builds'
import { buildLabel } from '../../../shared/build-info'
import { useInstanceProbe } from './instance-probe'
import { normalizeApiBase, parseInstanceLink, type InstanceLink } from './instance-url'
import { usePointerDismiss } from '../lib/pointer-dismiss'

const props = defineProps<{
  beforeChange?: () => Promise<boolean>
  disabled?: boolean
  username?: string
}>()
const emit = defineEmits<{ connect: []; account: []; signOut: [] }>()
const { t } = useI18n()
const currentBuild = computed(() => instanceBuild(activeInstance.value))
const open = ref(false),
  working = ref(false),
  error = ref('')
const scanning = ref(false),
  scanned = ref<InstanceLink>()
function rescan() {
  scanned.value = undefined
  scanning.value = true
}
const menuOpen = defineModel<boolean>('menuOpen', { default: false }),
  menuTrigger = ref<InstanceType<typeof UButton>>()
const menuDismiss = usePointerDismiss(menuOpen, menuTrigger, {
  // Reka owns the whole menu tree, including portalled submenus. Only canvas
  // gestures need capture dismissal because they can stop native bubbling.
  outside: (event) =>
    event.target instanceof Element && !!event.target.closest('.graph-wrap, .focus-overlay'),
})
const draft = reactive({ id: '', name: '', base: '' })
const draftBuild = computed(() => (draft.id ? instanceBuild(draft) : undefined))
const original = computed(() => instances.value.find((instance) => instance.id === draft.id))
const needsProbe = computed(() => {
  try {
    return !original.value || original.value.base !== normalizeApiBase(draft.base)
  } catch {
    return true
  }
})
const probe = useInstanceProbe(
  () => draft.base,
  () => open.value && needsProbe.value,
)
const canSubmit = computed(
  () =>
    open.value &&
    !scanning.value &&
    !!draft.name.trim() &&
    !!probe.base.value &&
    (!needsProbe.value || probe.ready.value),
)
const displayedBuild = computed(() =>
  needsProbe.value ? probe.result.value?.build : draftBuild.value?.build,
)
watch(
  open,
  (value) => {
    if (!value) {
      scanning.value = false
      scanned.value = undefined
    }
  },
  { flush: 'sync' },
)
watch(
  () => `${activeInstance.value.id}:${activeInstance.value.base}`,
  () => {
    open.value = false
  },
  { flush: 'sync' },
)
watch([canSubmit, scanned], ([ready, details]) => {
  if (ready && details) void submit()
})
async function change(action: () => void) {
  if (working.value || props.disabled) return
  working.value = true
  try {
    if (!props.beforeChange || (await props.beforeChange())) action()
  } finally {
    working.value = false
  }
}
function edit(add = false) {
  const { id, name, base } = activeInstance.value
  Object.assign(draft, add ? { id: '', name: '', base: '' } : { id, name, base })
  error.value = ''
  scanned.value = undefined
  open.value = true
}
function editField(field: 'name' | 'base', value: string | number) {
  scanned.value = undefined
  error.value = ''
  draft[field] = String(value)
}
function scan(text: string): boolean {
  if (!open.value || working.value || draft.id) return false
  try {
    const parsed = parseInstanceLink(text)
    if (!parsed?.server || parsed.invalid) return false
    scanned.value = parsed.server
    draft.name =
      instances.value.find((instance) => instance.base === parsed.server!.base)?.name ||
      parsed.server.name
    draft.base = parsed.server.base
    error.value = ''
    scanning.value = false
    if (probe.failed.value) probe.retry()
    return true
  } catch {
    return false
  }
}
async function submit() {
  if (!canSubmit.value) return
  const details = scanned.value,
    submitted = { ...draft }
  error.value = ''
  try {
    await change(() => {
      if (
        !canSubmit.value ||
        scanned.value !== details ||
        submitted.id !== draft.id ||
        submitted.name !== draft.name ||
        submitted.base !== draft.base
      )
        return
      const build = probe.result.value?.build
      const instance = details ? importInstance(details) : saveInstance(submitted)
      if (build) observeInstanceBuild(instance, build)
      open.value = false
      if (details) emit('connect')
    })
  } catch (reason) {
    error.value =
      reason instanceof Error && reason.message.startsWith('instances.')
        ? reason.message
        : 'instances.invalidUrl'
  }
}
const instanceItems = computed<DropdownMenuItem[][]>(() => [
  instances.value.map((instance) => ({
    label: instance.name,
    type: 'checkbox' as const,
    server: instanceBuild(instance),
    checked: instance.id === activeInstance.value.id,
    onSelect: (): void => {
      void change(() => selectInstance(instance.id))
    },
  })),
  [
    { label: t('instances.add'), onSelect: () => edit(true) },
    { label: t('instances.edit'), onSelect: () => edit() },
    {
      label: t('instances.remove'),
      disabled: !!activeInstance.value.builtin,
      onSelect: (): void => {
        void change(() => removeInstance(activeInstance.value.id))
      },
    },
  ],
])
const items = computed<DropdownMenuItem[][]>(() =>
  props.username === undefined
    ? instanceItems.value
    : [
        [
          {
            label: t('account.settings'),
            icon: 'i-lucide-user-round',
            onSelect: () => emit('account'),
          },
          {
            label: activeInstance.value.name,
            icon: 'i-lucide-server',
            children: instanceItems.value,
            content: { collisionPadding: 12 },
            ui: { content: 'instance-menu' },
          },
        ],
        [
          {
            label: t('account.signOutInstance'),
            icon: 'i-lucide-log-out',
            color: 'error',
            onSelect: () => emit('signOut'),
          },
        ],
      ],
)
</script>

<template>
  <UDropdownMenu
    v-model:open="menuOpen"
    :modal="false"
    :items="items"
    :content="{ side: 'top', align: 'start', sideOffset: 6, ...menuDismiss }"
    :ui="{ content: username === undefined ? 'instance-menu' : 'instance-menu account-menu' }"
  >
    <template #item-label="{ item }">
      <span class="flex min-w-0 items-center gap-2.5"
        ><span class="truncate">{{ item.label }}</span
        ><span
          v-if="item.server"
          class="max-w-[60%] flex-none truncate text-xs font-normal"
          :class="item.server.fresh ? 'text-muted' : 'text-dimmed'"
          :title="`${t('instances.serverVersion')}: ${item.server.build.version}${item.server.build.revision ? ` · ${item.server.build.revision}` : ''}${!item.server.fresh ? ` · ${t('instances.lastSeen')}` : ''}`"
          >{{ buildLabel(item.server.build)
          }}<span v-if="!item.server.fresh"> · {{ t('instances.lastSeen') }}</span></span
        ></span
      >
    </template>
    <UButton
      v-if="username !== undefined"
      ref="menuTrigger"
      color="neutral"
      variant="ghost"
      class="sidebar-account"
      :active="menuOpen"
      :disabled="disabled || working"
      :aria-busy="working"
      :title="`${username} · ${activeInstance.name}`"
      :aria-label="`${t('account.title')}: ${username}`"
    >
      <span class="avatar" aria-hidden="true">{{ username.slice(0, 1).toUpperCase() || 'C' }}</span>
      <span
        >{{ username }}<small>{{ activeInstance.name }}</small></span
      >
    </UButton>
    <UButton
      v-else
      ref="menuTrigger"
      color="neutral"
      variant="outline"
      size="lg"
      block
      icon="i-lucide-server"
      trailing-icon="i-lucide-chevron-down"
      class="instance-trigger mb-3 justify-start"
      :disabled="disabled || working"
      :aria-busy="working"
      :title="activeInstance.base"
      :aria-label="`${t('instances.instance')}: ${activeInstance.name}`"
    >
      <span class="min-w-0 flex-1 truncate text-left">{{ activeInstance.name }}</span
      ><span
        v-if="currentBuild"
        class="max-w-[50%] flex-none truncate text-xs font-normal text-muted tabular-nums"
        :title="`${t('instances.serverVersion')}: ${currentBuild.build.version}${currentBuild.fresh ? '' : ` · ${t('instances.lastSeen')}`}`"
        >{{ currentBuild.build.version }}</span
      >
    </UButton>
  </UDropdownMenu>
  <UModal
    v-if="open"
    v-model:open="open"
    :title="t(draft.id ? 'instances.edit' : 'instances.add')"
    :ui="{ content: 'instance-dialog [--dialog-width:420px]' }"
  >
    <template #body>
      <form id="instance-form" class="flex flex-col gap-4" @submit.prevent="submit">
        <UFormField :label="t('instances.name')" name="name" required
          ><UInput
            :model-value="draft.name"
            autofocus
            maxlength="80"
            class="w-full"
            :disabled="working"
            @update:model-value="(value: string | number) => editField('name', value)"
        /></UFormField>
        <UFormField :label="t('instances.address')" name="address" required
          ><UInput
            :model-value="draft.base"
            type="url"
            placeholder="https://canvas.example/"
            autocomplete="url"
            class="w-full"
            :readonly="!!original?.builtin"
            :disabled="working"
            @update:model-value="(value: string | number) => editField('base', value)"
        /></UFormField>
        <dl
          v-if="draftBuild"
          class="instance-build-detail m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs text-muted"
        >
          <dt>{{ t('instances.serverVersion') }}</dt>
          <dd class="m-0 text-default [overflow-wrap:anywhere]">
            {{ buildLabel(draftBuild.build)
            }}<span v-if="!draftBuild.fresh" class="ms-1.5 text-muted">{{
              t('instances.lastSeen')
            }}</span>
          </dd>
          <template v-if="draftBuild.build.revision"
            ><dt>{{ t('instances.revision') }}</dt>
            <dd class="instance-revision m-0 font-mono text-default [overflow-wrap:anywhere]">
              {{ draftBuild.build.revision }}
            </dd></template
          >
        </dl>
        <UAlert v-if="error" color="error" variant="subtle" :title="t(error)" role="alert" />
      </form>
    </template>
    <template #footer
      ><span class="instance-probe-status min-w-0 flex-1 truncate text-xs text-muted" role="status"
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
          v-else-if="displayedBuild"
          :title="`${t('instances.serverVersion')}: ${displayedBuild.version}${displayedBuild.revision ? ` · ${displayedBuild.revision}` : ''}`"
          >{{ buildLabel(displayedBuild) }}</span
        ></span
      ><UButton
        v-if="!draft.id"
        type="button"
        color="neutral"
        variant="ghost"
        square
        icon="i-lucide-scan-qr-code"
        class="instance-add-scan"
        :disabled="working"
        :title="t('instances.scanQr')"
        :aria-label="t('instances.scanQr')"
        @click="rescan"
      /><UButton type="submit" form="instance-form" :loading="working" :disabled="!canSubmit">{{
        t(draft.id ? 'common.save' : 'instances.connect')
      }}</UButton></template
    >
  </UModal>
  <InstanceQrScanner :open="open && scanning" :accept="scan" @close="scanning = false" />
</template>

<style>
.instance-menu {
  min-width: min(200px, calc(var(--mobile-width, var(--ui-viewport-width)) - 24px));
  max-width: min(320px, calc(var(--mobile-width, var(--ui-viewport-width)) - 24px));
}
</style>
