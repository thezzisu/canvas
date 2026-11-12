<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import UButton from '@nuxt/ui/components/Button.vue'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import BrandMark from '../BrandMark.vue'
import SaveStatus from '../SaveStatus.vue'
import { segment, write } from '../../api/api'
import { usePointerDismiss } from '../../composables/pointer-dismiss'
import { contentFontReady } from '../../composables/settings/content-font'
import { confirmAction, editCanvasName, editSource } from '../../composables/workspace/dialogs'
import { layoutOwner } from '../../stores/edits'
import { isTerminalNode } from '../../api/types'
import type CanvasFileDrop from './CanvasFileDrop.vue'
import OverviewDisplayMenu from './OverviewDisplayMenu.vue'
import { useCanvasScene } from '../../composables/canvas/scene/scene'

// The bar above a canvas: what it is, what it holds, and what can be done with it.
const props = defineProps<{ fileDrop?: InstanceType<typeof CanvasFileDrop> }>()
const { t } = useI18n()
const scene = useCanvasScene()
const { workspace, edits, shell, view, menus } = scene
const size = computed(() => (shell.mobile ? 'xl' : 'sm'))
const refreshed = computed(() =>
  workspace.refreshedAt
    ? t('app.refreshUpdated', {
        time: new Date(workspace.refreshedAt).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        }),
      })
    : t('app.refresh'),
)
const counts = computed(() => {
  if (workspace.pending || workspace.undiscoveredSources.length) return ''
  const windows = workspace.allWindows.length
  if (scene.kind.value === 'overview')
    return view.filtered
      ? t('app.filteredWindows', {
          visible: scene.graph.visibleOverviewCount.value,
          total: windows,
        })
      : t('app.overviewCount', {
          connections: t('app.connectionCount', workspace.sources.length),
          windows: t('app.windowCount', windows),
        })
  if (scene.kind.value === 'working-set')
    return t('app.windowCount', scene.paging.pages.value.length)
  const nodes = scene.canvas.value?.nodes || []
  const count = (type: string) => nodes.filter((node) => node.type === type).length
  return (
    [
      nodes.some(isTerminalNode) && t('app.windowCount', count('terminal')),
      count('note') && t('app.noteCount', count('note')),
      count('file') && t('app.fileCount', count('file')),
    ]
      .filter(Boolean)
      .join(' · ') || t('app.emptyCanvas')
  )
})

const createItems = computed<DropdownMenuItem[]>(() => [
  {
    label: t('app.addNote'),
    icon: 'i-lucide-sticky-note',
    onSelect: () => void scene.windows.addNote(),
  },
  {
    label: t('app.uploadFile'),
    icon: 'i-lucide-upload',
    disabled: props.fileDrop?.uploading,
    onSelect: () => props.fileDrop?.chooseFiles(),
  },
])
const menuTrigger = useTemplateRef<{ $el: HTMLElement }>('menuTrigger')
const menuDismiss = usePointerDismiss(menus.canvas, () => menuTrigger.value?.$el)
/** A view switch that stays in the menu when toggled. */
const toggle = (
  label: string,
  icon: string,
  model: 'minimap' | 'navigation' | 'autoYieldControls',
) => ({
  type: 'checkbox' as const,
  label,
  icon,
  checked: view[model],
  onSelect: (event: Event) => event.preventDefault(),
  onUpdateChecked: (checked: boolean) => {
    view[model] = checked
  },
})
function editBackground() {
  shell.backgroundCanvas = scene.canvas.value || {
    id: 'overview',
    name: t('app.overview'),
    nodes: [],
    background: workspace.overviewBackground,
  }
}
async function deleteCanvas() {
  const canvas = scene.canvas.value
  if (!canvas || !(await scene.layout.leave())) return
  void confirmAction({
    title: t('app.deleteNamed', { name: canvas.name }),
    description: t('app.deleteCanvasDescription'),
    danger: true,
    button: t('app.deleteCanvas'),
    submit: async () => {
      if (!(await edits.flushNotes(canvas.id))) return
      await write(`/api/canvases/${segment(canvas.id)}`, 'DELETE')
      edits.discard(canvas.id)
      await workspace.sync()
    },
  })
}
const menuItems = computed<DropdownMenuItem[][]>(() => {
  const custom = scene.custom.value
  return [
    [
      ...(shell.mobile
        ? [
            {
              label: t('app.refresh'),
              icon: 'i-lucide-refresh-cw',
              onSelect: () => void workspace.refresh(),
            },
            {
              label: t('app.connections'),
              icon: 'i-lucide-server',
              onSelect: () => {
                shell.connectionsOpen = true
              },
            },
            ...(custom
              ? [
                  {
                    label: t('app.addWindows'),
                    icon: 'i-lucide-layers',
                    onSelect: () => void scene.cards.addToCanvas(),
                  },
                  ...(scene.layout.editing.value
                    ? []
                    : [
                        {
                          label: t('app.layoutEdit'),
                          icon: 'i-lucide-move',
                          onSelect: () => void scene.layout.start(),
                        },
                      ]),
                ]
              : []),
          ]
        : []),
      { label: t('app.background'), icon: 'i-lucide-image', onSelect: editBackground },
    ],
    [
      toggle(t('app.minimap'), 'i-lucide-map', 'minimap'),
      toggle(t('app.navigation'), 'i-lucide-panel-bottom', 'navigation'),
      toggle(t('app.autoYieldControls'), 'i-lucide-mouse-pointer-2', 'autoYieldControls'),
    ],
    ...(custom
      ? [
          [
            {
              label: t('app.renameCanvas'),
              icon: 'i-lucide-pencil',
              onSelect: () => void editCanvasName(scene.canvas.value),
            },
            {
              label: t('app.deleteCanvas'),
              icon: 'i-lucide-trash',
              color: 'error' as const,
              onSelect: () => void deleteCanvas(),
            },
          ],
        ]
      : []),
  ]
})
watch(
  () => shell.backgroundCanvas,
  (editing, was) => {
    if (was && !editing) void nextTick(() => menuTrigger.value?.$el.focus())
  },
)
const hidden = computed(() => (contentFontReady.value && shell.cardMaximized) || undefined)
const labelled = { label: '@max-[620px]/header:hidden' }
const menuUi = ref({
  content: 'canvas-menu min-w-[200px] w-max max-w-[calc(var(--ui-viewport-width)-16px)]',
  group: 'space-y-0.5',
  itemLabel: 'whitespace-nowrap',
})
</script>

