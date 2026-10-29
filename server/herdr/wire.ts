// Herdr endpoint generation 1, matching the frozen shell.*.v1 codecs.
// Transport: u32 little-endian length followed by bincode 2 standard encoding.
export const MAX_FRAME_BYTES = 32 * 1024 * 1024
const MAX_CELLS = 1_000_000
const utf8 = new TextDecoder('utf-8', { fatal: true })

export interface SurfaceRect { x: number; y: number; width: number; height: number }
export interface CellData { symbol: string; fg: number; bg: number; modifier: number; skip: boolean; hyperlink: number | null }
export interface CursorState { x: number; y: number; visible: boolean; shape: number }
export interface FrameData { cells: CellData[]; width: number; height: number; cursor: CursorState | null; hyperlinks: string[]; graphics: Buffer }
export interface PaneSurfacePane {
  pane_id: string; content_revision: number; rect: SurfaceRect; inner_rect: SurfaceRect
  scrollbar_rect: SurfaceRect | null
  scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } | null
  focused: boolean; mouse_reporting: boolean; sgr_pixel_mouse: boolean; alternate_screen_active: boolean
  pixel_width: number; pixel_height: number
}
export interface PaneSurfaceSplit { direction: 'Horizontal' | 'Vertical'; pos: number; area: SurfaceRect; hit_rect: SurfaceRect; path: boolean[] }
export interface ClientShellPopupSurface {
  terminal_id: string; title: string; width: { Cells: number } | { Percent: number } | null
  height: { Cells: number } | { Percent: number } | null; frame: FrameData
  mouse_reporting: boolean; sgr_pixel_mouse: boolean; pixel_width: number; pixel_height: number
}
export interface PaneSurfaceFrame {
  boot_id: string; projection_revision: number; surface_revision: number; frame: FrameData
  panes: PaneSurfacePane[]; splits: PaneSurfaceSplit[]; popup: ClientShellPopupSurface | null
}
export interface PaneSurfacePatch {
  boot_id: string; projection_revision: number; base_surface_revision: number; surface_revision: number
  rows: { x: number; y: number; cells: CellData[] }[]; panes: PaneSurfacePane[]; cursor: CursorState | null
}
export interface ClientShellSnapshot {
  boot_id: string; revision: number; focused_workspace_id: string | null; focused_tab_id: string | null; focused_pane_id: string | null
  tabs: { tab_id: string; workspace_id: string; focused: boolean; [key: string]: unknown }[]
  panes: { pane_id: string; tab_id: string; workspace_id: string; focused: boolean; right_click_passthrough: boolean; [key: string]: unknown }[]
  [key: string]: unknown
}
export type ClientKeyCode = 'Backspace' | 'Enter' | 'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' | 'PageUp' | 'PageDown' | 'Tab' | 'BackTab' | 'Delete' | 'Insert' | 'Esc' | 'Null' | { Char: string } | { F: number }
export type ClientMouseButton = 'Left' | 'Right' | 'Middle'
export type ClientMouseKind = { Down: ClientMouseButton } | { Up: ClientMouseButton } | { Drag: ClientMouseButton } | 'Moved' | 'ScrollUp' | 'ScrollDown' | 'ScrollLeft' | 'ScrollRight'
export type ClientMousePosition = { Cell: { column: number; row: number } } | { Pixels: { x: number; y: number; column: number; row: number } }
export interface ClientMouseGeometry { cols: number; rows: number; width_px: number; height_px: number }
export type ClientPaneInputEvent = {
  Key: { code: ClientKeyCode; modifiers: number; kind: 'Press' | 'Repeat' | 'Release'; repeat_count: number
    shifted_codepoint: number | null; generated_text: string | null; tracks_release: boolean; physical_key_id: number | null; windows_record: null }
} | { TextCommit: string } | { Paste: string } | {
  Mouse: { kind: ClientMouseKind; position: ClientMousePosition; geometry: ClientMouseGeometry | null; modifiers: number; lines: number }
}
export type ClientMessage = 'Detach'
  | { EndpointControl: { kind: string; data: string } }
  | { ClientShellResize: { cell_width_px: number; cell_height_px: number; surface_size: { cols: number; rows: number }; pixel_mouse: boolean } }
  | { ClientShellPaneInput: { pane_id: string; events: ClientPaneInputEvent[] } }
  | { ClientShellPopupInput: { terminal_id: string; events: ClientPaneInputEvent[] } }
  | { ClientShellEndpointRequest: { boot_id: string; request: string } }
  | { ClientShellFocus: { focused: boolean } }
  | { ClientShellMouseCapture: { enabled: boolean } }
