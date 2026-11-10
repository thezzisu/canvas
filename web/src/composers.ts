import { computed, shallowReactive, shallowRef, watch } from 'vue'
import { api, apiContext, apiRevision, isCurrentApi, segment } from './api'
import { insertNoteContent } from './note-document'
import type { NoteInsertion, NoteOwner } from './note-uploads'
import type { ComposerView } from './types'
export { composerHasContent, sentFiles } from './composer-content'

export interface ComposerTarget { sourceId: string; windowId: string }
const key = (target: ComposerTarget) => `${target.sourceId}/${target.windowId}`
export const composerOwner = (target: ComposerTarget): NoteOwner =>
  ({ key: `composer:${key(target)}`, path: `/api/sources/${segment(target.sourceId)}/windows/${segment(target.windowId)}/composer` })

const remote = shallowRef<Record<string, ComposerView>>({})
// Unsaved local text wins over peer snapshots until its own write settles.
const drafts = shallowReactive(new Map<string, string>())
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const saving = new Map<string, Promise<ComposerView | undefined>>()

export function resetComposers() {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear(); saving.clear(); drafts.clear(); remote.value = {}
}
watch(apiRevision, resetComposers)

export function applyComposers(value: Record<string, ComposerView>) { remote.value = value }


/** A closed window's unsaved text has nowhere to go. */
export function discardComposerDraft(target: ComposerTarget) {
  const current = key(target)
  clearTimeout(timers.get(current)); timers.delete(current); drafts.delete(current)
}
function reportSaveFailure(error: unknown) { window.dispatchEvent(new CustomEvent('canvas:error', { detail: error })) }

export function useComposer(target: () => ComposerTarget) {
  return computed(() => {
    const current = key(target()), view = remote.value[current]
    return { content: drafts.get(current) ?? view?.content ?? '', attachments: view?.attachments ?? [] }
  })
}

export function editComposer(target: ComposerTarget, content: string) {
  const current = key(target)
  drafts.set(current, content)
  clearTimeout(timers.get(current))
  timers.set(current, setTimeout(() => { timers.delete(current); void flushComposer(target).catch(reportSaveFailure) }, 400))
}

/** A file finishing after its editor closed still lands at its recorded position. */
export function insertComposerAttachment(target: ComposerTarget, value: NoteInsertion) {
  const current = key(target)
  editComposer(target, insertNoteContent(drafts.get(current) ?? remote.value[current]?.content ?? '', value))
}

/** Save pending text and return the exact stored version it produced. */
export async function flushComposer(target: ComposerTarget): Promise<ComposerView | undefined> {
  const current = key(target), context = apiContext()
  clearTimeout(timers.get(current)); timers.delete(current)
  const previous = saving.get(current)
  if (previous) await previous.catch(() => undefined)
  if (!isCurrentApi(context)) return
  const content = drafts.get(current)
  if (content === undefined) return remote.value[current]
  const request = api<ComposerView>(`${composerOwner(target).path}`, { method: 'PATCH', body: JSON.stringify({ content }) }, context)
  saving.set(current, request)
  try {
    const view = await request
    if (!isCurrentApi(context)) return
    if (drafts.get(current) === content) drafts.delete(current)
    const known = remote.value[current]
    if (!view.id) {
      const { [current]: _released, ...rest } = remote.value
      remote.value = rest
    } else if (!known || known.id !== view.id || known.version < view.version) remote.value = { ...remote.value, [current]: view }
    return view
  } finally { if (saving.get(current) === request) saving.delete(current) }
}
