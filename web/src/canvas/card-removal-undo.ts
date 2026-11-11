import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from '@nuxt/ui/composables/useToast'
import type { CardRemovalUndo } from '../../../shared/card-removal'
import {
  api,
  apiRevision,
  ApiError,
  isCurrentApi,
  segment,
  uuid,
  type ApiContext,
} from '../api/api'
import { filePreferenceKeys } from '../files/file-view'
import { noteScrollKey } from '../notes/note-scroll'
import { cardZoomKey } from './card-zoom'
import type { CanvasNode } from '../api/types'
import { toastAction } from '../lib/toast'

interface Removal {
  id: string
  canvasId: string
  nodeId: string
  context: ApiContext
  keys: string[]
  deadline?: number
  timer?: ReturnType<typeof setTimeout>
  restoring?: boolean
  preferences?: Array<[string, string]>
}

function restorePreferences(entry: Removal) {
  try {
    for (const [key, value] of entry.preferences || [])
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
  } catch {
    /* Undo remains available when browser storage is blocked or full. */
  }
}

/** Each removal keeps its own server deadline and only its local reading preferences. */
export function useCardRemovalUndo(options: {
  sync(): Promise<void>
  released(context: ApiContext): void
  error(reason: unknown): void
}) {
  const { t } = useI18n(),
    toast = useToast()
  const entries = new Map<string, Removal>(),
    count = ref(0)
  const current = (entry: Removal) => entries.get(entry.id) === entry && isCurrentApi(entry.context)
  const release = (entry: Removal) => {
    if (entries.get(entry.id) !== entry) return
    clearTimeout(entry.timer)
    entries.delete(entry.id)
    count.value = entries.size
    toast.remove(entry.id)
    options.released(entry.context)
  }
  const clear = () => {
    for (const entry of entries.values()) release(entry)
  }
  // Nuxt UI queues additions until nextTick; stale queued notices must also be discarded.
  watch(
    [toast.toasts, apiRevision],
    ([items]) => {
      for (const entry of entries.values()) if (!isCurrentApi(entry.context)) release(entry)
      // Keep active Undo notices after ordinary notifications so Nuxt's bounded
      // queue evicts ordinary notices first. Each removal still owns its deadline.
      const ordinary = items
        .filter((item) => !String(item.id).startsWith('card-removal:'))
        .slice(-4)
      const undo = items.filter((item) => entries.has(String(item.id)))
      const valid = [...ordinary, ...undo]
      if (valid.length !== items.length || valid.some((item, index) => item !== items[index]))
        toast.toasts.value = valid
    },
    { flush: 'sync' },
  )
  onBeforeUnmount(clear)

  async function restore(entry: Removal, undo: CardRemovalUndo) {
    if (!current(entry) || entry.restoring) return
    if (performance.now() >= entry.deadline!) {
      release(entry)
      return
    }
    entry.restoring = true
    toast.update(entry.id, {
      duration: Math.max(1, entry.deadline! - performance.now()),
      actions: [
        {
          ...toastAction,
          label: t('app.undoRemoval'),
          loading: true,
          disabled: true,
          closeOnClick: false,
        },
      ],
    })
    try {
      // A peer may have pruned shared localStorage after removal. Restore only
      // missing preferences before the restored card can mount from its SSE.
      restorePreferences(entry)
      await api(
        `/api/canvases/${segment(entry.canvasId)}/removals/${segment(undo.token)}/undo`,
        { method: 'POST', body: '{}' },
        entry.context,
      )
      if (current(entry)) {
        restorePreferences(entry)
        await options.sync()
      }
    } catch (reason) {
      if (current(entry))
        options.error(
          reason instanceof ApiError && reason.status === 404
            ? new Error(t('app.undoUnavailable'))
            : reason,
        )
    } finally {
      release(entry)
    }
  }

  return {
    count,
    clear,
    release,
    begin(canvasId: string, node: CanvasNode, context: ApiContext) {
      if (
        [...entries.values()].some(
          (entry) => entry.canvasId === canvasId && entry.nodeId === node.id,
        )
      )
        return
      const entry: Removal = {
        id: `card-removal:${uuid()}`,
        canvasId,
        nodeId: node.id,
        context,
        keys:
          node.type === 'terminal'
            ? []
            : [
                cardZoomKey(context.id, node.id),
                ...(node.type === 'file'
                  ? filePreferenceKeys(context.id, canvasId, node.id)
                  : [noteScrollKey(context.id, canvasId, node.id)]),
              ],
      }
      try {
        entry.preferences = entry.keys.flatMap((key) => {
          const value = key ? localStorage.getItem(key) : null
          return key && value !== null ? [[key, value] as [string, string]] : []
        })
      } catch {
        /* Retaining reading preferences is best effort. */
      }
      entries.set(entry.id, entry)
      count.value = entries.size
      return entry
    },
    offer(
      entry: Removal,
      undo: CardRemovalUndo | null,
      started: number,
      name: string,
      lastReference: boolean,
    ) {
      if (!current(entry) || !undo) {
        release(entry)
        return
      }
      const remaining = Math.max(0, undo.remainingMs - (performance.now() - started))
      entry.deadline = performance.now() + remaining
      if (!remaining) {
        release(entry)
        return
      }
      entry.timer = setTimeout(() => {
        toast.remove(entry.id)
        if (!entry.restoring) release(entry)
      }, remaining)
      toast.add({
        id: entry.id,
        title: t(lastReference ? 'app.cardDeleted' : 'app.cardRemoved', { name }),
        duration: remaining,
        color: 'neutral',
        type: 'background',
        class: 'card-removal-toast',
        actions: [
          {
            ...toastAction,
            label: t('app.undoRemoval'),
            closeOnClick: false,
            onClick: () => {
              void restore(entry, undo)
            },
          },
        ],
      })
    },
    preferences: () => new Set([...entries.values()].flatMap((entry) => entry.keys)),
  }
}
