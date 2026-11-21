import type { CompletionToken } from '../shared/completion.ts'
import type { NativeNotification } from '../shared/notification.ts'
import type { PaneAction, PaneContext, PanePoint } from '../shared/pane-context.ts'
import type { MouseArea } from '../shared/terminal-mouse.ts'
import type { WindowMetadata } from '../shared/window-metadata.ts'
import type { Latest, Subscribable } from './channels.ts'
import type { NativeContentPane } from './herdr/content.ts'
import type { FrameData } from './herdr/wire.ts'

/** A window's composed grid, with where its programs take the mouse. */
export interface Screen {
  grid: FrameData
  mouse: readonly MouseArea[]
}
export type TransportExit = { exitCode: number; signal?: number; reason?: 'removed' }

/**
 * One native window as Canvas uses it. Core (herdr-core) and herdr each provide one. Core is the
 * reference: herdr leaves out what its protocol does not carry, so herdr windows never produce
 * progress, pointer shapes or program notifications, and their bells name no pane.
 */
export interface WindowTransport {
  readonly screen: Subscribable<Screen>
  /**
   * The metadata a screen painted, once it is safe to acknowledge, after that screen's
   * subscribers ran.
   */
  readonly painted: Subscribable<WindowMetadata>
  readonly metadata: Subscribable<WindowMetadata>
  readonly paneFocus: Subscribable<string | undefined>
  /** Each native snapshot. */
  readonly snapshots: Subscribable<void>
  /** Base64 text a pane or a Canvas selection copied. */
  readonly copies: Subscribable<string>
  /** The window rang its bell (BEL): in this pane, or in one the runtime does not name. */
  readonly bells: Subscribable<string | undefined>
  readonly notifications: Subscribable<NativeNotification>
  readonly exit: Subscribable<TransportExit>
  completionSnapshot():
    { windows: WindowMetadata[]; state: { bootId: string; revision: number } } | undefined
  completionFence(): Promise<WindowMetadata | undefined>
  acknowledgeCompletion?(paneId: string, completion: CompletionToken): Promise<void>
  content(): Promise<NativeContentPane[] | undefined>
  paneContext(point: PanePoint): PaneContext | undefined
  paneAction(context: PaneContext, action: PaneAction, authorized?: () => boolean): Promise<unknown>
  write(data: string | Buffer): void
  resize(cols: number, rows: number): void
  kill(): void
}

export function validateViewport(cols: number, rows: number, runtime: string) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 4096 ||
    rows > 4096 ||
    cols * rows > 1_000_000
  )
    throw new Error(`Invalid ${runtime} viewport size`)
}

/** Base64 a pane copied, no longer than browsers are sent. */
export const isClipboardPayload = (data: string) =>
  data.length <= 2 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/u.test(data)

/**
 * The next painted metadata that `accept` takes, or undefined once the window exits. Paint the
 * window after calling this, so that the paint is seen.
 */
export function nextPaint(
  painted: Latest<WindowMetadata>,
  exit: Latest<TransportExit>,
  accept: (metadata: WindowMetadata) => boolean = () => true,
): Promise<WindowMetadata | undefined> {
  return new Promise((resolve) => {
    const subscriptions = new DisposableStack()
    const settle = (metadata?: WindowMetadata) => {
      subscriptions.dispose()
      resolve(metadata)
    }
    subscriptions.use(
      painted.subscribe(
        (metadata) => {
          if (accept(metadata)) settle(metadata)
        },
        { replay: false },
      ),
    )
    subscriptions.use(exit.subscribe(() => settle()))
  })
}
