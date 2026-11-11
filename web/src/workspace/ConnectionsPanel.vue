<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UCollapsible from '@nuxt/ui/components/Collapsible.vue'
import UIcon from '@nuxt/ui/components/Icon.vue'
import USlideover from '@nuxt/ui/components/Slideover.vue'
import { write, segment } from '../api/api'
import { useCanvasScene } from '../canvas/scene/scene'
import { usePointerDismiss } from '../lib/pointer-dismiss'
import { statusColor, statusLabel } from '../lib/status'
import type { Source, SourceResource, TerminalCanvasNode } from '../api/types'
import { needsAttention } from './canvas-status'
import { confirmAction, editSource } from './dialogs'
import WindowTitle from './WindowTitle.vue'

// Every connection with its spaces and windows, and the native operations on them.
const { t } = useI18n()
const scene = useCanvasScene()
const { workspace, shell } = scene
const expanded = ref('')
// Canvas and terminal gestures stop pointer events before the panel's own outside listener.
const dismiss = usePointerDismiss(
  computed({
    get: () => shell.connectionsOpen && !shell.modalOpen,
    set: (open) => {
      shell.connectionsOpen = open
    },
  }),
  () => document.querySelector<HTMLElement>('.connections-panel'),
)
const resourceOf = (source: Source) => workspace.resources.find((item) => item.id === source.id)
const runtime = (source: Source) => (source.runtime === 'core' ? 'herdr-core' : 'herdr')
const online = (resource?: SourceResource) => resource?.status === 'online' && !resource.error
/** A window that has no card here, addressed as the canvas node it would be. */
const windowRef = (sourceId: string, spaceId: string, windowId: string): TerminalCanvasNode => ({
  type: 'terminal',
  id: '',
  sourceId,
  spaceId,
  windowId,
  x: 0,
  y: 0,
  ...workspace.windowSize({ sourceId, windowId }),
})
function removeSource(source: Source) {
  void confirmAction({
    title: t('app.removeNamed', { name: source.name }),
    description: t('app.removeConnectionDescription'),
    danger: true,
    button: t('app.removeConnection'),
    submit: async () => {
      await write(`/api/sources/${segment(source.id)}`, 'DELETE')
      await workspace.reload()
    },
  })
}
</script>

<template>
  <USlideover
    v-model:open="shell.connectionsOpen"
    :title="t('app.connectionsWindows')"
    :modal="false"
    :overlay="false"
    :content="{ ...dismiss, onFocusOutside: (event: Event) => event.preventDefault() }"
    :ui="{
      content: 'connections-panel w-[min(380px,var(--ui-viewport-width))]',
      body: 'flex flex-col gap-3',
    }"
  >
    <template #body>
      <UButton icon="i-lucide-plus" block @click="editSource()">{{
        t('app.addConnection')
      }}</UButton>
      <p v-if="!workspace.state" class="py-6 text-center text-xs text-muted" role="status">
        {{ t(workspace.loadFailure ? 'app.loadFailed' : 'common.loading') }}
      </p>
      <UCollapsible
        v-for="source in workspace.orderedSources"
        :key="source.id"
        :open="expanded === source.id"
        class="source-detail rounded-md border border-default"
        @update:open="expanded = $event ? source.id : ''"
      >
        <div class="flex items-center gap-1 p-1">
          <UButton
            class="source-expand min-w-0 flex-1 justify-start text-left"
            color="neutral"
            variant="ghost"
            :icon="expanded === source.id ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            :aria-expanded="expanded === source.id"
          >
            <span class="flex min-w-0 flex-col">
              <span class="truncate">{{ source.name }}</span>
              <span class="flex min-w-0 gap-2 text-xs font-normal text-muted">
                <span class="source-address truncate">
                  {{ source.transport === 'local' ? t('app.local') : source.target }}
                </span>
                <span
                  v-if="resourceOf(source)?.serverVersion"
                  class="source-version flex-none"
                  :title="`${runtime(source)} ${resourceOf(source)!.serverVersion}`"
                >
                  {{ runtime(source) }} {{ resourceOf(source)!.serverVersion }}
                </span>
              </span>
            </span>
          </UButton>
          <UButton
            icon="i-lucide-pencil"
            color="neutral"
            variant="ghost"
            size="sm"
            :title="t('app.editConnection')"
            :aria-label="t('app.editConnection')"
            @click.stop="editSource(source)"
          />
          <UButton
            icon="i-lucide-trash"
            color="neutral"
            variant="ghost"
            size="sm"
            :title="t('app.removeConnection')"
            :aria-label="t('app.removeConnection')"
            @click.stop="removeSource(source)"
          />
        </div>
        <template #content>
          <div class="flex flex-col gap-2 border-t border-default p-2">
            <p
              v-if="workspace.undiscoveredSources.some((item) => item.id === source.id)"
              class="py-3 text-center text-xs text-muted"
              role="status"
            >
              {{ t(workspace.loadFailure ? 'app.loadFailed' : 'common.loading') }}
            </p>
            <p v-else-if="resourceOf(source)?.error" class="source-error text-xs text-error">
              {{ resourceOf(source)!.error }}
            </p>
            <section
              v-for="space in resourceOf(source)?.spaces || []"
              :key="space.id"
              class="space-detail"
            >
              <header class="flex items-center gap-1">
                <UIcon name="i-lucide-layers" class="size-3.5 flex-none text-muted" />
                <strong class="min-w-0 flex-1 truncate text-sm font-medium">{{
                  space.name
                }}</strong>
                <UButton
                  icon="i-lucide-square-plus"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="t('app.newWindow')"
                  :aria-label="t('app.newWindow')"
                  @click="scene.windows.createTab(source.id, space.id)"
                />
                <UButton
                  icon="i-lucide-pencil"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="t('app.renameSpace')"
                  :aria-label="t('app.renameSpace')"
                  @click="scene.windows.editSpace(resourceOf(source)!, space.id, 'rename')"
                />
                <UButton
                  icon="i-lucide-x"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="t('app.closeSpace')"
                  :aria-label="t('app.closeSpace')"
                  @click="scene.windows.editSpace(resourceOf(source)!, space.id, 'close')"
                />
              </header>
              <div
                v-for="window in space.windows"
                :key="window.id"
                class="window-detail flex items-center gap-2 ps-5"
              >
                <span
                  class="program-dot flex-none"
                  :data-status-pulse="
                    workspace.freshStatuses &&
                    online(resourceOf(source)) &&
                    needsAttention(window.status)
                  "
                  :style="{ '--program-color': statusColor(window.status) }"
                  :title="statusLabel(window.status)"
                />
                <WindowTitle :window="window" class="min-w-0 flex-1 text-sm" />
                <UButton
                  icon="i-lucide-layers"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="t('app.addToCanvas')"
                  :aria-label="t('app.addToCanvas')"
                  @click="scene.cards.addToCanvas(windowRef(source.id, space.id, window.id))"
                />
                <UButton
                  icon="i-lucide-ellipsis"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :title="t('app.windowActions')"
                  :aria-label="t('app.windowActions')"
                  @click="scene.cards.windowMenu(windowRef(source.id, space.id, window.id))"
                />
              </div>
            </section>
            <UButton
              class="source-new-space self-start"
              icon="i-lucide-plus"
              color="neutral"
              variant="ghost"
              size="sm"
              :disabled="!resourceOf(source) || !!resourceOf(source)!.error"
              @click="scene.windows.createSpace(source.id)"
            >
              {{ t('app.newSpace') }}
            </UButton>
          </div>
        </template>
      </UCollapsible>
    </template>
  </USlideover>
</template>
