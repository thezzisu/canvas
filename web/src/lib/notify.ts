import type { Toast } from '@nuxt/ui/composables/useToast'
import type { ButtonProps } from '@nuxt/ui'

/**
 * How long a notice stays, by what the reader has to do with it. Every notice
 * leaves by itself; hovering or focusing a toast pauses its timer. Only a toast
 * that waits for a decision (an update prompt, an undo with its own deadline, a
 * terminal asking for attention) sets its own duration.
 */
export const noticeDuration = {
  /** Confirms a gesture the reader just made, such as a copy. */
  brief: 1500,
  success: 3000,
  info: 4000,
  warning: 6000,
  error: 8000,
} as const
export type NoticeKind = keyof typeof noticeDuration

/** Toast actions share a neutral treatment, independent of the notice's status. */
export const toastAction = {
  color: 'neutral',
  variant: 'outline',
  size: 'md',
} satisfies ButtonProps

const noticeColor = {
  brief: 'success',
  success: 'success',
  info: 'neutral',
  warning: 'warning',
  error: 'error',
} as const satisfies Record<NoticeKind, Toast['color']>

type Notice = Partial<Toast>
type Sink = (notice: Notice) => void
let sink: Sink | undefined
const waiting: Notice[] = []

/** The app shell owns the toaster; notices raised before it mounts are shown once it does. */
export function installNotices(show: Sink) {
  sink = show
  for (const notice of waiting.splice(0)) show(notice)
}

export function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason)
}

function notice(kind: NoticeKind, title: string, options?: Notice) {
  const entry: Notice = {
    title,
    color: noticeColor[kind],
    duration: noticeDuration[kind],
    type: 'background',
    ...options,
  }
  if (sink) sink(entry)
  else waiting.push(entry)
}

/** Usable from any module; a notice with an `id` replaces the one already showing under it. */
export const notify = {
  brief: (title: string, options?: Notice) => notice('brief', title, options),
  success: (title: string, options?: Notice) => notice('success', title, options),
  info: (title: string, options?: Notice) => notice('info', title, options),
  warning: (title: string, options?: Notice) => notice('warning', title, options),
  /** A cancelled request is not a failure the reader can act on. */
  error(reason: unknown, options?: Notice) {
    if (reason instanceof Error && reason.name === 'AbortError') return
    notice('error', errorMessage(reason), options)
  },
}
