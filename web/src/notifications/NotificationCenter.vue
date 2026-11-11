<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useEventListener } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { CanvasNotification } from '../../../shared/notification'
import type { SourceResource } from '../api/types'
import { sameCompletion } from '../../../shared/completion'
import { samePane, type PaneFocus } from '../workspace/completion-focus'
import { apiContext, isCurrentApi, uuid } from '../api/api'
import {
  attentionSummary,
  faviconStatus,
  isCanvasNotification,
  notificationKey,
  notificationTarget,
  notificationCurrent,
  notificationPresent,
} from './notification-model'
import {
  deliverNotificationEffects,
  holdNotificationOwner,
  isBadgeOwnerChange,
  syncNotificationFocus,
  updateNotificationBadge,
} from './notification-effects'
import {
  notificationSoundEnabled,
  refreshNotificationPermission,
  unlockNotificationSound,
} from './notification-settings'
import { statusColor } from '../lib/status'
import { windowLabel } from '../workspace/window-title'
import { toastAction } from '../lib/notify'
import { canvasHref } from '../canvas/canvas-location'
import { useWorkspaceStore } from '../stores/workspace'
import canvasIcon from '../../public/icons/canvas.svg?raw'

const props = defineProps<{
  instanceId: string
  backendId: string
  resources: SourceResource[]
  displayResources: SourceResource[]
  focus?: PaneFocus
  actionsAvailable: boolean
  refresh(): Promise<void>
}>()
const emit = defineEmits<{ open: [event: CanvasNotification]; go: [event: CanvasNotification] }>()
const { t } = useI18n()
const toast = useToast(),
  context = apiContext()
const owner = uuid(),
  toastPrefix = `notification:${context.revision}:${props.backendId}:`
let releaseOwner = holdNotificationOwner(owner),
  pageActive = true
interface Notice {
  event: CanvasNotification
  focus?: PaneFocus
  dismissed?: boolean
}
const seen = new Set<string>(),
  active = new Map<string, Notice>()
const pending = new Map<
  string,
  { event: CanvasNotification; expires: number; notBefore?: number; focus?: PaneFocus }
>()
let timer: ReturnType<typeof setTimeout> | undefined,
  disposed = false
const summary = computed(() => attentionSummary(props.displayResources))
const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
const originalIcon = `${import.meta.env.BASE_URL}icons/canvas.svg`
const favicon = computed(() => {
  const status = faviconStatus(props.displayResources)
  return status
    ? `data:image/svg+xml,${encodeURIComponent(
        canvasIcon.replace(
          '</svg>',
          `<circle cx="51" cy="51" r="11" fill="${statusColor(status)}" stroke="#17191d" stroke-width="4"/></svg>`,
        ),
      )}`
    : originalIcon
})
// Mount after the preceding instance restores its icon during unmount.
onMounted(() =>
  watch(
    favicon,
    (value) => {
      if (icon) {
        icon.type = 'image/svg+xml'
        icon.href = value
      }
    },
    { immediate: true },
  ),
)

