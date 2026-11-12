import { computed, shallowReactive, shallowRef, watch } from 'vue'
import { apiContext, apiRevision, isCurrentApi, orderedWrite, segment } from '../../api/api'
import { insertNoteContent } from '../../utils/notes/note-document'
import { createKeepaliveCopies, pendingWrites } from '../pending-writes'
import type { NoteInsertion, NoteOwner } from '../notes/note-uploads'
import type { ComposerView } from '../../api/types'
import { createAutosave } from '../../utils/autosave'
import { notify } from '../notify'
export { composerHasContent, sentFiles } from '../../utils/terminal/composer-content'

export interface ComposerTarget {
  sourceId: string
  windowId: string
}
const key = (target: ComposerTarget) => `${target.sourceId}/${target.windowId}`
export const composerOwner = (target: ComposerTarget): NoteOwner => ({
  key: `composer:${key(target)}`,
  path: `/api/sources/${segment(target.sourceId)}/windows/${segment(target.windowId)}/composer`,
})

const remote = shallowRef<Record<string, ComposerView>>({})
// Unsaved local text wins over peer snapshots until its own write settles.
const drafts = shallowReactive(new Map<string, { target: ComposerTarget; content: string }>())
const timers = createAutosave()
const saving = new Map<string, Promise<ComposerView | undefined>>()
const copies = createKeepaliveCopies()

export function resetComposers() {
  timers.clear()
  saving.clear()
  copies.forget()
  drafts.clear()
  remote.value = {}
}
watch(apiRevision, resetComposers)
pendingWrites.onFlush((keepalive) => {
  for (const { target } of drafts.values()) saveComposer(target, keepalive)
})

export function applyComposers(value: Record<string, ComposerView>) {
  remote.value = value
}

/** A closed window's unsaved text has nowhere to go. */
export function discardComposerDraft(target: ComposerTarget) {
  const current = key(target)
  timers.cancel(current)
  drafts.delete(current)
  pendingWrites.discard(composerOwner(target).key)
}
/** Store the draft without waiting; failures stay visible on the composer until a retry stores it. */
export function saveComposer(target: ComposerTarget, keepalive = false) {
  void flushComposer(target, keepalive).catch(notify.error)
}

export function useComposer(target: () => ComposerTarget) {
  return computed(() => {
    const current = key(target()),
      view = remote.value[current]
    return {
      content: drafts.get(current)?.content ?? view?.content ?? '',
      attachments: view?.attachments ?? [],
    }
  })
}

export function editComposer(target: ComposerTarget, content: string) {
  const current = key(target)
  drafts.set(current, { target, content })
  pendingWrites.start(composerOwner(target).key)
  timers.schedule(current, () => saveComposer(target))
}

/** A file finishing after its editor closed still lands at its recorded position. */
export function insertComposerAttachment(target: ComposerTarget, value: NoteInsertion) {
  const current = key(target)
  editComposer(
    target,
    insertNoteContent(drafts.get(current)?.content ?? remote.value[current]?.content ?? '', value),
  )
}

/** Save pending text and return the exact stored version it produced. */
export async function flushComposer(
  target: ComposerTarget,
  keepalive = false,
): Promise<ComposerView | undefined> {
  const current = key(target),
    owner = composerOwner(target),
    context = apiContext()
  const previous = saving.get(current)
  // A closing page may cancel the save in flight, so a keepalive copy of the latest text goes out,
  // unless a keepalive request already carries exactly that text.
  // That save, then the edit timer or a flush waiting on it, still stores and confirms the text.
  if (keepalive && previous) {
    const content = drafts.get(current)?.content
    if (content !== undefined && copies.claim(current, content))
      void orderedWrite(owner.path, { content }, true, context).catch(() =>
        copies.release(current, content),
      )
    return
  }
  timers.cancel(current)
  if (previous) await previous.catch(() => undefined)
  if (!isCurrentApi(context)) return
  const draft = drafts.get(current)
  if (!draft) return remote.value[current]
  pendingWrites.start(owner.key)
  if (keepalive) copies.claim(current, draft.content)
  const request = orderedWrite<ComposerView>(
    owner.path,
    { content: draft.content },
    keepalive,
    context,
  )
  saving.set(current, request)
  try {
    const view = await request
    if (!isCurrentApi(context)) return
    // An edit made meanwhile stays a draft even when it restores this text: a copy of the text
    // between them may have been stored after this save.
    if (drafts.get(current) === draft) {
      drafts.delete(current)
      pendingWrites.saved(owner.key)
    }
    const known = remote.value[current]
    if (!view.id) {
      const { [current]: _released, ...rest } = remote.value
      remote.value = rest
    } else if (!known || known.id !== view.id || known.version < view.version)
      remote.value = { ...remote.value, [current]: view }
    return view
  } catch (error) {
    if (isCurrentApi(context) && drafts.get(current) === draft)
      pendingWrites.failed(owner.key, () => saveComposer(target))
    throw error
  } finally {
    if (saving.get(current) === request) {
      saving.delete(current)
      copies.forget(current)
    }
  }
}
