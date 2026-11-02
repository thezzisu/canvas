<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { useForwardPropsEmits } from 'reka-ui'
import UModal, { type ModalProps, type ModalEmits, type ModalSlots } from '@nuxt/ui/components/Modal.vue'
import { registerNotificationSurface } from '../notification-surface'

defineOptions({ inheritAttrs: false })
const props = defineProps<ModalProps>()
const emit = defineEmits<ModalEmits>()
const slots = defineSlots<ModalSlots & { actions?: () => unknown }>()
const forwarded = useForwardPropsEmits(props, emit)
const uncontrolledOpen = ref(!!props.defaultOpen)
const element = shallowRef<HTMLElement>()
const open = computed(() => forwarded.value.open ?? uncontrolledOpen.value)
const content = computed(() => ({ ...props.content,
  onOpenAutoFocus(event: Event) {
    if (event.target instanceof HTMLElement) element.value = event.target
    props.content?.onOpenAutoFocus?.(event)
  },
  onCloseAutoFocus(event: Event) {
    element.value = undefined
    props.content?.onCloseAutoFocus?.(event)
  },
}))

// Put notifications inside the active dialog's native focus/ARIA boundary.
watch([element, open], ([node, active], _previous, cleanup) => {
  if (node && active) cleanup(registerNotificationSurface(node))
}, { flush: 'post' })
</script>

<template>
  <UModal v-bind="{ ...forwarded, ...$attrs }" :content="content" @update:open="uncontrolledOpen = $event">
    <template v-if="slots.default" #default="scope"><slot v-bind="scope" /></template>
    <template v-if="slots.content" #content="scope"><slot name="content" v-bind="scope" /></template>
    <template v-if="slots.header" #header="scope"><slot name="header" v-bind="scope" /></template>
    <template v-if="slots.title" #title><slot name="title" /></template>
    <template v-if="slots.description" #description><slot name="description" /></template>
    <template v-if="slots.actions" #actions><slot name="actions" /></template>
    <template v-if="slots.close" #close="scope"><slot name="close" v-bind="scope" /></template>
    <template v-if="slots.body" #body="scope"><slot name="body" v-bind="scope" /></template>
    <template v-if="slots.footer" #footer="scope"><slot name="footer" v-bind="scope" /></template>
  </UModal>
</template>
