/** Capture existence belongs to the server; each browser chooses its local view. */
export interface CaptureDescriptor {
  id: string
  /** Root-relative path inside this capture, including its query and fragment. */
  path: string
  title: string
  windowId: string
  paneId: string
  preview?: 'static'
}
export interface CaptureState {
  type: 'capture'
  capture: CaptureDescriptor | null
}

/** Shared normal cards reserve the capture toolbar even when showing the terminal. */
export const captureToolbarHeight = 34
