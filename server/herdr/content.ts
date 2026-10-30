import type { ClientShellSnapshot, FrameData, PaneSurfaceFrame, SurfaceRect } from './wire.ts'
import { popupInnerRect } from './screen.ts'

export interface NativeContentPane {
  id: string
  name: string
  cwd?: string
  lines: string[]
  links: Array<{ label: string; url: string }>
}

const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/gu, ' ')
const validCwd = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') && value.length <= 8192
  && !/[\x00-\x1f\x7f-\x9f]/u.test(value)

function readPane(frame: FrameData, rect: SurfaceRect): Pick<NativeContentPane, 'lines' | 'links'> {
  const lines: string[] = [], links: NativeContentPane['links'] = []
  for (let y = rect.y; y < Math.min(frame.height, rect.y + rect.height); y++) {
    let line = '', link: { label: string; url: string } | undefined
    for (let x = rect.x; x < Math.min(frame.width, rect.x + rect.width); x++) {
      const cell = frame.cells[y * frame.width + x]
      if (!cell || cell.skip) continue
      const concealed = !!(cell.modifier & 128)
      const text = concealed ? ' ' : clean(cell.symbol) || ' '
      const url = concealed || cell.hyperlink === null ? '' : frame.hyperlinks[cell.hyperlink] || ''
      line += text
      if (url && url === link?.url) link.label += text
      else {
        if (link) links.push(link)
        link = url ? { label: text, url } : undefined
      }
    }
    if (link) links.push(link)
    lines.push(line.trimEnd())
  }
  return { lines, links }
}

/** Read only the already-rendered window, retaining pane boundaries and OSC 8 targets. */
export function windowContent(surface: PaneSurfaceFrame, snapshot: ClientShellSnapshot, tabId: string): NativeContentPane[] {
  if (surface.popup) {
    const popup = surface.popup, rect = popupInnerRect(surface)
    return rect ? [{ id: popup.terminal_id, name: clean(popup.title),
      ...readPane(popup.frame, { x: 0, y: 0, width: rect.width, height: rect.height }) }] : []
  }
  return surface.panes.flatMap(pane => {
    const metadata = snapshot.panes.find(item => item.pane_id === pane.pane_id && item.tab_id === tabId)
    if (!metadata) return []
    const cwd = validCwd(metadata.foreground_cwd) ? metadata.foreground_cwd : validCwd(metadata.cwd) ? metadata.cwd : undefined
    const name = typeof metadata.label === 'string' ? clean(metadata.label).slice(0, 200) : ''
    return [{ id: pane.pane_id, name, ...(cwd ? { cwd } : {}), ...readPane(surface.frame, pane.inner_rect) }]
  })
}

/** Native selection formatting unwraps soft rows without changing the selection or viewport. */
export async function readWindowContent(surface: PaneSurfaceFrame, snapshot: ClientShellSnapshot, tabId: string,
  read: (params: Record<string, unknown>) => Promise<unknown>): Promise<NativeContentPane[]> {
  const panes = windowContent(surface, snapshot, tabId)
  // Popup terminals do not have pane selection endpoints. Never read the panes
  // underneath; their text is not part of the displayed window at scan time.
  if (surface.popup) return panes
  for (const result of panes) {
    const pane = surface.panes.find(pane => pane.pane_id === result.id)!, rect = pane.inner_rect
    if (!rect.width || !rect.height) continue
    let concealed = false
    for (let y = rect.y; y < rect.y + rect.height && !concealed; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        if ((surface.frame.cells[y * surface.frame.width + x]?.modifier || 0) & 128) { concealed = true; break }
      }
    }
    // Plain formatters can expose concealed cells. Keep the masked painted
    // rows for this pane instead of reading its underlying terminal text.
    if (concealed) continue
    const top = pane.scroll ? Math.max(0, pane.scroll.max_offset_from_bottom - pane.scroll.offset_from_bottom) : 0
    let response: unknown
    try {
      response = await read({ pane_id: pane.pane_id, content_revision: pane.content_revision,
        anchor: { row: top, col: 0 }, cursor: { row: top + rect.height - 1, col: rect.width - 1 } })
    } catch { throw new Error('Window content changed or could not be read; scan again') }
    if (!response || typeof response !== 'object' || !('text' in response) || typeof response.text !== 'string'
        || 'pane_id' in response && response.pane_id !== pane.pane_id)
      throw new Error('Invalid window content response; scan again')
    result.lines = response.text.split('\n').map(line => clean(line.replace(/\r$/u, '')))
  }
  return panes
}
