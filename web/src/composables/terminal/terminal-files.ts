import { apiContext, isCurrentApi, segment, uuid } from '../../api/api'
import { t } from '../../plugins/i18n'
import type { CanvasFileReference } from '../../utils/files/file-reference'
import { loadCanvasFile } from '../../utils/files/file-transfer'
import {
  loadNoteClipboard,
  NOTE_CLIPBOARD_TYPE,
  readNoteClipboard,
  terminalNoteClipboard,
  type NoteClipboard,
} from '../../utils/notes/note-clipboard'
import { previewWindowFile } from '../../utils/terminal/content-scan'
import { captureRichPaste } from '../../utils/terminal/rich-paste'
import { activateTerminalLink } from '../../utils/terminal/terminal-links'
import { reportDownloadError } from '../files/downloads'
import { previewRichPaste } from './rich-paste-dialog'
import { focusTerminal, operable, pasteText } from './terminal-keys'
import { paused, setState, type Session } from './terminal-session'
import { presentSourceUrl, presentUrl } from './urls'

// Files and links between this browser and the window's source.

export const windowPath = ({ sourceId, spaceId, windowId }: Session['resource']) =>
  `/api/sources/${segment(sourceId)}/spaces/${segment(spaceId)}/windows/${segment(windowId)}`

/** This view may hand the window a file or pasted text. */
export function acceptsFile(session: Session) {
  return operable(session) && !paused(session)
}

/** Reads something from Canvas for the window, one read at a time; failures show as upload errors. */
async function readFor(
  session: Session,
  read: (signal: AbortSignal) => Promise<(() => void) | undefined>,
) {
  if (!acceptsFile(session)) {
    session.uploads.reject(t('terminal.upload.disconnected'))
    return
  }
  const context = apiContext(),
    connection = session.connection,
    controller = (session.fileRead = new AbortController())
  setState(session, { ...session.state, fileReading: true })
  try {
    const deliver = await read(AbortSignal.any([context.signal, controller.signal]))
    if (!isCurrentApi(context) || controller.signal.aborted || session.connection !== connection)
      return
    if (!acceptsFile(session)) throw new Error('terminal.upload.disconnected')
    deliver?.()
  } catch (reason) {
    if (!isCurrentApi(context) || controller.signal.aborted) return
    const message =
      reason instanceof Error &&
      (reason.message.startsWith('fileTransfer.') ||
        reason.message === 'terminal.upload.disconnected')
        ? t(reason.message)
        : t('fileTransfer.failed')
    session.uploads.reject(message)
  } finally {
    if (session.fileRead === controller) {
      session.fileRead = undefined
      setState(session, { ...session.state, fileReading: false })
    }
  }
}
/** Uploads a file that Canvas holds. */
export async function uploadReference(session: Session, reference: CanvasFileReference) {
  if (session.fileRead) return
  await readFor(session, async (signal) => {
    const file = await loadCanvasFile(reference, signal)
    return () => session.uploads.enqueue([file])
  })
}
/** Pastes a copied note: its text, and its files as uploads. */
async function pasteNote(session: Session, note: NoteClipboard) {
  if (session.fileRead) {
    session.uploads.reject(t('panels.file.uploadBusy'))
    return
  }
  await readFor(session, async (signal) => {
    const { files, parts } = await loadNoteClipboard(note, (reference) =>
      loadCanvasFile(reference, signal),
    )
    return () => {
      if (!files.length) return pasteText(session, parts.join(''))
      // File-only clipboard selections retain separate path pastes for agents.
      const paste = terminalNoteClipboard({ files, parts })
      session.uploads.enqueue(paste.files, paste.parts)
    }
  })
}

/**
 * A paste that is more than plain text: a copied note, or rich content the user first reviews.
 * False leaves the paste to the terminal's input. `usable` is the pasting card's own check.
 */
export function receivePaste(
  session: Session,
  data: DataTransfer,
  usable: () => boolean,
  signal: AbortSignal,
): boolean {
  if (data.types.includes(NOTE_CLIPBOARD_TYPE)) {
    const note = readNoteClipboard(data)
    if (note) void pasteNote(session, note)
    else session.uploads.reject(t('fileTransfer.failed'))
    return true
  }
  const model = captureRichPaste(data)
  if (!model) return false
  if (!usable()) {
    session.uploads.reject(t('terminal.upload.disconnected'))
    return true
  }
  const connection = session.connection
  session.pastePreview?.()
  const dismiss = previewRichPaste(
    model,
    signal,
    (result) => {
      if (session.connection !== connection || !usable()) {
        session.uploads.reject(t('terminal.upload.disconnected'))
        return
      }
      if (result.files.length) session.uploads.enqueue(result.files, result.parts)
      else if (result.preview) {
        pasteText(session, result.preview)
        focusTerminal(session)
      }
    },
    () => {
      if (session.pastePreview === dismiss) session.pastePreview = undefined
    },
  )
  session.pastePreview = dismiss
  return true
}

/**
 * What a click on a link opens. Terminal output controls link text, so a public address opens
 * only after showing the real URL; a local one is forwarded from the source; a file is previewed.
 */
export function openTerminalLink(session: Session, uri: string) {
  activateTerminalLink(uri, {
    openWeb: (url) => presentUrl({ id: uuid(), url, forwarded: false }),
    forwardWeb: (url) =>
      void presentSourceUrl(session.resource.sourceId, url, apiContext()).catch(
        reportDownloadError,
      ),
    openFile: (path) => {
      if (session.fileLink) return
      const opening = (session.fileLink = previewWindowFile(
        windowPath(session.resource),
        path,
        apiContext(),
      )
        .catch(reportDownloadError)
        .finally(() => {
          if (session.fileLink === opening) session.fileLink = undefined
        }))
    },
  })
}
