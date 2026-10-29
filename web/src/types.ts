import type { GlobalSettings } from '../../shared/settings'

export type SourceType = 'tmux' | 'herdr'
export interface Source {
  id: string
  name: string
  type: SourceType
  transport: 'local' | 'ssh'
  target?: string
  sshIdentityFile?: string
  sshKnownHostsFile?: string
  binary?: string
  tmuxSocket?: string
  herdrSession?: string
}
export type ProgramStatus = 'error' | 'attention' | 'working' | 'done' | 'idle' | 'unknown'
export type StatusSource = 'herdr' | 'osc9' | 'osc7501' | 'none'
export interface PaneResource {
  id: string
  name: string
  active: boolean
  status: ProgramStatus
  statusSource: StatusSource
  nativeStatus?: string
  agent?: string
  progress?: number
}
export interface WindowResource {
  id: string
  name: string
  status?: ProgramStatus
  statusSource?: StatusSource
  nativeStatus?: string
  panes?: PaneResource[]
}
export interface SpaceResource { id: string; name: string; windows: WindowResource[] }
export interface SourceResource {
  id: string
  name: string
  type: SourceType
  host: string
  status: string
  error?: string
  spaces: SpaceResource[]
}
export interface NodeLayout {
  id: string
  x: number
  y: number
  width: number
  height: number
}
export interface TerminalCanvasNode extends NodeLayout {
  type: 'terminal'
  sourceId: string
  spaceId: string
  windowId: string
}
export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink' | 'neutral'
export interface NoteCanvasNode extends NodeLayout {
  type: 'note'
  title: string
  content: string
  color: NoteColor
  minimized: boolean
}
export interface FileAsset {
  id: string
  filename: string
  size: number
  mime: string
  preview: 'image' | 'pdf' | 'text' | 'file'
  createdAt: number
}
export interface FileCanvasNode extends NodeLayout {
  type: 'file'
  assetId: string
  asset: FileAsset
}
export type CanvasNode = TerminalCanvasNode | NoteCanvasNode | FileCanvasNode
export const isTerminalNode = (node: CanvasNode): node is TerminalCanvasNode => node.type === 'terminal'
export type NotePatch = Partial<Pick<NoteCanvasNode, 'title' | 'content' | 'color' | 'minimized'>>
export interface Canvas { id: string; name: string; nodes: CanvasNode[]; snapToGrid?: boolean; background?: { url: string; opacity: number } | null }
export interface WindowSize { width: number; height: number }
export interface SharedState { instanceId: string; revision: number; sources: Source[]; canvases: Canvas[]; overviewBackground: Canvas['background']; windowSizes: Record<string, WindowSize>; settings: GlobalSettings }
export interface TerminalData {
  sourceId: string
  spaceId: string
  windowId: string
  name: string
  subtitle: string
  width: number
  height: number
  available: boolean
  status: ProgramStatus
  panes: PaneResource[]
  overview: boolean
  focus: boolean
  mobile?: boolean
  onAction: (action: string, id: string) => void
  onResize: (id: string, width: number, height: number, x?: number, y?: number) => void
  onLayoutStart: () => void
  onGeometry: (sourceId: string, windowId: string, ratio: number, insetX: number, insetY: number) => void
}
export interface NoteData extends NoteCanvasNode {
  onResize: (id: string, width: number, height: number, x?: number, y?: number) => void
  onLayoutStart: () => void
  onChange: (id: string, patch: NotePatch) => void
  onFlush: () => void
  onAction: (action: string, id: string) => void
}
export interface FileData extends FileCanvasNode {
  onResize: TerminalData['onResize']
  onLayoutStart: () => void
  onRemove: (id: string) => void
}