export type ServerMessage = { type: 'control'; kind: string; data: string }
  | { type: 'surface'; surface: PaneSurfaceFrame } | { type: 'patch'; patch: PaneSurfacePatch }
  | { type: 'response'; boot_id: string; request_id: string; final_chunk: boolean; data: Buffer }
  | { type: 'clipboard'; data: string } | { type: 'bell'; count: number }
  | { type: 'title'; title: string | null } | { type: 'error'; message: string }
  | { type: 'shutdown'; reason: string | null } | { type: 'mouse'; enabled: boolean; sgr_pixels: boolean }
  | { type: 'ignored' }

export class Writer {
  private chunks: Buffer[] = []
  raw(value: Uint8Array) { this.chunks.push(Buffer.from(value)); return this }
  byte(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('Invalid herdr byte')
    return this.raw(Buffer.from([value]))
  }
  uint(value: number | bigint) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Invalid herdr integer')
    const integer = BigInt(value)
    if (integer < 0n || integer > 0xffffffffffffffffn) throw new Error('Invalid herdr integer')
    if (integer < 251n) return this.byte(Number(integer))
    const length = integer <= 0xffffn ? 2 : integer <= 0xffffffffn ? 4 : 8
    this.byte(length === 2 ? 251 : length === 4 ? 252 : 253)
    const buffer = Buffer.alloc(length)
    if (length === 2) buffer.writeUInt16LE(Number(integer))
    else if (length === 4) buffer.writeUInt32LE(Number(integer))
    else buffer.writeBigUInt64LE(integer)
    return this.raw(buffer)
  }
  bool(value: boolean) { return this.byte(value ? 1 : 0) }
  bytes(value: Uint8Array) { this.uint(value.length); return this.raw(value) }
  string(value: string) { return this.bytes(Buffer.from(value, 'utf8')) }
  option<T>(value: T | null | undefined, write: (value: T) => void) { this.byte(value == null ? 0 : 1); if (value != null) write(value); return this }
  list<T>(values: readonly T[], write: (value: T) => void) { this.uint(values.length); for (const value of values) write(value); return this }
  finish() { return Buffer.concat(this.chunks) }
}

class Reader {
  offset = 0
  constructor(private readonly bytes: Buffer) {}
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.length - this.offset) throw new Error('Truncated herdr frame')
    const data = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return data
  }
  byte() { return this.take(1)[0]! }
  biguint() {
    const tag = this.byte()
    if (tag < 251) return BigInt(tag)
    if (tag === 251) return BigInt(this.take(2).readUInt16LE())
    if (tag === 252) return BigInt(this.take(4).readUInt32LE())
    if (tag === 253) return this.take(8).readBigUInt64LE()
    throw new Error('Unsupported herdr integer width')
  }
  uint(maximum = Number.MAX_SAFE_INTEGER) { const value = this.biguint(); if (value > BigInt(maximum)) throw new Error('Herdr integer exceeds its bound'); return Number(value) }
  bool() { const value = this.byte(); if (value > 1) throw new Error('Invalid herdr boolean'); return value === 1 }
  option<T>(read: () => T): T | null { const tag = this.byte(); if (tag > 1) throw new Error('Invalid herdr option'); return tag ? read() : null }
  data(maximum = MAX_FRAME_BYTES) { return this.take(this.uint(maximum)) }
  string(maximum = 1024 * 1024) { return utf8.decode(this.data(maximum)) }
  list<T>(read: () => T, maximum = MAX_CELLS, minimumBytes = 1): T[] {
    const count = this.uint(maximum)
    if (count > Math.floor((this.bytes.length - this.offset) / minimumBytes)) throw new Error('Truncated herdr array')
    return Array.from({ length: count }, read)
  }
  done() { if (this.offset !== this.bytes.length) throw new Error('Trailing herdr frame bytes') }
}