function current() {
  return !disposed && pageActive && isCurrentApi(context)
}
function syncFocus() {
  void syncNotificationFocus(props.backendId, owner, props.focus, current)
}
function interacting(event: CanvasNotification) {
  const focus = props.focus
  return (
    !!focus &&
    focus.sourceId === event.sourceId &&
    focus.windowId === event.windowId &&
    (!event.paneId || focus.paneId === event.paneId)
  )
}
function noticeValid(notice: Notice) {
  return (
    current() &&
    !notice.dismissed &&
    notificationCurrent(notice.event, props.resources) &&
    (notice.focus ? samePane(notice.focus, props.focus) : !interacting(notice.event))
  )
}
function toastValid(notice: Notice) {
  return notice.event.kind === 'done'
    ? current() && !notice.dismissed && notificationPresent(notice.event, props.resources)
    : noticeValid(notice)
}
function acceptsToast(id: string | number) {
  const notice = [...active.values()].find((notice) => `${toastPrefix}${notice.event.id}` === id)
  return !!notice && toastValid(notice)
}
function actionAvailable(event: CanvasNotification) {
  return (
    current() &&
    props.actionsAvailable &&
    !!notificationTarget(event, props.resources) &&
    (!['attention', 'done'].includes(event.kind) || notificationCurrent(event, props.resources))
  )
}
function act(action: 'open' | 'go', event: CanvasNotification) {
  if (!actionAvailable(event)) return
  if (action === 'open') emit('open', event)
  else emit('go', event)
}
function title(event: CanvasNotification) {
  const target = notificationTarget(event, props.resources)
  return target && (event.kind === 'attention' || event.kind === 'done')
    ? `${windowLabel(target.window, event.paneId)} · ${t(`notifications.${event.kind}`)}`
    : event.title
}
function description(event: CanvasNotification) {
  const target = notificationTarget(event, props.resources)
  return [
    target
      ? [target.source.name, target.space.name, target.pane?.name].filter(Boolean).join(' / ')
      : undefined,
    event.body,
  ]
    .filter(Boolean)
    .join('\n')
}
function show(event: CanvasNotification, focus?: PaneFocus) {
  const important = event.kind === 'attention' || event.kind === 'done',
    key = notificationKey(event)
  const previous = active.get(key)
  if (
    important &&
    previous?.event.kind === event.kind &&
    (event.kind !== 'done' || sameCompletion(previous.event.completion, event.completion))
  )
    return
  if (event.kind === 'attention' && interacting(event)) {
    if (previous) toast.remove(`${toastPrefix}${previous.event.id}`)
    active.set(key, { event, focus, dismissed: true })
    void deliverNotificationEffects(props.backendId, event, {
      title: '',
      body: '',
      url: '',
      quiet: true,
      valid: current,
    })
    return
  }
  if (previous) toast.remove(`${toastPrefix}${previous.event.id}`)
  const notice: Notice = { event, focus }
  if (important) active.set(key, notice)
  const target = notificationTarget(event, props.resources)
  const heading = title(event),
    body = description(event)
  if (document.hasFocus() && !document.hidden)
    toast.add({
      id: `${toastPrefix}${event.id}`,
      title: heading,
      description: focus ? undefined : body,
      color: event.kind === 'attention' ? 'error' : event.kind === 'done' ? 'success' : 'neutral',
      class: `notice-${event.kind}${focus ? ' notice-focused' : ''}`,
      duration: focus ? 3000 : event.kind === 'attention' ? Infinity : important ? 15000 : 3500,
      type: important ? 'foreground' : 'background',
      actions:
        !focus && target
          ? [
              {
                ...toastAction,
                label: t('notifications.open'),
                get disabled() {
                  return !actionAvailable(event)
                },
                onClick: () => act('open', event),
              },
              {
                ...toastAction,
                label: t('notifications.go'),
                get disabled() {
                  return !actionAvailable(event)
                },
                onClick: () => act('go', event),
              },
            ]
          : [],
    })
  if (!important) return
  const url = new URL(location.href)
  url.hash = canvasHref({
    instance: props.instanceId,
    canvas: 'overview',
    view: 'paged',
    page: `${event.sourceId}/${event.windowId}`,
  })
  void deliverNotificationEffects(props.backendId, event, {
    title: heading,
    body,
    url: url.href,
    suppressSystem: !!focus,
    valid: () => active.get(key) === notice && noticeValid(notice),
  })
}
function reconcile() {
  clearTimeout(timer)
  for (const [key, notice] of active) {
    if (
      !notificationPresent(notice.event, props.resources) ||
      (notice.event.kind !== 'done' && !notificationCurrent(notice.event, props.resources))
    ) {
      toast.remove(`${toastPrefix}${notice.event.id}`)
      active.delete(key)
    } else if (!toastValid(notice)) {
      notice.dismissed = true
      toast.remove(`${toastPrefix}${notice.event.id}`)
    }
  }
  const now = Date.now()
  for (const [key, item] of pending) {
    if (item.expires <= now || (item.focus && !samePane(item.focus, props.focus))) {
      pending.delete(key)
      continue
    }
    const target = notificationTarget(item.event, props.resources)
    if (target && notificationCurrent(item.event, props.resources)) {
      // A tool boundary can look completed briefly. Wait for stable completion,
      // starting when live state matches, even if that state arrived late.
      if (item.notBefore === undefined) {
        item.notBefore = now + (item.event.kind === 'done' ? 1000 : 0)
        item.expires = now + 3000
      }
      if (now < item.notBefore) continue
      if (
        item.focus &&
        item.event.completion &&
        !sameCompletion(item.event.completion, props.focus?.painted)
      )
        continue
      pending.delete(key)
      show({ ...item.event, windowId: target.window.id, spaceId: target.space.id }, item.focus)
    } else if (
      item.notBefore !== undefined ||
      !props.resources.some(
        (source) =>
          source.id === item.event.sourceId && source.status === 'online' && !source.error,
      )
    )
      pending.delete(key)
  }
  if (pending.size)
    timer = setTimeout(
      reconcile,
      Math.max(
        1,
        Math.min(
          ...[...pending.values()].map((item) =>
            item.notBefore !== undefined && item.notBefore > now
              ? Math.min(item.notBefore, item.expires)
              : item.expires,
          ),
        ) - now,
      ),
    )
}
function receive(value: unknown) {
  if (!current() || !isCanvasNotification(value) || seen.has(value.id)) return
  if (
    !props.resources.some(
      (source) => source.id === value.sourceId && source.status === 'online' && !source.error,
    )
  )
    return
  seen.add(value.id)
  if (seen.size > 256) seen.delete(seen.values().next().value!)
  if (value.kind === 'attention' || value.kind === 'done') {
    const now = Date.now()
    pending.set(notificationKey(value), {
      event: value,
      expires: now + 3000,
      ...(value.kind === 'done' && interacting(value) ? { focus: props.focus } : {}),
    })
    if (pending.size > 32) pending.delete(pending.keys().next().value!)
    reconcile()
    if (pending.size) void props.refresh()
  } else show(value)
}
watch(
  [() => props.resources, () => props.focus],
  () => {
    syncFocus()
    reconcile()
  },
  { flush: 'sync' },
)

