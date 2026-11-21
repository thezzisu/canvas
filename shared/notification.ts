import type { CompletionToken } from './completion.ts'
export type NotificationKind = 'attention' | 'done' | 'update' | 'custom'

/** A live herdr event; presentation and permission choices belong to the browser. */
export interface NativeNotification {
  kind: NotificationKind
  /** A program in the pane asked for it (OSC 9/777/99): it belongs to the window showing it. */
  origin?: 'program'
  title: string
  body?: string
  agent?: string
  spaceId?: string
  windowId?: string
  paneId?: string
}

export interface CanvasNotification extends NativeNotification {
  id: string
  sourceId: string
  completion?: CompletionToken
}
