export type NotificationKind = 'attention' | 'done' | 'update' | 'custom'

/** A live herdr event; presentation and permission choices belong to the browser. */
export interface NativeNotification {
  kind: NotificationKind
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
}
