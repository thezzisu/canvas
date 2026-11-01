export default {
  zoom: { title: 'Terminal zoom' },
  status: {
    error: 'Error', attention: 'Needs attention', working: 'Running', done: 'Completed', idle: 'Idle', unknown: 'No status reported',
  },
  connection: {
    disconnected: 'Terminal disconnected', expired: 'Session expired', failed: 'Terminal connection failed', removed: 'Connection removed',
    timeout: 'Terminal connection timed out', connecting: 'Connecting', interrupted: 'Connection lost', reconnect: 'Reconnect', reconnecting: 'Reconnecting {attempt}/3',
  },
  upload: {
    file: 'Upload files', failed: 'Upload failed', disconnected: 'Terminal is not connected', invalidSize: 'Invalid file size', files: '{count} files',
    preparing: 'Preparing upload…', prepareTimeout: 'Upload preparation timed out', invalidUrl: 'Invalid upload URL', cancelling: 'Cancelling…',
    cancelled: 'Cancelled', pathInserted: 'Path inserted', cancel: 'Cancel upload', close: 'Dismiss upload status', progress: 'File upload progress',
    foldersUnsupported: 'Folders are not supported yet',
  },
  action: {
    cancelMaximized: 'Cancel maximization',
    addToCanvas: 'Add to canvas', removeFromCanvas: 'Remove from canvas', focus: 'Focus window', hideKeyboard: 'Hide keyboard',
    showKeyboard: 'Show keyboard', windowActions: 'Window actions', restore: 'Restore window', openWindow: 'Open window {name}',
  },
  clipboard: { failed: 'Copy failed', copied: 'Copied', macPaste: 'Use ⌘V to paste' },
  keyboard: {
    input: 'Terminal input', arrowLeft: 'Left arrow', arrowDown: 'Down arrow', arrowUp: 'Up arrow', arrowRight: 'Right arrow',
    more: 'More keys', full: 'Full keyboard', functions: 'Function keys', numbers: 'Numbers and symbols', modifiers: 'Modifiers and navigation',
    rightShift: 'Right Shift', rightAlt: 'Right Alt', rightCtrl: 'Right Ctrl', actions: 'Terminal actions', pasteText: 'Paste text',
    selectText: 'Select text', touchScroll: 'Touch scroll', touchMouse: 'Touch mouse', helperKeys: 'Terminal shortcut keys',
    terminalText: 'Terminal text', textToPaste: 'Text to paste', longPressPaste: 'Touch and hold to paste', copySelection: 'Copy selection',
    copyAll: 'Copy all', pasteIntoTerminal: 'Paste into terminal',
  },
  unavailable: 'Window unavailable', maximized: 'Maximized elsewhere', windowStatus: 'Window status', statusSummary: 'Window status: {status}',
  readOnly: 'Read-only', pane: 'Pane {name}', copyDiagnostics: 'Copy debug data', previewTitle: 'Tab title',
  tooMuchOutput: 'Too much output to announce. Navigate to the terminal rows to continue reading.',
}
