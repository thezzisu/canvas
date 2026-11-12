<script setup lang="ts">
import { computed, ref } from 'vue'
import { useElementSize, useEventListener } from '@vueuse/core'
import { headerShortcuts } from '../../utils/header-capacity'
import { useI18n } from 'vue-i18n'
import UDropdownMenu, { type DropdownMenuItem } from '@nuxt/ui/components/DropdownMenu.vue'
import UButton from '@nuxt/ui/components/Button.vue'
import UTheme from '@nuxt/ui/components/Theme.vue'
import { usePointerDismiss } from '../../composables/pointer-dismiss'
import { useCardMenu } from '../../composables/canvas/card-menu'

const props = defineProps<{
  items: DropdownMenuItem[]
  expanded: boolean
  removable?: boolean
  mobile?: boolean
  shortcuts?: string[]
  priority?: string[]
  trailing?: string[]
  addLabel: string
  removeLabel?: string
  maximizeLabel?: string
  restoreLabel?: string
  moreLabel?: string
  disabled?: boolean
}>()
const emit = defineEmits<{ add: []; toggle: []; remove: [] }>()
const { t } = useI18n()
const root = ref<HTMLElement>()
const { width } = useElementSize(
  computed(() => (props.mobile ? root.value : undefined)),
  undefined,
  { box: 'content-box' },
)
const available = computed(() =>
  props.mobile
    ? headerShortcuts(width.value, props.shortcuts || [], !!props.removable, props.priority)
    : undefined,
)
const visible = (key: string) => !available.value || available.value.has(key)
const menu = computed<DropdownMenuItem[][]>(() =>
  [
    [
      ...(!visible('add')
        ? [{ label: props.addLabel, icon: 'i-lucide-layers', onSelect: () => emit('add') }]
        : []),
      ...(props.removable && !visible('remove')
        ? [
            {
              label: props.removeLabel || t('common.close'),
              icon: 'i-lucide-x',
              onSelect: () => emit('remove'),
            },
          ]
        : []),
    ],
    props.items.filter(
      (item) => !item.slot || !props.shortcuts?.includes(item.slot) || !visible(item.slot),
    ),
  ].filter((group) => group.length),
)
const open = useCardMenu(),
  triggerButton = ref<{ $el: HTMLElement }>(),
  menuElement = ref<HTMLElement>()
const trigger = computed(() => triggerButton.value?.$el)
let preserveInput = false
const dismiss = usePointerDismiss(open, trigger)
function pointerOpen(event: PointerEvent) {
  const active = document.activeElement
  preserveInput =
    event.pointerType === 'touch' &&
    !!props.mobile &&
    active instanceof HTMLElement &&
    !!active.closest('.card-content') &&
    (active.isContentEditable || active.matches('input,textarea'))
  if (preserveInput) event.preventDefault()
}
const content = {
  side: 'bottom' as const,
  align: 'end' as const,
  ...dismiss,
  onOpenAutoFocus(event: Event) {
    if (event.target instanceof HTMLElement) menuElement.value = event.target
    if (preserveInput) event.preventDefault()
  },
  onCloseAutoFocus(event: Event) {
    menuElement.value = undefined
    dismiss.onCloseAutoFocus(event)
    if (preserveInput) event.preventDefault()
  },
}
// Keep pointer selection on native menu items from blurring the mobile editor.
useEventListener(menuElement, 'pointerdown', (event) => {
  if (preserveInput) event.preventDefault()
})
useEventListener(menuElement, 'pointermove', (event) => {
  if (event.pointerType === 'mouse') preserveInput = false
})
useEventListener(menuElement, 'keydown', () => {
  preserveInput = false
})
useEventListener(
  computed(() => (open.value ? document : undefined)),
  'keydown',
  (event: KeyboardEvent) => {
    if (!preserveInput || event.key !== 'Escape') return
    // The input still owns IME composition; ordinary Escape dismisses only this menu.
    event.stopPropagation()
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    open.value = false
  },
  { capture: true },
)
</script>

<template>
  <div
    ref="root"
    class="card-header-actions nodrag nopan"
    :class="{ 'card-header-mobile': mobile }"
    :style="{
      '--header-actions-width': `${((shortcuts?.length || 0) + 3 + (removable ? 1 : 0)) * 44}px`,
    }"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
  >
    <!-- Every header action is a ghost UButton that turns primary (the card's color) while active;
         a focused phone card gives each a 44px touch target. -->
    <UTheme
      :props="{
        button: {
          color: 'neutral',
          variant: 'ghost',
          activeColor: 'primary',
          activeVariant: 'soft',
          size: mobile ? 'xl' : 'md',
          square: true,
          class: mobile ? 'min-w-[44px] min-h-[44px] flex-none justify-center' : undefined,
        },
      }"
    >
      <template v-for="key in shortcuts" :key="key"
        ><slot v-if="visible(key) && !trailing?.includes(key)" :name="key"
      /></template>
      <UButton
        v-if="visible('add')"
        class="card-add"
        icon="i-lucide-layers"
        :title="addLabel"
        :aria-label="addLabel"
        @click="emit('add')"
      />
      <template v-for="key in trailing" :key="key"
        ><slot v-if="shortcuts?.includes(key) && visible(key)" :name="key"
      /></template>
      <UDropdownMenu
        v-model:open="open"
        :modal="false"
        :items="menu"
        :content="content"
        :ui="{ content: 'card-action-menu min-w-[160px]' }"
      >
        <UButton
          ref="triggerButton"
          class="card-more"
          icon="i-lucide-ellipsis"
          :active="open"
          :aria-label="moreLabel || t('common.more')"
          :title="moreLabel || t('common.more')"
          @pointerdown="pointerOpen"
          @keydown="preserveInput = false"
        />
      </UDropdownMenu>
      <UButton
        class="card-maximize"
        :icon="expanded ? 'i-lucide-minimize' : 'i-lucide-maximize'"
        :disabled="disabled"
        :title="
          expanded
            ? restoreLabel || t('common.returnToCanvas')
            : maximizeLabel || t('common.maximize')
        "
        :aria-label="
          expanded
            ? restoreLabel || t('common.returnToCanvas')
            : maximizeLabel || t('common.maximize')
        "
        @click="emit('toggle')"
      />
      <UButton
        v-if="removable && visible('remove')"
        class="card-remove"
        icon="i-lucide-x"
        :title="removeLabel || t('common.close')"
        :aria-label="removeLabel || t('common.close')"
        @click="emit('remove')"
      />
    </UTheme>
  </div>
</template>

<style>
.card-header-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s;
}
:is(.terminal-card, .note-card, .file-card):focus-within .card-header-actions,
.vue-flow__node.selected .card-header-actions,
.terminal-card.focused .card-header-actions,
.card-focused .card-header-actions,
.mobile-layout .card-header-actions {
  opacity: 1;
  pointer-events: auto;
}
/* A focused phone card: 44px touch targets, and the title keeps at least half the header;
   shortcuts that do not fit move into the overflow menu. */
.card-header-mobile {
  gap: 0;
  justify-content: flex-end;
  min-width: 0;
  width: min(var(--header-actions-width), max(88px, round(down, 50cqw, 44px)));
}
@media (hover: hover) {
  :is(.terminal-card, .note-card, .file-card):hover .card-header-actions {
    opacity: 1;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .card-header-actions {
    transition: none;
  }
}
</style>
