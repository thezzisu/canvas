<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { CanvasNotification } from '../../../shared/notification'
import type { SourceResource } from '../types'
import { apiContext, isCurrentApi, uuid } from '../api'
import { attentionSummary, faviconStatus, isCanvasNotification, notificationKey, notificationTarget } from '../notification-model'
import { deliverNotificationEffects, holdNotificationOwner, isBadgeOwnerChange, syncNotificationFocus, updateNotificationBadge } from '../notification-effects'
import { notificationSoundEnabled, refreshNotificationPermission, unlockNotificationSound } from '../notification-settings'
import { statusColor } from '../status'
import { formatCanvasLocation } from '../canvas-location'
import canvasIcon from '../../public/icons/canvas.svg?raw'

const props = defineProps<{ instanceId: string; backendId: string; resources: SourceResource[]; refresh(): Promise<void> }>()
const emit = defineEmits<{ open: [event: CanvasNotification] }>()
const { t } = useI18n()
const toast = useToast(), context = apiContext()
const owner = uuid(), toastPrefix = `notification:${context.revision}:${props.backendId}:`
let releaseOwner = holdNotificationOwner(owner), pageActive = true
const seen = new Set<string>(), active = new Map<string, CanvasNotification>()
const pending = new Map<string, { event: CanvasNotification; expires: number }>()
let timer: ReturnType<typeof setTimeout> | undefined, disposed = false
const summary = computed(() => attentionSummary(props.resources))
const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
const originalIcon = `${import.meta.env.BASE_URL}icons/canvas.svg`
const favicon = computed(() => {
  const status = faviconStatus(props.resources)
  return status ? `data:image/svg+xml,${encodeURIComponent(canvasIcon.replace('</svg>',
    `<circle cx="51" cy="51" r="11" fill="${statusColor(status)}" stroke="#17191d" stroke-width="4"/></svg>`))}` : originalIcon
})
// Mount after the preceding instance restores its icon during unmount.
onMounted(() => watch(favicon, value => {
  if (icon) { icon.type = 'image/svg+xml'; icon.href = value }
}, { immediate: true }))

function current() { return !disposed && pageActive && isCurrentApi(context) }
function syncFocus() {
  const element = document.activeElement
  const card = document.hasFocus() && !document.hidden && element?.matches('.xterm-helper-textarea, .terminal-mobile-input')
    ? element.closest<HTMLElement>('.terminal-card') : undefined
  const sourceId = card?.dataset.sourceId, windowId = card?.dataset.windowId
  const window = props.resources.find(source => source.id === sourceId)?.spaces.flatMap(space => space.windows).find(window => window.id === windowId)
  void syncNotificationFocus(props.backendId, owner, sourceId && windowId
    ? { sourceId, windowId, paneId: window?.panes?.find(pane => pane.active)?.id } : undefined, current)
}
function interacting(event: CanvasNotification) {
  if (!document.hasFocus() || document.hidden) return false
  const element = document.activeElement
  const card = element?.matches('.xterm-helper-textarea, .terminal-mobile-input') ? element.closest<HTMLElement>('.terminal-card') : undefined
  if (card?.dataset.sourceId !== event.sourceId || card.dataset.windowId !== event.windowId) return false
  return !event.paneId || notificationTarget(event, props.resources)?.pane?.active === true
}
function acceptsToast(id: string | number) {
  const event = [...active.values()].find(event => `${toastPrefix}${event.id}` === id)
  if (!event || !current() || interacting(event)) return false
  const target = notificationTarget(event, props.resources)
  return (target?.pane?.status || target?.window.status) === event.kind
}
function title(event: CanvasNotification) {
  const target = notificationTarget(event, props.resources)
  return target && (event.kind === 'attention' || event.kind === 'done')
    ? `${target.window.name} · ${t(`notifications.${event.kind}`)}` : event.title
}
function description(event: CanvasNotification) {
  const target = notificationTarget(event, props.resources)
  return [target ? [target.source.name, target.space.name, target.pane?.name].filter(Boolean).join(' / ') : undefined, event.body].filter(Boolean).join('\n')
}
function show(event: CanvasNotification) {
  const important = event.kind === 'attention' || event.kind === 'done', key = notificationKey(event)
  if (important) {
    if (active.get(key)?.kind === event.kind) return
    const previous = active.get(key)
    if (previous) toast.remove(`${toastPrefix}${previous.id}`)
    active.set(key, event)
    if (interacting(event)) {
      void deliverNotificationEffects(props.backendId, event, { title: '', body: '', url: '', quiet: true, valid: current })
      return
    }
  }
  const target = notificationTarget(event, props.resources)
  if (document.hasFocus() && !document.hidden) toast.add({
    id: `${toastPrefix}${event.id}`, title: title(event), description: description(event),
    color: event.kind === 'attention' ? 'error' : event.kind === 'done' ? 'success' : 'neutral',
    class: `notice-${event.kind}`, duration: event.kind === 'attention' ? Infinity : important ? 8000 : 3500,
    progress: false, type: important ? 'foreground' : 'background',
    actions: target ? [{ label: t('notifications.open'), color: 'neutral', variant: 'outline', onClick: () => emit('open', event) }] : [],
  })
  if (!important) return
  const url = new URL(location.href)
  url.hash = formatCanvasLocation({ instance: props.instanceId, canvas: 'overview', view: 'paged', page: `${event.sourceId}/${event.windowId}` })
  void deliverNotificationEffects(props.backendId, event, {
    title: title(event), body: description(event), url: url.href,
    valid: () => current() && active.get(key) === event && !interacting(event),
  })
}
function reconcile() {
  clearTimeout(timer)
  for (const [key, event] of active) {
    const target = notificationTarget(event, props.resources)
    if (!target || (target.pane?.status || target.window.status) !== event.kind) {
      toast.remove(`${toastPrefix}${event.id}`); active.delete(key)
    } else if (interacting(event)) toast.remove(`${toastPrefix}${event.id}`)
  }
  const now = Date.now()
  for (const [key, item] of pending) {
    if (item.expires <= now) { pending.delete(key); continue }
    const target = notificationTarget(item.event, props.resources)
    if (target && (target.pane?.status || target.window.status) === item.event.kind) {
      pending.delete(key); show({ ...item.event, windowId: target.window.id, spaceId: target.space.id })
    } else if (!props.resources.some(source => source.id === item.event.sourceId && source.status === 'online' && !source.error)) pending.delete(key)
  }
  if (pending.size) timer = setTimeout(reconcile, Math.max(1, Math.min(...[...pending.values()].map(item => item.expires)) - Date.now()))
}
function receive(value: unknown) {
  if (!current() || !isCanvasNotification(value) || seen.has(value.id)) return
  if (!props.resources.some(source => source.id === value.sourceId && source.status === 'online' && !source.error)) return
  seen.add(value.id)
  if (seen.size > 256) seen.delete(seen.values().next().value!)
  if (value.kind === 'attention' || value.kind === 'done') {
    pending.set(notificationKey(value), { event: value, expires: Date.now() + 3000 })
    if (pending.size > 32) pending.delete(pending.keys().next().value!)
    reconcile()
    if (pending.size) void props.refresh()
  } else show(value)
}
watch(() => props.resources, () => { syncFocus(); reconcile() })

