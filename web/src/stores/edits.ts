import { defineStore } from 'pinia'
import { createEventHook } from '@vueuse/core'
import { apiContext, isCurrentApi, orderedWrite, requireCurrentApi, segment } from '../api/api'
import { createAutosave } from '../utils/autosave'
import { notify } from '../composables/notify'
import { createKeepaliveCopies, guardPageExit, pendingWrites } from '../composables/pending-writes'
import { createLayoutSaves, type LayoutPatch } from '../utils/canvas/layout-saves'
import {
  createPendingEdits,
  mergeNoteEdits,
  retargetNoteEdit,
  type NoteEdit,
} from '../utils/canvas/pending-edits'
import type { Canvas, NotePatch } from '../api/types'
import { useWorkspaceStore } from './workspace'

const LAYOUT_SAVE_DELAY_MS = 450
const noteKey = (canvasId: string, id: string) => `${canvasId}/${id}`
/** The save-status owner of a canvas's card positions and sizes. */
export const layoutOwner = (canvasId: string) => `layout:${canvasId}`

/**
 * This browser's unsaved note text and card geometry. Edits apply to the shared
 * canvases at once, are written in the background, and survive a reload of the tab.
 */
export const useEditsStore = defineStore('edits', () => {
  const workspace = useWorkspaceStore()
  const pendingNotes = new Map<string, NoteEdit>()
  const savingNotes = new Map<string, NoteEdit>()
  const noteTimers = createAutosave()
  let noteSave: Promise<boolean> | undefined
  const noteCopies = createKeepaliveCopies()
  const layoutSaves = createLayoutSaves()
  const pendingLayouts = layoutSaves.pending
  const layoutTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const stored = createPendingEdits(sessionStorage)
  /** The endpoint whose stored drafts are loaded; empty until its first snapshot. */
  let draftBase = ''
  /** A staged layout draft counts as unsaved work when the page is closed. */
  let unsavedDraft = () => false
  const noteChanged = createEventHook<string>()

  const unsavedNotes = () => [...savingNotes.values(), ...pendingNotes.values()]
  const noteEdited = (id: string) => unsavedNotes().some((edit) => edit.id === id)
  const canvasHolds = (canvasId: string, id: string) =>
    !!workspace.canvases
      .find((canvas) => canvas.id === canvasId)
      ?.nodes.some((node) => node.id === id)
  function checkpoint() {
    stored.save(draftBase, pendingLayouts, unsavedNotes())
  }

  function clearNotes(canvasId?: string, id?: string) {
    const cleared = new Set<string>()
    const matches = (edit: NoteEdit) =>
      (!canvasId || edit.canvasId === canvasId) && (!id || edit.id === id)
    for (const [key, edit] of pendingNotes)
      if (matches(edit)) {
        noteTimers.cancel(key)
        pendingNotes.delete(key)
        cleared.add(edit.id)
      }
    for (const [key, edit] of savingNotes)
      if (matches(edit)) {
        savingNotes.delete(key)
        cleared.add(edit.id)
      }
    for (const note of cleared) if (!noteEdited(note)) pendingWrites.discard(note)
  }
  function dropLayout(canvasId: string) {
    clearTimeout(layoutTimers.get(canvasId))
    layoutTimers.delete(canvasId)
    pendingLayouts.delete(canvasId)
    pendingWrites.discard(layoutOwner(canvasId))
  }
  /** Forget a deleted canvas's or removed card's unsaved work. */
  function discard(canvasId: string, nodeId?: string) {
    if (nodeId) pendingLayouts.get(canvasId)?.delete(nodeId)
    else dropLayout(canvasId)
    clearNotes(canvasId, nodeId)
  }

  /** Before a snapshot is applied: load this endpoint's stored drafts once, and move
   * note edits whose canvas reference was removed to another canvas holding the note. */
  let restored = false
  function adopt(next: Canvas[]) {
    if (!draftBase) {
      draftBase = apiContext().base
      const drafts = stored.read(draftBase, next)
      for (const [canvasId, nodes] of drafts.layouts)
        for (const [id, patch] of nodes) layoutSaves.set(canvasId, id, patch)
      for (const edit of drafts.notes) pendingNotes.set(noteKey(edit.canvasId, edit.id), edit)
      restored = pendingLayouts.size > 0 || pendingNotes.size > 0
    }
    let moved = false
    for (const key of new Set([...savingNotes.keys(), ...pendingNotes.keys()])) {
      const saving = savingNotes.get(key),
        pending = pendingNotes.get(key),
        previous = pending || saving
      if (!previous) continue
      const edit = { ...previous, patch: { ...saving?.patch, ...pending?.patch } }
      const target = retargetNoteEdit(edit, next)
      if (target?.canvasId === edit.canvasId) continue
      clearNotes(edit.canvasId, edit.id)
      if (!target) continue
      const nextKey = noteKey(target.canvasId, target.id)
      pendingNotes.set(nextKey, {
        ...target,
        patch: { ...target.patch, ...pendingNotes.get(nextKey)?.patch },
      })
      pendingWrites.start(target.id)
      moved = true
    }
    if (moved) queueMicrotask(() => void flushNotes())
  }
  /** Unsaved note fields by note, for the canvases that still hold the note. */
  function noteDrafts(next: Canvas[]) {
    const drafts = new Map<string, NotePatch>()
    for (const edit of unsavedNotes())
      if (
        next.some(
          (canvas) =>
            canvas.id === edit.canvasId &&
            canvas.nodes.some((node) => node.id === edit.id && node.type === 'note'),
        )
      )
        drafts.set(edit.id, { ...drafts.get(edit.id), ...edit.patch })
    return drafts
  }
  /** After a snapshot is applied: drop work on canvases and cards that no longer exist. */
  function settle(next: Canvas[]) {
    for (const id of new Set([...layoutTimers.keys(), ...pendingLayouts.keys()]))
      if (!next.some((canvas) => canvas.id === id)) dropLayout(id)
    for (const edit of unsavedNotes())
      if (!canvasHolds(edit.canvasId, edit.id)) clearNotes(edit.canvasId, edit.id)
    checkpoint()
    if (restored) {
      restored = false
      queueMicrotask(() => saveAll())
    }
  }

  function editNote(canvasId: string, id: string, patch: NotePatch) {
    const node = workspace.canvases
      .find((canvas) => canvas.id === canvasId)
      ?.nodes.find((node) => node.id === id)
    if (!node || node.type !== 'note') return
    const changed = Object.fromEntries(
      Object.entries(patch).filter(([key, value]) => node[key as keyof NotePatch] !== value),
    ) as NotePatch
    if (!Object.keys(changed).length) return
    // Every canvas reference shows the same note.
    for (const canvas of workspace.canvases)
      for (const reference of canvas.nodes)
        if (reference.type === 'note' && reference.id === id) Object.assign(reference, changed)
    // Queued writes from another canvas must not replay an older shared field.
    for (const edit of unsavedNotes())
      if (edit.id === id)
        for (const [field, value] of Object.entries(changed))
          if (Object.hasOwn(edit.patch, field)) Object.assign(edit.patch, { [field]: value })
    const key = noteKey(canvasId, id)
    pendingNotes.set(key, { canvasId, id, patch: { ...pendingNotes.get(key)?.patch, ...changed } })
    checkpoint()
    pendingWrites.start(id)
    noteTimers.schedule(key, () => void flushNotes(canvasId, { force: false }))
    void noteChanged.trigger(id)
  }
  const writeNote = (edit: NoteEdit, keepalive: boolean, context = apiContext()) =>
    orderedWrite(
      `/api/canvases/${segment(edit.canvasId)}/notes/${segment(edit.id)}`,
      edit.patch,
      keepalive,
      context,
    )
  const carried = (edit: NoteEdit) =>
    [noteKey(edit.canvasId, edit.id), JSON.stringify(edit.patch)] as const
  /** Store pending notes; `force: false` leaves those still inside their typing pause. */
  async function flushNotes(
    canvasId?: string,
    options: { force?: boolean; keepalive?: boolean } = {},
  ): Promise<boolean> {
    const context = apiContext(),
      { force = true, keepalive = false } = options
    // A failed earlier batch leaves its edits pending; this flush sends them again with its own.
    if (noteSave) {
      // A closing page may cancel the save in flight, so a keepalive copy of every unsaved note
      // goes out, unless a keepalive request already carries exactly its fields.
      // That save and the flush after it still store and confirm them.
      if (keepalive)
        for (const edit of mergeNoteEdits(unsavedNotes())) {
          const [key, value] = carried(edit)
          if ((!canvasId || edit.canvasId === canvasId) && noteCopies.claim(key, value))
            void writeNote(edit, true, context).catch(() => noteCopies.release(key, value))
        }
      await noteSave
      return isCurrentApi(context) && flushNotes(canvasId, options)
    }
    const batch = [...pendingNotes.entries()].filter(
      ([key, edit]) => (!canvasId || edit.canvasId === canvasId) && (force || !noteTimers.has(key)),
    )
    if (!batch.length) return true
    for (const [key, edit] of batch) {
      noteTimers.cancel(key)
      pendingNotes.delete(key)
      savingNotes.set(key, edit)
      pendingWrites.start(edit.id)
    }
    // Notes are independent, so a page being discarded sends all of them at once.
    noteSave = (async () => {
      const results = await Promise.all(
        batch.map(async ([key, edit]) => {
          try {
            if (keepalive) noteCopies.claim(...carried(edit))
            await writeNote(edit, keepalive, context)
            if (savingNotes.get(key) !== edit) return true
            savingNotes.delete(key)
            if (!noteEdited(edit.id)) pendingWrites.saved(edit.id)
            return true
          } catch (reason) {
            if (!isCurrentApi(context) || savingNotes.get(key) !== edit) return true
            savingNotes.delete(key)
            if (canvasHolds(edit.canvasId, edit.id)) {
              pendingNotes.set(key, {
                ...edit,
                patch: { ...edit.patch, ...pendingNotes.get(key)?.patch },
              })
              pendingWrites.failed(edit.id, () => void flushNotes())
            } else if (!noteEdited(edit.id)) pendingWrites.discard(edit.id)
            notify.error(reason)
            return false
          }
        }),
      )
      if (!isCurrentApi(context)) return false
      checkpoint()
      await workspace.sync().catch(notify.error)
      return isCurrentApi(context) && results.every(Boolean)
    })()
    let saved = false
    try {
      saved = await noteSave
    } finally {
      if (isCurrentApi(context)) {
        noteSave = undefined
        noteCopies.forget()
      }
    }
    if (!saved || !isCurrentApi(context)) return false
    return force ? flushNotes(canvasId, options) : true
  }

  /** Move or resize a card now; the write follows shortly, batched per canvas. */
  function editLayout(canvasId: string, id: string, patch: LayoutPatch) {
    const node = workspace.canvases
      .find((canvas) => canvas.id === canvasId)
      ?.nodes.find((item) => item.id === id)
    if (!node) return
    layoutSaves.set(canvasId, id, patch)
    checkpoint()
    Object.assign(node, patch)
    clearTimeout(layoutTimers.get(canvasId))
    pendingWrites.start(layoutOwner(canvasId))
    layoutTimers.set(
      canvasId,
      setTimeout(() => void flushLayout(canvasId).catch(notify.error), LAYOUT_SAVE_DELAY_MS),
    )
  }
  async function flushLayout(canvasId: string, keepalive = false) {
    const context = apiContext(),
      owner = layoutOwner(canvasId),
      tracked = pendingLayouts.has(canvasId)
    clearTimeout(layoutTimers.get(canvasId))
    layoutTimers.delete(canvasId)
    if (tracked) pendingWrites.start(owner)
    try {
      await layoutSaves.flush(
        canvasId,
        (batch) =>
          orderedWrite(
            `/api/canvases/${segment(canvasId)}/layout`,
            { nodes: [...batch].map(([id, patch]) => ({ id, ...patch })) },
            keepalive,
            context,
          ),
        checkpoint,
        keepalive,
      )
    } catch (reason) {
      if (isCurrentApi(context)) {
        checkpoint()
        pendingWrites.failed(owner, () => void flushLayout(canvasId).catch(notify.error))
      }
      throw reason
    }
    requireCurrentApi(context)
    if (tracked && !pendingLayouts.has(canvasId)) pendingWrites.saved(owner)
    await workspace.sync()
  }

  /** Send every pending note and layout without waiting on one another. */
  function saveAll(keepalive = false) {
    void flushNotes(undefined, { keepalive })
    for (const id of pendingLayouts.keys()) void flushLayout(id, keepalive).catch(notify.error)
  }
  /** Store everything and report whether it all reached the server. */
  async function flushAll() {
    const context = apiContext()
    try {
      do {
        if (!(await flushNotes()) || !isCurrentApi(context)) return false
        await Promise.all([...pendingLayouts.keys()].map((id) => flushLayout(id)))
        if (!isCurrentApi(context)) return false
      } while (pendingLayouts.size || pendingNotes.size || savingNotes.size || layoutSaves.saving)
      return true
    } catch (reason) {
      if (isCurrentApi(context)) notify.error(reason)
      return false
    }
  }

  /** Leaving the instance keeps unsaved work in this tab's storage for its return. */
  function suspend() {
    checkpoint()
    draftBase = ''
    restored = false
    for (const timer of layoutTimers.values()) clearTimeout(timer)
    layoutTimers.clear()
    layoutSaves.reset()
    clearNotes()
    noteTimers.clear()
    noteSave = undefined
    noteCopies.forget()
    unsavedDraft = () => false
  }

  guardPageExit(pendingWrites, () => unsavedDraft())
  pendingWrites.onFlush(saveAll)

  return {
    pendingLayouts,
    /** The canvas view reports a layout draft that closing the page would lose. */
    guardDraft(unsaved: () => boolean) {
      unsavedDraft = unsaved
      return () => {
        if (unsavedDraft === unsaved) unsavedDraft = () => false
      }
    },
    onNoteChanged: noteChanged.on,
    adopt,
    noteDrafts,
    settle,
    editNote,
    flushNotes,
    editLayout,
    flushLayout,
    flushAll,
    discard,
    suspend,
  }
})