function updateBadge() {
  void updateNotificationBadge(owner, summary.value.count, document.hasFocus() && !document.hidden)
}
watch(() => summary.value.count, updateBadge, { immediate: true })
useEventListener(
  window,
  ['pointerdown', 'keydown'],
  (event) => {
    if (event.isTrusted && notificationSoundEnabled.value) void unlockNotificationSound()
  },
  { passive: true },
)
useEventListener(window, ['focus', 'blur'], () => {
  refreshNotificationPermission()
  syncFocus()
  updateBadge()
  reconcile()
})
useEventListener(document, ['focusin', 'focusout', 'visibilitychange'], () => {
  syncFocus()
  reconcile()
})
useEventListener(window, 'storage', (event) => {
  if (isBadgeOwnerChange(event)) updateBadge()
})
useEventListener(window, 'pagehide', () => {
  pageActive = false
  clearTimeout(timer)
  pending.clear()
  releaseOwner()
  void syncNotificationFocus(props.backendId, owner, undefined, () => false)
  void updateNotificationBadge(owner, 0, false, true)
})
useEventListener(window, 'pageshow', () => {
  releaseOwner()
  releaseOwner = holdNotificationOwner(owner)
  pageActive = true
  syncFocus()
  updateBadge()
  reconcile()
})
if ('serviceWorker' in navigator)
  useEventListener(navigator.serviceWorker, 'message', (event: MessageEvent) => {
    const data = event.data
    if (
      data?.type !== 'canvas:notification-open' ||
      data.instance !== props.backendId ||
      typeof data.sourceId !== 'string' ||
      typeof data.windowId !== 'string'
    )
      return
    const notice: CanvasNotification = {
      id: '',
      kind: 'custom',
      title: '',
      sourceId: data.sourceId,
      windowId: data.windowId,
    }
    if (current() && notificationTarget(notice, props.resources)) emit('open', notice)
  })
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
  pending.clear()
  for (const item of toast.toasts.value)
    if (String(item.id).startsWith(toastPrefix)) toast.remove(item.id)
  active.clear()
  if (icon) {
    icon.href = originalIcon
    icon.type = 'image/svg+xml'
  }
  void syncNotificationFocus(props.backendId, owner, undefined, () => false)
  void updateNotificationBadge(owner, 0, false, true)
  releaseOwner()
})
useWorkspaceStore().onNotification(receive)
// Nuxt UI publishes a queued toast a tick later; one whose notice was read meanwhile is dropped.
watch(
  toast.toasts,
  (items) => {
    const current = items.filter(
      (item) =>
        item.type !== 'foreground' ||
        !String(item.id).startsWith(toastPrefix) ||
        acceptsToast(item.id),
    )
    if (current.length !== items.length) toast.toasts.value = current
  },
  { flush: 'sync' },
)
</script>

<template><span hidden /></template>