function updateBadge() {
  void updateNotificationBadge(owner, summary.value.count, document.hasFocus() && !document.hidden)
}
watch(() => summary.value.count, updateBadge, { immediate: true })
useEventListener(window, ['pointerdown', 'keydown'], event => {
  if (event.isTrusted && notificationSoundEnabled.value) void unlockNotificationSound()
}, { passive: true })
useEventListener(window, ['focus', 'blur'], () => { refreshNotificationPermission(); syncFocus(); updateBadge(); reconcile() })
useEventListener(document, ['focusin', 'focusout', 'visibilitychange'], () => { syncFocus(); reconcile() })
useEventListener(window, 'storage', event => { if (isBadgeOwnerChange(event)) updateBadge() })
useEventListener(window, 'pagehide', () => {
  pageActive = false; clearTimeout(timer); pending.clear(); releaseOwner()
  void syncNotificationFocus(props.backendId, owner, undefined, () => false)
  void updateNotificationBadge(owner, 0, false, true)
})
useEventListener(window, 'pageshow', () => {
  releaseOwner(); releaseOwner = holdNotificationOwner(owner); pageActive = true
  syncFocus(); updateBadge(); reconcile()
})
if ('serviceWorker' in navigator) useEventListener(navigator.serviceWorker, 'message', (event: MessageEvent) => {
  const data = event.data
  if (data?.type !== 'canvas:notification-open' || data.instance !== props.backendId || typeof data.sourceId !== 'string' || typeof data.windowId !== 'string') return
  const notice: CanvasNotification = { id: '', kind: 'custom', title: '', sourceId: data.sourceId, windowId: data.windowId }
  if (current() && notificationTarget(notice, props.resources)) emit('open', notice)
})
onBeforeUnmount(() => {
  disposed = true; clearTimeout(timer); pending.clear()
  for (const item of toast.toasts.value) if (String(item.id).startsWith(toastPrefix)) toast.remove(item.id)
  active.clear()
  if (icon) { icon.href = originalIcon; icon.type = 'image/svg+xml' }
  void syncNotificationFocus(props.backendId, owner, undefined, () => false)
  void updateNotificationBadge(owner, 0, false, true)
  releaseOwner()
})
defineExpose({ receive, acceptsToast })
</script>

<template><span hidden /></template>

<style>
.canvas-notifications{position:absolute;right:12px;bottom:max(12px,var(--mobile-safe-bottom,var(--ui-safe-bottom)));max-width:calc(100% - 24px);z-index:100}
.notice-attention{--ui-error:#f38ba8}.notice-done{--ui-success:#94e2d5}
</style>