const keyNames = ['Backspace', 'Enter', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Tab', 'BackTab', 'Delete', 'Insert', 'Esc', 'Char', 'F', 'Null']
function writeInput(writer: Writer, event: ClientPaneInputEvent) {
  if ('Key' in event) {
    const key = event.Key
    writer.uint(0)
    if (typeof key.code === 'string') { const tag = keyNames.indexOf(key.code); if (tag < 0) throw new Error('Invalid herdr key'); writer.uint(tag) }
    else if ('Char' in key.code) { if ([...key.code.Char].length !== 1) throw new Error('Invalid herdr character'); writer.uint(15).raw(Buffer.from(key.code.Char)) }
    else writer.uint(16).byte(key.code.F)
    writer.byte(key.modifiers).uint(['Press', 'Repeat', 'Release'].indexOf(key.kind)).uint(key.repeat_count)
    writer.option(key.shifted_codepoint, value => writer.uint(value))
    writer.option(key.generated_text, value => writer.string(value)).bool(key.tracks_release)
    writer.option(key.physical_key_id, value => writer.uint(value))
    if (key.windows_record !== null) throw new Error('Windows console records are not generated by Canvas')
    writer.byte(0)
  } else if ('TextCommit' in event) writer.uint(1).string(event.TextCommit)
  else if ('Paste' in event) writer.uint(3).string(event.Paste)
  else {
    const mouse = event.Mouse
    writer.uint(2)
    if (typeof mouse.kind === 'string') {
      const tag = ['Moved', 'ScrollUp', 'ScrollDown', 'ScrollLeft', 'ScrollRight'].indexOf(mouse.kind)
      if (tag < 0) throw new Error('Invalid herdr mouse event')
      writer.uint(tag + 3)
    } else {
      const key = Object.keys(mouse.kind)[0] as 'Down' | 'Up' | 'Drag'
      const button = 'Down' in mouse.kind ? mouse.kind.Down : 'Up' in mouse.kind ? mouse.kind.Up : mouse.kind.Drag
      writer.uint(['Down', 'Up', 'Drag'].indexOf(key)).uint(['Left', 'Right', 'Middle'].indexOf(button))
    }
    if ('Cell' in mouse.position) writer.uint(0).uint(mouse.position.Cell.column).uint(mouse.position.Cell.row)
    else { const p = mouse.position.Pixels; writer.uint(1).uint(p.x).uint(p.y).uint(p.column).uint(p.row) }
    writer.option(mouse.geometry, g => writer.uint(g.cols).uint(g.rows).uint(g.width_px).uint(g.height_px))
    writer.byte(mouse.modifiers).uint(mouse.lines)
  }
}

export function encodeClientMessage(message: ClientMessage): Buffer {
  const writer = new Writer()
  if (message === 'Detach') writer.uint(4)
  else if ('EndpointControl' in message) writer.uint(20).string(message.EndpointControl.kind).string(message.EndpointControl.data)
  else if ('ClientShellResize' in message) {
    const m = message.ClientShellResize
    writer.uint(12).uint(m.cell_width_px).uint(m.cell_height_px).uint(m.surface_size.cols).uint(m.surface_size.rows).bool(m.pixel_mouse)
  } else if ('ClientShellPaneInput' in message) writer.uint(13).string(message.ClientShellPaneInput.pane_id).list(message.ClientShellPaneInput.events, event => writeInput(writer, event))
  else if ('ClientShellPopupInput' in message) writer.uint(14).string(message.ClientShellPopupInput.terminal_id).list(message.ClientShellPopupInput.events, event => writeInput(writer, event))
  else if ('ClientShellEndpointRequest' in message) writer.uint(15).string(message.ClientShellEndpointRequest.boot_id).string(message.ClientShellEndpointRequest.request)
  else if ('ClientShellFocus' in message) writer.uint(18).bool(message.ClientShellFocus.focused)
  else writer.uint(19).bool(message.ClientShellMouseCapture.enabled)
  const payload = writer.finish()
  if (payload.length > 2 * 1024 * 1024) throw new Error('Herdr input frame is too large')
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length)
  return Buffer.concat([prefix, payload])
}

