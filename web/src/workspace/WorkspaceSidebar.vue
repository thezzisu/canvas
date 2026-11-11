<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createReusableTemplate } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import USlideover from '@nuxt/ui/components/Slideover.vue'
import { apiRevision } from '../api/api'
import BrandMark from '../app/BrandMark.vue'
import { useCanvasScene } from '../canvas/scene/scene'
import InstancePicker from '../instances/InstancePicker.vue'
import { activeInstanceId } from '../instances/instances'
import { notify } from '../lib/notify'
import { contentFontReady } from '../settings/content-font'
import type { Source } from '../api/types'
import { canvasAgents } from './canvas-agents'
import { connectionIndicator } from './canvas-status'
import CanvasNavItem from './CanvasNavItem.vue'
import { editCanvasName, editSource } from './dialogs'
import SidebarList from './SidebarList.vue'
import './sidebar.css'

// Where to go: the working set, every canvas, and the connections behind them.
const { t } = useI18n()
const [DefineNavigation, ReuseNavigation] = createReusableTemplate()
const scene = useCanvasScene()
const { workspace, session, shell, view } = scene
const current = scene.route.canvasId
const hidden = computed(() => (contentFontReady.value && shell.cardMaximized) || undefined)

/** One agent list is open at a time. */
const openAgents = ref('')
const agentList = (key: string) => ({
  open: openAgents.value === key,
  'onUpdate:open': (open: boolean) => {
    if (open) openAgents.value = key
    else if (openAgents.value === key) openAgents.value = ''
  },
})
watch([current, apiRevision, () => shell.sidebarDrawer], () => {
  openAgents.value = ''
})
watch(
  () => shell.sidebarOpen,
  (open) => {
    if (!open) openAgents.value = ''
    else scene.menus.display.value = scene.menus.canvas.value = scene.menus.create.value = false
  },
)
watch([scene.menus.display, scene.menus.canvas, scene.menus.create], (menus) => {
  if (menus.some(Boolean)) shell.sidebarOpen = false
})

