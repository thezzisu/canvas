import type { PaneAction, PaneContext } from '../../../../shared/pane-context'
import { api, apiContext, isCurrentApi } from '../../api/api'
import { t } from '../../plugins/i18n'
import type { CanvasFileReference } from '../../utils/files/file-reference'
import { encodeMouse } from '../../utils/terminal/terminal-encoder'
import type { TerminalModifiers } from '../../utils/terminal/terminal-input'
import { bindTerminalMouseDefaults } from '../../utils/terminal/terminal-mouse-defaults'
import type { TerminalTouchMode } from '../../utils/terminal/terminal-touch'
import { bindFileInput } from '../../utils/terminal/uploads'
import type { TouchpadControl } from '../../utils/touchpad-gesture'
import { createSession } from './terminal-create'
import { acceptsFile, receivePaste, uploadReference, windowPath } from './terminal-files'
import { bindKeyboard } from './terminal-keyboard'
import { bindTerminalKeyboardLock } from './terminal-keyboard-lock'
import {
  blurTerminal,
  focusTerminal,
  operable,
  pasteText,
  sendInput,
  sendTerminalKey,
} from './terminal-keys'
import { liveTerminalMetadata, metadataKey } from './terminal-metadata'
import {
  endFocusSize,
  present,
  schedulePresentation,
  setTerminalZoom,
  updateFocusSize,
} from './terminal-presentation'
import { refreshReadFocus, syncViewVisibility } from './terminal-read-focus'
import {
  claimFocus,
  contentFocusable,
  interactive,
  inputElement,
  online,
  sessionKey,
  sessions,
  setModifiers,
  setState,
  type Session,
  type TerminalStatus,
} from './terminal-session'
import { defaultTerminalSettings, type TerminalSettings } from './terminal-settings'
import { disconnect, refreshUploads, setContentHidden, windowRemoved } from './terminal-stream'
import { installTerminalEvents } from './terminals'

/** A composer send holds terminal input at most this long, so a stalled delivery never freezes typing. */
const COMPOSER_INPUT_HOLD_MS = 5000

/**
 * Shows a window in a card's host and returns the card's handle on it. The session is created
 * on first use and adopted, screen and connection intact, by whichever card mounts it next.
 */
