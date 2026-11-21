import type { Hono } from 'hono'
import type { Account } from '../account.ts'
import type { AssetStore } from '../assets.ts'
import type { CompletionReads } from '../completion-reads.ts'
import type { DownloadResponse } from '../media.ts'
import type { DownloadContext } from '../open-download.ts'
import type { Source, Store } from '../state.ts'
import type { TerminalManager } from '../terminals.ts'
import type { UploadService } from '../uploads.ts'
import type { WindowContentService } from '../window-content.ts'
import type { WriteOrder } from '../write-order.ts'

/** What the server gives the API beyond its store and terminals; each part is optional. */
export interface AppOptions {
  completionReads?: CompletionReads
  updateAccount?: (username: string, password?: string) => void
  allowedOrigins?: ReadonlySet<string>
  openDownload?: (ticket: string, sessionId: string) => Promise<DownloadResponse | undefined>
  prepareDownload?: (ticket: string, sessionId: string, context?: DownloadContext) => boolean
  previewFile?: (
    id: string,
    temporary: boolean,
    sessionId: string,
    publicBase: string,
  ) => Promise<{ id: string; url: string }>
  closeOpenBridge?: (sourceId: string) => Promise<void>
  assets?: AssetStore
  uploads?: UploadService
  windowContent?: WindowContentService
  openUrl?: (source: Source, url: string, sessionId: string) => { url: string; forwarded: boolean }
}

/** What every group of routes is given. */
export interface RouteContext {
  app: Hono
  store: Store
  account: Account
  terminals: TerminalManager
  options: AppOptions
  /** Composer, note and layout writes share one order. */
  order: WriteOrder
  origins: ReadonlySet<string>
  /** The source with this id; throws when there is none. */
  source(id: string): Source
}