const rect = (r: Reader): SurfaceRect => ({ x: r.uint(65535), y: r.uint(65535), width: r.uint(4096), height: r.uint(4096) })
const cursor = (r: Reader): CursorState => ({ x: r.uint(65535), y: r.uint(65535), visible: r.bool(), shape: r.byte() })
const cell = (r: Reader): CellData => ({ symbol: r.string(), fg: r.uint(0xffffffff), bg: r.uint(0xffffffff), modifier: r.uint(65535), skip: r.bool(), hyperlink: r.option(() => r.uint(0xffffffff)) })
function frame(r: Reader): FrameData {
  const cells = r.list(() => cell(r), MAX_CELLS, 6)
  const width = r.uint(4096), height = r.uint(4096)
  if (!width || !height || width * height !== cells.length) throw new Error('Invalid herdr screen dimensions')
  const value = { cells, width, height, cursor: r.option(() => cursor(r)), hyperlinks: r.list(() => r.string(), 65536), graphics: r.data() }
  for (const item of cells) if (item.hyperlink !== null && item.hyperlink >= value.hyperlinks.length) throw new Error('Invalid herdr hyperlink index')
  return value
}
function pane(r: Reader): PaneSurfacePane {
  return { pane_id: r.string(4096), content_revision: r.uint(), rect: rect(r), inner_rect: rect(r), scrollbar_rect: r.option(() => rect(r)),
    scroll: r.option(() => ({ offset_from_bottom: r.uint(), max_offset_from_bottom: r.uint(), viewport_rows: r.uint() })),
    focused: r.bool(), mouse_reporting: r.bool(), sgr_pixel_mouse: r.bool(), alternate_screen_active: r.bool(), pixel_width: r.uint(0xffffffff), pixel_height: r.uint(0xffffffff) }
}
function popupSize(r: Reader) { return r.uint(1) === 0 ? { Cells: r.uint(65535) } : { Percent: r.byte() } }
function popup(r: Reader): ClientShellPopupSurface {
  return { terminal_id: r.string(4096), title: r.string(), width: r.option(() => popupSize(r)), height: r.option(() => popupSize(r)),
    frame: frame(r), mouse_reporting: r.bool(), sgr_pixel_mouse: r.bool(), pixel_width: r.uint(0xffffffff), pixel_height: r.uint(0xffffffff) }
}
function graphicsKey(r: Reader) {
  const source = r.uint(1)
  if (source === 0) { r.uint(1); r.string(4096); r.uint(0xffffffff) }
  else { r.string(4096); r.string(4096) }
  r.uint(0xffffffff); r.uint(0xffffffff); r.uint(2); r.biguint(); r.biguint()
}
function graphicsScene(r: Reader) {
  r.list(() => { graphicsKey(r); r.data() }, 65536)
  r.list(() => { graphicsKey(r); r.uint(0xffffffff); r.uint(65535); r.uint(65535); for (let i = 0; i < 10; i++) r.uint(0xffffffff) }, 65536)
  r.list(() => graphicsKey(r), 65536)
}
function surface(r: Reader): PaneSurfaceFrame {
  const result = { boot_id: r.string(4096), projection_revision: r.uint(), surface_revision: r.uint(), frame: frame(r),
    panes: r.list(() => pane(r), 10000), splits: r.list(() => ({ direction: r.uint(1) === 0 ? 'Horizontal' as const : 'Vertical' as const,
      pos: r.uint(65535), area: rect(r), hit_rect: rect(r), path: r.list(() => r.bool(), 1024) }), 10000), popup: r.option(() => popup(r)) }
  graphicsScene(r)
  return result
}

