import { computed, shallowReactive, shallowRef, watch } from 'vue'
import { api, apiContext, apiRevision, isCurrentApi, segment } from './api'
import { insertNoteContent } from './note-document'
import { pendingWrites } from './pending-writes'
import type { NoteInsertion, NoteOwner } from './note-uploads'
import type { ComposerView } from './types'
import { createAutosave } from './autosave'
export { composerHasContent, sentFiles } from './composer-content'

export interface ComposerTarget { sourceId: string; windowId: string }
const key = (target: ComposerTarget) => `${target.sourceId}/${target.windowId}`
export const composerOwner = (target: ComposerTarget): NoteOwner =>
  ({ key: `composer:${key(target)}`, path: `/api/sources/${segment(target.sourceId)}/windows/${segment(target.windowId)}/composer` })

const remote = shallowRef<Record<string, ComposerView>>({})
// Unsaved local text wins over peer snapshots until its own write settles.
const drafts = shallowReactive(new Map<string, { target: ComposerTarget; content: string }>())
const timers = createAutosave()
const saving = new Map<string, Promise<ComposerView | undefined>>()

export function resetComposers() {
  timers.clear(); saving.clear(); drafts.clear(); remote.value = {}
}
watch(apiRevision, resetComposers)
pendingWrites.onFlush(keepalive => { for (const { target } of drafts.values()) saveComposer(target, keepalive) })

export function applyComposers(value: Record<string, ComposerView>) { remote.value = value }


/** A closed window's unsaved text has nowhere to go. */
export function discardComposerDraft(target: ComposerTarget) {
  const current = key(target)
  timers.cancel(current); drafts.delete(current)
  pendingWrites.discard(composerOwner(target).key)
}
function reportSaveFailure(error: unknown) { window.dispatchEvent(new CustomEvent('canvas:error', { detail: error })) }
/** Store the draft without waiting; failures stay visible on the composer until a retry stores it. */
export function saveComposer(target: ComposerTarget, keepalive = false) { void flushComposer(target, keepalive).catch(reportSaveFailure) }

export function useComposer(target: () => ComposerTarget) {
  return computed(() => {
    const current = key(target()), view = remote.value[current]
    return { content: drafts.get(current)?.content ?? view?.content ?? '', attachments: view?.attachments ?? [] }
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
  editComposer(target, insertNoteContent(drafts.get(current)?.content ?? remote.value[current]?.content ?? '', value))
}

/** Save pending text and return the exact stored version it produced. */
export async function flushComposer(target: ComposerTarget, keepalive = false): Promise<ComposerView | undefined> {
  const current = key(target), owner = composerOwner(target), context = apiContext()
  const previous = saving.get(current)
  // A closing page may cancel the save in flight, so a keepalive copy of the latest text goes out now.
  // That save, then the edit timer or a flush waiting on it, still stores and confirms the text.
  if (keepalive && previous) {
    const content = drafts.get(current)?.content
    if (content !== undefined) void api(owner.path, { method: 'PATCH', body: JSON.stringify({ content }), keepalive }, context).catch(() => {})
    return
  }
  timers.cancel(current)
  if (previous) await previous.catch(() => undefined)
  if (!isCurrentApi(context)) return
  const content = drafts.get(current)?.content
  if (content === undefined) return remote.value[current]
  pendingWrites.start(owner.key)
  const request = api<ComposerView>(owner.path, { method: 'PATCH', body: JSON.stringify({ content }), keepalive }, context)
  saving.set(current, request)
  try {
    const view = await request
    if (!isCurrentApi(context)) return
    if (drafts.get(current)?.content === content) { drafts.delete(current); pendingWrites.saved(owner.key) }
    const known = remote.value[current]
    if (!view.id) {
      const { [current]: _released, ...rest } = remote.value
      remote.value = rest
    } else if (!known || known.id !== view.id || known.version < view.version) remote.value = { ...remote.value, [current]: view }
    return view
  } catch (error) {
    if (isCurrentApi(context) && drafts.get(current)?.content === content) pendingWrites.failed(owner.key, () => saveComposer(target))
    throw error
  } finally { if (saving.get(current) === request) saving.delete(current) }
}
