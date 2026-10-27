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
export interface WindowResource { id: string; name: string }
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
export interface CanvasNode {
  id: string
  sourceId: string
  spaceId: string
  windowId: string
  x: number
  y: number
  width: number
  height: number
}
export interface Canvas { id: string; name: string; nodes: CanvasNode[] }
export interface TerminalData {
  sourceId: string
  spaceId: string
  windowId: string
  name: string
  subtitle: string
  type: SourceType
  width: number
  height: number
  available: boolean
  overview: boolean
  focus: boolean
  onAction: (action: string, id: string) => void
  onResize: (id: string, width: number, height: number, x?: number, y?: number) => void
}
