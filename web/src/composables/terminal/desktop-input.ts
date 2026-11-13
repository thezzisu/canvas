import { watchEffect } from 'vue'
import { t } from '../../plugins/i18n'
import { encodeKey } from '../../utils/terminal/terminal-encoder'

interface DesktopInputOptions {
  active(): boolean
  /** Bytes for the terminal. */
  send(data: string): void
  /**
   * A key the host decides itself: `sent` when it sent the key its own way, `native` to leave
   * the key to the browser (a paste, a copy).
   */
  key?(event: KeyboardEvent): 'sent' | 'native' | undefined
  /** Plain text pasted into the field. */
  paste(text: string): void
  /** The text an input method is composing, to show at the cursor; '' when it ends. */
  preedit?(text: string): void
  focus?(): void
  blur?(): void
  mac?: boolean
}

/**
 * The keyboard of a desktop terminal: a hidden text field that owns focus. Keys become bytes
 * through the encoder; text that is not a key (an input method, a dead key, AltGr, dictation)
 * lands in the field and is sent once it is final.
 */
export function bindDesktopInput(parent: HTMLElement, options: DesktopInputOptions) {
  const element = document.createElement('textarea')
  element.className = 'terminal-desktop-input'
  const stopLabel = watchEffect(() =>
    element.setAttribute('aria-label', t('terminal.keyboard.input')),
  )
  element.setAttribute('autocapitalize', 'off')
  element.setAttribute('autocorrect', 'off')
  element.setAttribute('autocomplete', 'off')
  element.spellcheck = false
  Object.assign(element.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    padding: '0',
    border: '0',
    opacity: '0',
    overflow: 'hidden',
    resize: 'none',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  })
  let composing = false
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  function commit() {
    clearTimeout(commitTimer)
    commitTimer = undefined
    const text = element.value
    element.value = ''
    if (text && options.active()) options.send(text)
  }
  const key = (event: KeyboardEvent) => {
    if (!options.active()) {
      event.preventDefault()
      return
    }
    // Candidate confirmation and navigation belong to the input method, also on platforms
    // that leave isComposing off its final key.
    if (composing || event.isComposing || event.keyCode === 229) return
    // Text still waiting to be read was typed before this key.
    if (commitTimer !== undefined) commit()
    const decided = options.key?.(event)
    if (decided === 'sent') event.preventDefault()
    if (decided) return
    const data = encodeKey(event, options.mac)
    if (data === undefined) return
    event.preventDefault()
    if (data) options.send(data)
  }
  const beforeInput = (event: InputEvent) => {
    if (!options.active()) event.preventDefault()
  }
  const input = (event: Event) => {
    if (!composing && !(event as InputEvent).isComposing && commitTimer === undefined) commit()
  }
  const start = () => {
    if (commitTimer !== undefined) commit()
    composing = true
  }
  const update = (event: CompositionEvent) => {
    options.preedit?.(event.data)
  }
  const end = () => {
    composing = false
    options.preedit?.('')
    // Browsers disagree on whether the final edit precedes compositionend. Read the field
    // once, after both, instead of trusting either event's data.
    clearTimeout(commitTimer)
    commitTimer = setTimeout(commit, 0)
  }
  const paste = (event: ClipboardEvent) => {
    event.preventDefault()
    event.stopPropagation()
    const text = event.clipboardData?.getData('text/plain') || ''
    if (text && options.active()) options.paste(text)
  }
  const focus = () => {
    if (!composing && commitTimer === undefined) element.value = ''
    options.focus?.()
  }
  const blur = () => options.blur?.()
  element.addEventListener('keydown', key)
  element.addEventListener('beforeinput', beforeInput)
  element.addEventListener('input', input)
  element.addEventListener('compositionstart', start)
  element.addEventListener('compositionupdate', update)
  element.addEventListener('compositionend', end)
  element.addEventListener('paste', paste)
  element.addEventListener('focus', focus)
  element.addEventListener('blur', blur)
  parent.append(element)
  const refresh = () => {
    element.tabIndex = options.active() ? 0 : -1
  }
  refresh()
  return {
    element,
    /** Tab reaches the field only while the terminal takes keys. */
    refresh,
    /** Puts the field at the cursor, in the parent's own pixels: the input method opens beside it. */
    moveTo(box: { left: number; top: number; height: number }) {
      element.style.transform = `translate(${box.left}px,${box.top}px)`
      element.style.height = element.style.lineHeight = `${box.height}px`
    },
    dispose() {
      stopLabel()
      clearTimeout(commitTimer)
      element.removeEventListener('keydown', key)
      element.removeEventListener('beforeinput', beforeInput)
      element.removeEventListener('input', input)
      element.removeEventListener('compositionstart', start)
      element.removeEventListener('compositionupdate', update)
      element.removeEventListener('compositionend', end)
      element.removeEventListener('paste', paste)
      element.removeEventListener('focus', focus)
      element.removeEventListener('blur', blur)
      element.remove()
    },
  }
}
