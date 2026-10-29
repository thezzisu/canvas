interface MobileInputOptions {
  active(): boolean
  input(text: string): void
  paste(text: string): void
  files(files: File[]): void
  key(event: KeyboardEvent): void
  special(key: string): void
  composing(): void
  focus(): void
  blur(): void
}

/** Android advertises image insertion only for a richly editable input. */
export function bindMobileInput(parent: HTMLElement, options: MobileInputOptions) {
  const element = document.createElement('div')
  element.className = 'terminal-mobile-input'
  element.setAttribute('role', 'textbox')
  element.setAttribute('aria-label', '终端输入')
  element.setAttribute('aria-multiline', 'true')
  element.setAttribute('autocapitalize', 'off')
  element.setAttribute('autocorrect', 'off')
  element.spellcheck = false
  element.tabIndex = 0
  Object.assign(element.style, { position: 'absolute', left: '0', top: '0', width: '1px', height: '20px',
    opacity: '0', overflow: 'hidden', whiteSpace: 'pre', fontSize: '16px', lineHeight: '20px', pointerEvents: 'none' })
  let editable = false
  let composing = false
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  // A preceding character lets Android's deleteSurroundingText emit Backspace
  // even after the previous input has already been sent to the terminal.
  const anchor = '\u200b'
  const placeCaret = () => {
    if (editable && document.activeElement === element && element.firstChild) {
      document.getSelection()?.collapse(element.firstChild, element.firstChild.textContent?.length || 0)
    }
  }
  const clear = () => {
    element.textContent = anchor
    placeCaret()
  }
  function commit() {
    clearTimeout(commitTimer); commitTimer = undefined
    const text = (element.textContent || '').replace(/^\u200b/, '')
    clear()
    if (text && editable && options.active()) options.input(text)
  }
  function setEditable(value: boolean) {
    // Focus restoration and ordinary terminal taps must not rewrite the IME's
    // editing state or selection while a composition is in progress.
    if (editable === value && element.contentEditable === String(value)) return
    editable = value
    // plaintext-only would make Chromium reject Gboard image commits again.
    element.contentEditable = String(value)
    element.setAttribute('aria-readonly', String(!value))
    element.inputMode = value ? 'text' : 'none'
    if (!value) { clearTimeout(commitTimer); commitTimer = undefined; composing = false; clear() }
    else placeCaret()
  }
  const key = (event: KeyboardEvent) => {
    if (!options.active()) { event.preventDefault(); return }
    // Candidate confirmation/navigation belongs to the IME even on keyboards
    // that omit KeyboardEvent.isComposing on their final Enter key.
    if (composing) return
    if (event.type === 'keydown' && !event.isComposing && event.keyCode !== 229 && commitTimer !== undefined) commit()
    options.key(event)
  }
  const beforeInput = (event: InputEvent) => {
    if (!editable || !options.active()) { event.preventDefault(); return }
    if (composing || event.isComposing || event.inputType === 'insertCompositionText') return
    const files = [...event.dataTransfer?.files || []]
    if (files.length) {
      event.preventDefault(); options.files(files); return
    }
    if (event.inputType === 'insertFromPaste') {
      event.preventDefault(); options.paste(event.dataTransfer?.getData('text/plain') || event.data || ''); return
    }
    const special: Record<string, string> = {
      insertParagraph: 'Enter', insertLineBreak: 'Enter',
      deleteContentBackward: 'Backspace', deleteContentForward: 'Delete',
    }
    if (special[event.inputType]) {
      event.preventDefault()
      if (commitTimer !== undefined) commit()
      options.special(special[event.inputType]!); clear()
    }
  }
  const input = (event: Event) => { if (!composing && !(event as InputEvent).isComposing && commitTimer === undefined) commit() }
  const start = () => {
    if (commitTimer !== undefined) commit()
    composing = true; options.composing()
  }
  const end = () => {
    composing = false
    // Chromium can deliver the final DOM edit after compositionend. Read that
    // edit once instead of forwarding both the composition and input events.
    clearTimeout(commitTimer); commitTimer = setTimeout(commit, 0)
  }
  const paste = (event: ClipboardEvent) => {
    // File paste is captured by the existing host upload handler before this.
    event.preventDefault(); event.stopPropagation()
    if (editable && options.active()) options.paste(event.clipboardData?.getData('text/plain') || '')
  }
  const focus = () => { if (!composing) clear(); options.focus() }
  const blur = () => { if (commitTimer !== undefined) commit(); options.blur() }
  element.addEventListener('keydown', key); element.addEventListener('keypress', key); element.addEventListener('keyup', key)
  element.addEventListener('beforeinput', beforeInput); element.addEventListener('input', input)
  element.addEventListener('compositionstart', start); element.addEventListener('compositionend', end)
  element.addEventListener('paste', paste); element.addEventListener('focus', focus); element.addEventListener('blur', blur)
  setEditable(false)
  parent.append(element)
  return {
    element, setEditable,
    dispose() {
      clearTimeout(commitTimer)
      element.removeEventListener('keydown', key); element.removeEventListener('keypress', key); element.removeEventListener('keyup', key)
      element.removeEventListener('beforeinput', beforeInput); element.removeEventListener('input', input)
      element.removeEventListener('compositionstart', start); element.removeEventListener('compositionend', end)
      element.removeEventListener('paste', paste); element.removeEventListener('focus', focus); element.removeEventListener('blur', blur)
      element.remove()
    },
  }
}