<template>
  <header class="workspace-header @container/header" :inert="hidden" :aria-hidden="hidden">
    <BrandMark v-if="!shell.sidebarDrawer" class="header-brand" :size="21" />
    <div class="flex min-w-0 flex-1 items-center gap-2">
      <UButton
        v-if="shell.sidebarDrawer"
        class="mobile-menu-trigger"
        icon="i-lucide-menu"
        color="neutral"
        variant="ghost"
        :size="size"
        :aria-label="t('app.openCanvasList')"
        aria-controls="canvas-sidebar"
        :aria-expanded="shell.sidebarOpen"
        @click="shell.sidebarOpen = !shell.sidebarOpen"
      />
      <h1 v-if="workspace.state" class="truncate text-sm font-medium" :title="scene.name.value">
        {{ scene.name.value }}
      </h1>
      <span v-if="counts && !shell.mobile" class="header-counts truncate text-xs text-dimmed">
        {{ counts }}
      </span>
      <UButton
        v-if="!shell.mobile"
        class="refresh-button @max-[260px]/header:hidden"
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="ghost"
        size="xs"
        :loading="workspace.refreshing"
        :disabled="workspace.pending"
        :title="refreshed"
        :aria-label="t('app.refresh')"
        @click="workspace.refresh()"
      />
    </div>
    <div
      class="header-actions flex shrink-0 items-center gap-1"
      :inert="workspace.pending || scene.layout.editing.value || undefined"
    >
      <OverviewDisplayMenu v-if="scene.kind.value === 'overview'" :size="size" />
      <template v-if="scene.custom.value">
        <UDropdownMenu
          v-model:open="menus.create.value"
          :items="createItems"
          :content="{ align: 'end' }"
        >
          <UButton
            class="canvas-create-trigger"
            icon="i-lucide-plus"
            color="neutral"
            variant="ghost"
            :size="size"
            :title="t('app.addContent')"
            :aria-label="t('app.addContent')"
          />
        </UDropdownMenu>
        <SaveStatus
          v-if="!shell.mobile"
          :owner="layoutOwner(scene.route.canvasId.value)"
          size="xs"
        />
      </template>
      <UDropdownMenu
        v-model:open="menus.canvas.value"
        :modal="false"
        :items="menuItems"
        :content="{ align: 'end', ...menuDismiss }"
        :ui="menuUi"
      >
        <UButton
          ref="menuTrigger"
          class="canvas-menu-trigger"
          icon="i-lucide-ellipsis"
          color="neutral"
          variant="ghost"
          :size="size"
          :title="t('app.canvasSettings')"
          :aria-label="t('app.canvasSettings')"
        />
      </UDropdownMenu>
      <template v-if="!shell.mobile">
        <UButton
          icon="i-lucide-server"
          color="neutral"
          variant="subtle"
          size="sm"
          :label="t('app.connections')"
          :title="t('app.connections')"
          :ui="labelled"
          @click="shell.connectionsOpen = true"
        />
        <UButton
          v-if="scene.kind.value === 'overview'"
          icon="i-lucide-plus"
          size="sm"
          :label="t('app.addConnection')"
          :title="t('app.addConnection')"
          :ui="labelled"
          @click="editSource()"
        />
        <UButton
          v-else-if="scene.custom.value"
          icon="i-lucide-layers"
          size="sm"
          :label="t('app.addWindows')"
          :title="t('app.addWindows')"
          :ui="labelled"
          @click="scene.cards.addToCanvas()"
        />
      </template>
    </div>
  </header>
</template>