export function mountTerminal(
  host: HTMLElement,
  resource: Session['resource'],
  listener: (state: TerminalStatus) => void,
  options: {
    magnified?: boolean
    mobile?: boolean
    zoom?: number
    closed?: boolean
    settings?: TerminalSettings
  } = {},
) {
  installTerminalEvents()
  const context = apiContext()
  const id = sessionKey(resource)
  const settings = options.settings || defaultTerminalSettings
  const session = sessions.get(id) ?? createSession(resource, settings, context)
  sessions.set(id, session)
  // Vue may mount a replacement host before disposing the old component. Only
  // the current host owns its presentation and temporary size request.
  if (
    session.host !== host ||
    session.mobile !== (options.mobile === true) ||
    session.magnified !== (options.magnified === true)
  )
    session.touchpad.cancel()
  if (session.host !== host) {
    endFocusSize(session)
    session.available = undefined
  }
  session.mouseDefaults?.dispose()
  session.host = host
  session.viewVisible = true
  session.mobile = options.mobile === true
  session.magnified = options.magnified === true
  session.resizing = false
  session.settings = settings
  session.nativeKey = undefined
  if (!interactive(session)) {
    blurTerminal(session)
    session.keyboardRequested = false
  }
  setModifiers(session)
  host.appendChild(session.surface)
  host.style.backgroundColor = session.painter.background
  setTerminalZoom(session, options.zoom ?? 100)
  // A frame fitted to the previous host stays covered until this host has been measured.
  present(session)
  bindKeyboard(session)
  /** This card shows the session and may act on the window for the user. */
  const usable = () =>
    isCurrentApi(context) && session.host === host && host.isConnected && acceptsFile(session)
  const mine = () => session.host === host && isCurrentApi(context)
  session.keyboardLock?.dispose()
  session.keyboardLock = bindTerminalKeyboardLock(
    inputElement(session)!,
    () => !!session.host?.isConnected && operable(session) && !session.state.readOnly,
  )
  session.listeners.add(listener)
  if (options.closed) windowRemoved(session)
  listener(session.state)
  if (!options.closed && !session.connection)
    session.reconnect.resume(liveTerminalMetadata.value.get(metadataKey(resource)) !== null)
  else if (session.state.status === 'connected') session.reconnect.connected()

  const mouseDefaults = (session.mouseDefaults = bindTerminalMouseDefaults(
    session.surface,
    usable,
    () => session.settings.rightClick,
    (event, action) => {
      if (!usable()) return false
      if (action === 'down') focusTerminal(session)
      if (session.state.readOnly) return false
      sendInput(
        session,
        encodeMouse({
          type: action === 'down' ? 'press' : action === 'up' ? 'release' : 'move',
          button: 'right',
          ...session.painter.cellAt(event.clientX, event.clientY),
          shift: event.shiftKey,
          alt: event.altKey,
          ctrl: event.ctrlKey,
        }),
      )
      return true
    },
  ))
  const removeFileInput = bindFileInput(
    host,
    session.uploads,
    (draggingFile) => {
      if (session.host === host) setState(session, { ...session.state, draggingFile })
    },
    (data) => receivePaste(session, data, usable, context.signal),
  )
  const observer = new ResizeObserver((entries) => {
    const box = entries.at(-1)?.contentRect
    if (session.host !== host || !box) return
    session.available = { width: box.width, height: box.height }
    // Ask for the new grid now, so the old frame is covered before this size is painted.
    updateFocusSize(session)
    present(session)
    schedulePresentation(session)
    session.touchpad.refresh()
  })
  observer.observe(host)
  const intersection = new IntersectionObserver(
    (entries) => {
      const entry = entries.at(-1)
      if (session.host !== host || !entry) return
      session.viewVisible = entry.isIntersecting
      syncViewVisibility(session)
    },
    { rootMargin: '96px' },
  )
  intersection.observe(host)
  syncViewVisibility(session)
  schedulePresentation(session)

  return {
    setSettings(settings: TerminalSettings) {
      if (mine()) session.settings = settings
    },
    allowsContextMenu() {
      return session.mouseDefaults?.allowsContextMenu() ?? true
    },
    /** The pane under a viewport point, once the screen that shows it has settled. */
    async paneContext(x: number, y: number, signal: AbortSignal): Promise<PaneContext | null> {
      // A screen still on its way to the page has no usable layout yet. A menu asked for in
      // that moment waits for it, for a second at most, instead of reporting nothing there.
      const settled = () =>
        !!session.completion?.layout &&
        !session.resizing &&
        session.shown === session.mirror.revision
      for (let frames = 0; !settled() && frames < 60 && !signal.aborted; frames++)
        await new Promise(requestAnimationFrame)
      const layout = session.completion?.layout
      if (!usable() || !layout || !settled() || signal.aborted) return null
      const rect = session.painter.element.getBoundingClientRect()
      if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null
      const point = {
        ...session.painter.cellAt(x, y),
        cols: session.mirror.cols,
        rows: session.mirror.rows,
        layout,
      }
      return (
        await api<{ pane: PaneContext | null }>(
          `${windowPath(resource)}/pane-context`,
          { method: 'POST', body: JSON.stringify(point), signal },
          context,
        )
      ).pane
    },
    async paneAction(pane: PaneContext, command: PaneAction) {
      if (!usable()) throw new Error(t('terminal.unavailable'))
      await api(
        `${windowPath(resource)}/pane-action`,
        {
          method: 'POST',
          body: JSON.stringify({ pane: { paneId: pane.paneId, bootId: pane.bootId }, command }),
        },
        context,
      )
    },
    setEditing(value: boolean) {
      if (mine()) setContentHidden(session, 'editing', value)
    },
    setAppShowing(value: boolean) {
      if (mine()) setContentHidden(session, 'appShowing', value)
    },
    focus(options: { keyboard?: boolean } = {}) {
      if (mine()) focusTerminal(session, options.keyboard)
    },
    blur() {
      session.touchpad.cancel()
      blurTerminal(session)
      setModifiers(session)
    },
    switchKeyboard() {
      if (!mine() || !contentFocusable(session)) return
      session.touchpad.cancel()
      setModifiers(session)
      claimFocus(session)
      session.keyboard?.switchMode()
    },
    suspendKeyboard(value: boolean) {
      if (!mine()) return
      if (value) session.touchpad.cancel()
      session.keyboard?.suspend(value)
    },
    /** The composer's file picker borrows foreground without ending the keyboard's open intent. */
    holdKeyboardForPicker() {
      return session.host === host ? session.keyboard?.filePicker() : undefined
    },
    /** The open composer editor owns native input; `lost` collapses it when the keyboard closes. */
    composerKeyboard(editor?: HTMLElement, lost?: () => void) {
      if (!mine()) return
      if (editor) {
        session.touchpad.cancel()
        setModifiers(session)
      }
      session.keyboard?.composer(editor, lost)
    },
    setModifiers(modifiers: Partial<TerminalModifiers>) {
      setModifiers(session, modifiers)
    },
    setZoom(percent: number) {
      if (mine()) setTerminalZoom(session, percent)
    },
    sendKey(key: string, modifiers: Partial<TerminalModifiers> = session.modifiers) {
      sendTerminalKey(session, key, modifiers)
    },
    uploadFiles(files: File[]) {
      session.uploads.enqueue(files)
    },
    prepareFiles() {
      if (!mine()) return
      const context = apiContext(),
        revision = session.selectionRevision || 0
      const finishKeyboard = session.keyboard?.filePicker()
      let selected = false
      return {
        complete(files: File[]) {
          if (selected) return
          selected = true
          const valid =
            session.host === host &&
            isCurrentApi(context) &&
            revision === (session.selectionRevision || 0)
          finishKeyboard?.(valid)
          if (!valid || !files.length) return
          session.uploadUnverified = true
          session.uploads.enqueue(files, undefined, context)
          refreshUploads(session)
        },
        dispose() {
          selected = true
          finishKeyboard?.(false)
        },
      }
    },
    uploadReference(reference: CanvasFileReference) {
      return uploadReference(session, reference)
    },
    cancelMaximized() {
      const presentation = session.state.presentation
      if (
        !isCurrentApi(context) ||
        !presentation?.maximized ||
        presentation.lease === undefined ||
        !presentation.token ||
        session.state.presentationCancelling ||
        !online(session)
      )
        return
      setState(session, { ...session.state, presentationCancelling: true })
      session.connection!.send({
        type: 'presentation-cancel',
        token: presentation.token,
        lease: presentation.lease,
      })
    },
    async readText(signal: AbortSignal) {
      return (await api<{ text: string }>(`${windowPath(resource)}/text`, { signal }, context)).text
    },
    copySelection(text = session.selection.text) {
      return session.clipboard.copyText(text)
    },
    canPasteText: usable,
    pasteText(text: string) {
      if (!text || !usable()) return false
      pasteText(session, text)
      return true
    },
    setTouchMode(mode: TerminalTouchMode) {
      session.touchpad.cancel()
      session.touchMode = mode
      setModifiers(session)
    },
    touchpadControl(action: TouchpadControl) {
      if (mine()) session.touchpad.control(action)
    },
    setResizing(value: boolean) {
      session.resizing = value
      present(session)
    },
    close() {
      if (mine()) windowRemoved(session)
    },
    cancelUpload() {
      session.uploads.cancel()
    },
    /** Hold keystrokes until the returned release; they then follow in order. */
    holdInput() {
      return session.input.hold()
    },
    /** Deliver the stored draft version the user saw; Canvas streams its files to the native inbox. */
    sendComposer(
      composer: string,
      version: number,
      files: string[],
      done: (error?: string) => void,
    ) {
      const name =
        files.length === 1
          ? files[0]!
          : files.length
            ? t('terminal.upload.files', { count: files.length })
            : ''
      // Keystrokes typed while the send runs follow its paste. The hold starts only when the send
      // itself starts (not while it waits behind another upload) and never outlasts a few seconds.
      let release: (() => void) | undefined, limit: ReturnType<typeof setTimeout> | undefined
      const settle = () => {
        clearTimeout(limit)
        release?.()
        release = undefined
      }
      session.uploads.enqueueStored(
        { type: 'composer-send', composer, version },
        {
          name,
          fileCount: files.length,
          started: () => {
            release = session.input.hold()
            limit = setTimeout(settle, COMPOSER_INPUT_HOLD_MS)
          },
          done: (error) => {
            settle()
            done(error)
          },
        },
        context,
      )
    },
    reconnect() {
      disconnect(session)
      session.reconnect.restart()
    },
    dispose() {
      mouseDefaults.dispose()
      if (session.mouseDefaults === mouseDefaults) session.mouseDefaults = undefined
      removeFileInput()
      observer.disconnect()
      intersection.disconnect()
      session.listeners.delete(listener)
      if (session.host !== host) return
      session.selectionRevision = (session.selectionRevision || 0) + 1
      session.uploads.invalidate(t('terminal.upload.targetChanged'))
      session.uploadUnverified = false
      session.touchpad.cancel()
      session.pastePreview?.()
      session.pastePreview = undefined
      endFocusSize(session)
      if (session.mobile) session.keyboard?.blur()
      session.host = undefined
      refreshReadFocus()
      syncViewVisibility(session)
      session.keyboardLock?.dispose()
      session.keyboardLock = undefined
      session.magnified = false
      session.keyboardRequested = false
      session.reconnect.pause()
      if (session.state.status !== 'connected') disconnect(session)
    },
  }
}