const resourceOf = (source: Source) => workspace.resources.find((item) => item.id === source.id)
function sourceTitle(source: Source) {
  const version = resourceOf(source)?.serverVersion
  const address =
    source.transport === 'local' ? t('app.local') : source.target?.replace(/^ssh:\/\//, '')
  return `${source.name} · ${address}${version ? ` · herdr ${version}` : ''}`
}
function showSource(id: string) {
  shell.connectionsOpen = false
  void scene.visit('overview', { fitNodeId: `source:${id}` })
}
async function newCanvas() {
  shell.sidebarOpen = false
  const created = await editCanvasName()
  if (created) void scene.visit(created)
}
function addConnection() {
  shell.sidebarOpen = false
  void editSource()
}
</script>

<template>
  <DefineNavigation>
    <div class="sidebar-navigation">
      <div class="nav-section-label">
        <span>{{ t('app.features') }}</span>
      </div>
      <nav class="feature-nav" :aria-label="t('app.features')">
        <CanvasNavItem
          class="feature-nav-item"
          icon="i-lucide-clock-fading"
          :fresh="workspace.freshStatuses"
          :name="t('app.workingSet')"
          :active="current === 'working-set'"
          :indicator="workspace.workingSetIndicator"
          v-bind="agentList('working-set')"
          :agents="() => workspace.workingSetEntries"
          :actions-available="scene.reveal.available.value"
          @go="scene.reveal.goToWindow"
          @select="scene.visit('working-set')"
        />
      </nav>
      <div class="sidebar-divider" role="separator" />
      <div class="nav-section-label">
        <span>{{ t('app.canvases') }}</span>
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          size="xs"
          :title="t('app.newCanvas')"
          :aria-label="t('app.newCanvas')"
          @click="newCanvas"
        />
      </div>
      <nav class="canvas-nav" :aria-label="t('app.canvases')">
        <CanvasNavItem
          class="canvas-nav-item"
          icon="i-lucide-layout-grid"
          :fresh="workspace.freshStatuses"
          :name="t('app.overview')"
          :active="current === 'overview'"
          :indicator="workspace.indicators.overview"
          v-bind="agentList('overview')"
          :agents="() => canvasAgents(undefined, workspace.resources, view.order)"
          :actions-available="scene.reveal.available.value"
          @go="(target) => scene.reveal.goTo('overview', target)"
          @select="scene.visit('overview')"
        />
        <SidebarList
          :key="activeInstanceId"
          :items="workspace.orderedCanvases"
          @reorder="(ids) => workspace.rememberSidebarOrder('canvases', ids)"
        >
          <template #default="{ item: canvas, hint }">
            <CanvasNavItem
              class="canvas-nav-item"
              icon="i-lucide-panels-top-left"
              :fresh="workspace.freshStatuses"
              :name="canvas.name"
              :active="current === canvas.id"
              :indicator="workspace.indicators[canvas.id]"
              v-bind="agentList(canvas.id)"
              :agents="() => canvasAgents(canvas, workspace.resources, view.order)"
              :actions-available="scene.reveal.available.value"
              :aria-description="hint"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              @go="(target) => scene.reveal.goTo(canvas.id, target)"
              @select="scene.visit(canvas.id)"
            />
          </template>
        </SidebarList>
      </nav>
      <div class="sidebar-divider" role="separator" />
      <div class="nav-section-label">
        <span>{{ t('app.connections') }}</span>
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="ghost"
          size="xs"
          :title="t('app.addConnection')"
          :aria-label="t('app.addConnection')"
          @click="addConnection"
        />
      </div>
      <div class="source-nav">
        <SidebarList
          :key="activeInstanceId"
          :items="workspace.orderedSources"
          @reorder="(ids) => workspace.rememberSidebarOrder('sources', ids)"
        >
          <template #default="{ item: source, hint }">
            <CanvasNavItem
              class="source-nav-item"
              icon="i-lucide-server"
              :fresh="workspace.freshStatuses"
              :name="source.name"
              :title="sourceTitle(source)"
              v-bind="{
                ...connectionIndicator(resourceOf(source), t('terminal.connection.connecting')),
                ...agentList(`source:${source.id}`),
              }"
              :agents="
                () =>
                  canvasAgents(
                    undefined,
                    workspace.resources.filter((item) => item.id === source.id),
                    view.order,
                  )
              "
              :actions-available="scene.reveal.available.value"
              :aria-description="hint"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              @go="(target) => scene.reveal.goTo('overview', target)"
              @select="showSource(source.id)"
            />
          </template>
        </SidebarList>
      </div>
    </div>
    <div class="sidebar-footer">
      <InstancePicker
        v-model:menu-open="shell.accountMenuOpen"
        :username="session.username"
        :before-change="session.canLeave"
        @account="shell.accountOpen = true"
        @sign-out="session.logout().catch(notify.error)"
      />
      <UButton
        class="sidebar-settings"
        icon="i-lucide-settings"
        color="neutral"
        variant="ghost"
        :size="shell.mobile ? 'xl' : 'sm'"
        :title="t('common.settings')"
        :aria-label="t('common.settings')"
        :disabled="!workspace.settings"
        @click="scene.dialogs.settings"
      />
    </div>
  </DefineNavigation>
  <!-- A drawer on small screens and beside a fullscreen canvas; a fixed column otherwise. -->
  <USlideover
    v-if="shell.sidebarDrawer"
    v-model:open="shell.sidebarOpen"
    side="left"
    :title="t('app.canvases')"
    :description="t('app.openCanvasList')"
    :ui="{
      overlay: 'top-[var(--window-controls-height)]',
      content:
        'top-[var(--window-controls-height)] w-[min(280px,calc(var(--ui-viewport-width)*0.85))]',
    }"
  >
    <template #content>
      <aside id="canvas-sidebar" class="sidebar sidebar-open">
        <BrandMark :size="24">
          <UButton
            class="sidebar-close ms-auto"
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xl"
            :aria-label="t('app.closeCanvasList')"
            @click="shell.sidebarOpen = false"
          />
        </BrandMark>
        <ReuseNavigation />
      </aside>
    </template>
  </USlideover>
  <aside v-else id="canvas-sidebar" class="sidebar" :inert="hidden" :aria-hidden="hidden">
    <ReuseNavigation />
  </aside>
</template>