/** Decode exactly one payload; irrelevant negotiated notifications stay bounded. */
export function decodeServerMessage(payload: Buffer): ServerMessage {
  const r = new Reader(payload), tag = r.uint(20)
  let message: ServerMessage
  switch (tag) {
    case 3: message = { type: 'shutdown', reason: r.option(() => r.string()) }; break
    case 5: message = { type: 'clipboard', data: r.string(24 * 1024 * 1024) }; break
    case 6: message = { type: 'title', title: r.option(() => r.string()) }; break
    case 8: message = { type: 'mouse', enabled: r.bool(), sgr_pixels: r.bool() }; break
    case 9: message = { type: 'bell', count: r.uint(65535) }; break
    case 13: message = { type: 'surface', surface: surface(r) }; break
    case 15: message = { type: 'error', message: r.string() }; break
    case 18: message = { type: 'response', boot_id: r.string(4096), request_id: r.string(4096), final_chunk: r.bool(), data: r.data() }; break
    case 19: message = { type: 'patch', patch: { boot_id: r.string(4096), projection_revision: r.uint(), base_surface_revision: r.uint(), surface_revision: r.uint(),
      rows: r.list(() => ({ x: r.uint(65535), y: r.uint(65535), cells: r.list(() => cell(r), MAX_CELLS, 6) }), 65536),
      panes: r.list(() => pane(r), 10000), cursor: r.option(() => cursor(r)) } }; break
    case 20: message = { type: 'control', kind: r.string(4096), data: r.string(MAX_FRAME_BYTES) }; break
    case 0: throw new Error('Herdr server does not support the stable endpoint protocol')
    // These carry optional notifications/graphics, never terminal text for a
    // client-owned surface. Frame length still bounds their complete payload.
    default: return { type: 'ignored' }
  }
  r.done()
  return message
}

/** Streaming framing tolerates any socket split/coalescing without quadratic copies. */
export class FrameReader {
  private prefix = Buffer.alloc(4)
  private prefixBytes = 0
  private payload?: Buffer
  private payloadBytes = 0
  feed(input: Buffer): ServerMessage[] {
    const messages: ServerMessage[] = []
    let offset = 0
    while (offset < input.length) {
      if (!this.payload) {
        const take = Math.min(4 - this.prefixBytes, input.length - offset)
        input.copy(this.prefix, this.prefixBytes, offset, offset + take); this.prefixBytes += take; offset += take
        if (this.prefixBytes < 4) break
        const length = this.prefix.readUInt32LE(); this.prefixBytes = 0
        if (!length || length > MAX_FRAME_BYTES) throw new Error('Invalid herdr frame length')
        this.payload = Buffer.allocUnsafe(length); this.payloadBytes = 0
      }
      const take = Math.min(this.payload.length - this.payloadBytes, input.length - offset)
      input.copy(this.payload, this.payloadBytes, offset, offset + take); this.payloadBytes += take; offset += take
      if (this.payloadBytes === this.payload.length) { messages.push(decodeServerMessage(this.payload)); this.payload = undefined; this.payloadBytes = 0 }
    }
    return messages
  }
  end() { if (this.prefixBytes || this.payload) throw new Error('Truncated herdr stream') }
}
