import { cellWidth, popupInnerRect } from './screen.ts';
import { MAX_TERMINAL_PASTE_BYTES as MAX_PENDING } from '../../shared/paste.ts';
import type { ClientKeyCode, ClientMessage, ClientMouseButton, ClientMouseKind, ClientPaneInputEvent, ClientShellSnapshot, PaneSurfaceFrame, PaneSurfacePane, PaneSurfaceSplit, SurfaceRect } from './wire.ts';

const SHIFT = 1, CONTROL = 2, ALT = 4, SUPER = 8;
type Point = { row: number; col: number };
type Mouse = { column: number; row: number; modifiers: number; kind: ClientMouseKind | 'Release' };
type ParsedInput = { event: ClientPaneInputEvent } | { mouse: Mouse } | { focus: boolean };

function key(code: ClientKeyCode, modifiers = 0): ClientPaneInputEvent {
  return { Key: { code, modifiers, kind: 'Press', repeat_count: 1, shifted_codepoint: null,
    generated_text: null, tracks_release: false, physical_key_id: null, windows_record: null } };
}
function modifiers(value = 1) {
  const bits = value - 1;
  return (bits & 1 ? SHIFT : 0) | (bits & 2 ? ALT : 0) | (bits & 4 ? CONTROL : 0) | (bits & 8 ? SUPER : 0);
}
function character(value: string, extra = 0): ClientPaneInputEvent {
  const code = value.codePointAt(0)!;
  if (code === 13) return key('Enter', extra);
  if (code === 9) return key('Tab', extra);
  if (code === 27) return key('Esc', extra);
  if (code === 127) return key('Backspace', extra);
  if (code === 0) return key({ Char: ' ' }, extra | CONTROL);
  if (code < 27) return key({ Char: String.fromCharCode(code + 96) }, extra | CONTROL);
  if (code < 32) return key({ Char: ['[', '\\', ']', '^', '_'][code - 27]! }, extra | CONTROL);
  return key({ Char: value }, extra | (/^[A-Z]$/.test(value) ? SHIFT : 0));
}
function extendedCharacter(value: number, modifiers: number): ClientPaneInputEvent {
  const code: ClientKeyCode = value === 8 || value === 127 ? 'Backspace' : value === 9 ? 'Tab' : value === 13 ? 'Enter' : value === 27 ? 'Esc' : { Char: String.fromCodePoint(value) };
  return key(code, modifiers);
}
function scalarLength(bytes: Buffer, start: number) {
  const first = bytes[start]!;
  return first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
}
function mouse(buttons: number, column: number, row: number, released: boolean): Mouse | undefined {
  if (![buttons, column, row].every(Number.isSafeInteger) || buttons < 0 || column < 1 || row < 1 || column > 65536 || row > 65536) return;
  const mods = (buttons & 4 ? SHIFT : 0) | (buttons & 8 ? ALT : 0) | (buttons & 16 ? CONTROL : 0);
  const button = (['Left', 'Middle', 'Right'] as const)[buttons & 3];
  const kind: Mouse['kind'] = buttons & 64 ? (['ScrollUp', 'ScrollDown', 'ScrollLeft', 'ScrollRight'] as const)[buttons & 3]!
    : released ? button ? { Up: button } : 'Release'
    : buttons & 32 ? button ? { Drag: button } : 'Moved'
    : button ? { Down: button } : 'Release';
  return { kind, column: column - 1, row: row - 1, modifiers: mods };
}

/** Outer xterm bytes are decoded once; herdr encodes semantic keys for each child. */
export class VtInputParser {
  private pending = Buffer.alloc(0);
  private paste: Buffer[] | undefined;
  private pasteBytes = 0;
  private discardPaste = false;
  private discardControl?: boolean;
  private escapeTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  constructor(private readonly emit: (input: ParsedInput) => void, private readonly failed: (error: Error) => void, private readonly escapeDelay = 35) {}

  write(data: string | Buffer) {
    if (this.disposed || !data.length) return;
    clearTimeout(this.escapeTimer);
    this.pending = Buffer.concat([this.pending, typeof data === 'string' ? Buffer.from(data) : data]);
    this.parse();
    if (this.pending.length === 1 && this.pending[0] === 27 && !this.paste && this.discardControl === undefined) {
      this.escapeTimer = setTimeout(() => { this.escapeTimer = undefined; this.flushEscape(); }, this.escapeDelay);
      this.escapeTimer.unref();
    }
  }
  flushEscape() {
    if (!this.disposed && this.pending.length === 1 && this.pending[0] === 27 && !this.paste && this.discardControl === undefined) { this.pending = Buffer.alloc(0); this.emit({ event: key('Esc') }); }
  }
  private consume(bytes: number) { this.pending = this.pending.subarray(bytes); }
  private parse() {
    while (this.pending.length) {
      if (this.discardControl !== undefined) {
        const st = this.pending.indexOf('\x1b\\'), bell = this.discardControl ? this.pending.indexOf(7) : -1;
        const end = bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st >= 0 ? st + 2 : -1;
        if (end < 0) { this.pending = this.pending.subarray(Math.max(0, this.pending.length - 1)); return; }
        this.consume(end); this.discardControl = undefined; continue;
      }
      if (this.paste) {
        const end = this.pending.indexOf('\x1b[201~');
        // Retain enough bytes for an end marker split across network frames.
        const count = end < 0 ? Math.max(0, this.pending.length - 5) : end;
        if (!this.discardPaste && this.pasteBytes + count > MAX_PENDING) {
          this.paste = []; this.pasteBytes = 0; this.discardPaste = true;
          this.failed(new Error('Pasted text exceeds the herdr input limit'));
        }
        if (!this.discardPaste && count) { this.paste.push(this.pending.subarray(0, count)); this.pasteBytes += count; }
        this.consume(end < 0 ? count : end + 6);
        if (end < 0) return;
        const text = !this.discardPaste ? Buffer.concat(this.paste).toString('utf8') : undefined;
        this.paste = undefined; this.pasteBytes = 0; this.discardPaste = false;
        if (text !== undefined) this.emit({ event: { Paste: text } });
        continue;
      }
      if (this.pending[0] !== 27) {
        const count = scalarLength(this.pending, 0);
        if (this.pending.length < count) return;
        const value = this.pending.subarray(0, count).toString('utf8'); this.consume(count);
        this.emit({ event: count > 1 ? { TextCommit: value } : character(value) });
        continue;
      }
      if (this.pending.length < 2) return;
      let offset = 0, extra = 0;
      if (this.pending[1] === 27) {
        if (this.pending.length < 3) { this.consume(1); this.emit({ event: key('Esc') }); continue; }
        if (this.pending[2] === 91 || this.pending[2] === 79) { offset = 1; extra = ALT; }
        else { this.consume(1); this.emit({ event: key('Esc') }); continue; }
      }
      const introducer = this.pending[offset + 1];
      if (introducer === 91 || introducer === 79) {
        if (this.pending.length <= offset + 2) return;
        if (introducer === 91 && this.pending[offset + 2] === 77) {
          if (this.pending.length < offset + 6) return;
          const event = mouse(this.pending[offset + 3]! - 32, this.pending[offset + 4]! - 32, this.pending[offset + 5]! - 32, false);
          this.consume(offset + 6); if (event) this.emit({ mouse: event }); continue;
        }
        let end = offset + 2;
        while (end < this.pending.length && (this.pending[end]! < 0x40 || this.pending[end]! > 0x7e)) end++;
        if (end === this.pending.length) {
          if (end > 128) { this.consume(end); this.failed(new Error('Invalid terminal control sequence')); }
          return;
        }
        const body = this.pending.subarray(offset + 2, end).toString('ascii');
        const final = String.fromCharCode(this.pending[end]!);
        this.consume(end + 1);
        if (introducer === 91 && body === '200' && final === '~') { this.paste = []; continue; }
        if (introducer === 91 && !body && (final === 'I' || final === 'O')) { this.emit({ focus: final === 'I' }); continue; }
        if (introducer === 91 && body.startsWith('<') && (final === 'M' || final === 'm')) {
          const match = /^<(\d+);(\d+);(\d+)$/.exec(body);
          const event = match && mouse(Number(match[1]), Number(match[2]), Number(match[3]), final === 'm');
          if (event) this.emit({ mouse: event });
          continue;
        }
        const event = this.sequence(body, final, introducer === 79, extra);
        if (event) this.emit({ event });
        continue;
      }
      // Terminal replies (OSC/DCS/APC) are not keyboard input.
      if ([93, 80, 95, 94].includes(introducer!)) {
        const st = this.pending.indexOf('\x1b\\', 2), bell = introducer === 93 ? this.pending.indexOf(7, 2) : -1;
        const end = bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st >= 0 ? st + 2 : -1;
        if (end < 0) {
          if (this.pending.length > MAX_PENDING) {
            this.discardControl = introducer === 93;
            this.pending = this.pending.subarray(this.pending.length - 1);
            this.failed(new Error('Terminal control sequence exceeds the pending input limit'));
          }
          return;
        }
        this.consume(end); continue;
      }
      const count = scalarLength(this.pending, 1);
      if (this.pending.length < count + 1) return;
      const value = this.pending.subarray(1, count + 1).toString('utf8'); this.consume(count + 1);
      for (const scalar of value) this.emit({ event: character(scalar, ALT) });
    }
  }
  private sequence(body: string, final: string, ss3: boolean, extra: number): ClientPaneInputEvent | undefined {
    if (ss3 && !body) {
      const keypad: Record<string, string> = { p: '0', q: '1', r: '2', s: '3', t: '4', u: '5', v: '6', w: '7', x: '8', y: '9', n: '.', l: ',', m: '-', k: '+', j: '*', o: '/' };
      if (keypad[final]) return character(keypad[final], extra);
      if (final === 'M') return key('Enter', extra);
    }
    if (!/^[0-9;]*$/.test(body)) return;
    const values = body ? body.split(';').map(Number) : [];
    if (values.some(value => !Number.isSafeInteger(value))) return;
    const mods = extra | modifiers(values[1] || 1);
    const cursor: Record<string, ClientKeyCode> = { A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End', P: { F: 1 }, Q: { F: 2 }, R: { F: 3 }, S: { F: 4 } };
    if (cursor[final] && (!body || values.length <= 2 && values[0] === 1)) return key(cursor[final], mods);
    if (final === 'Z' && !body) return key('BackTab', extra | SHIFT);
    if (final === '~') {
      const tilde: Record<number, ClientKeyCode> = { 1: 'Home', 2: 'Insert', 3: 'Delete', 4: 'End', 5: 'PageUp', 6: 'PageDown', 7: 'Home', 8: 'End', 11: { F: 1 }, 12: { F: 2 }, 13: { F: 3 }, 14: { F: 4 }, 15: { F: 5 }, 17: { F: 6 }, 18: { F: 7 }, 19: { F: 8 }, 20: { F: 9 }, 21: { F: 10 }, 23: { F: 11 }, 24: { F: 12 } };
      if (tilde[values[0]!] && values.length <= 2) return key(tilde[values[0]!]!, mods);
      if (values.length === 3 && values[0] === 27 && values[2]! > 0 && values[2]! <= 0x10ffff && !(values[2]! >= 0xd800 && values[2]! <= 0xdfff)) return extendedCharacter(values[2]!, mods);
    }
    if (final === 'u' && values.length <= 2 && values[0]! > 0 && values[0]! <= 0x10ffff && !(values[0]! >= 0xd800 && values[0]! <= 0xdfff)) return extendedCharacter(values[0]!, mods);
  }
  private reset() { clearTimeout(this.escapeTimer); this.pending = Buffer.alloc(0); this.paste = undefined; this.pasteBytes = 0; this.discardPaste = false; this.discardControl = undefined; }
  dispose() { this.disposed = true; this.reset(); }
}

export interface HerdrSelection { pane_id: string; anchor: Point; cursor: Point }
interface RouterOptions {
  tabId: string;
  send(message: ClientMessage): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  getSurface(): PaneSurfaceFrame | undefined;
  getSnapshot(): ClientShellSnapshot | undefined;
  onError?(error: Error): void;
  onCopy?(text: string): void;
  onSelection?(selection: HerdrSelection | undefined): void;
  escapeDelay?: number;
}
function contains(rect: SurfaceRect, mouse: Mouse) { return mouse.column >= rect.x && mouse.row >= rect.y && mouse.column < rect.x + rect.width && mouse.row < rect.y + rect.height; }
function local(rect: SurfaceRect, mouse: Mouse): Point {
  return { col: Math.max(0, Math.min(rect.width - 1, mouse.column - rect.x)), row: Math.max(0, Math.min(rect.height - 1, mouse.row - rect.y)) };
}
function popupInputRect(surface: PaneSurfaceFrame) {
  const area = popupInnerRect(surface), frame = surface.popup?.frame;
  return area && frame ? { ...area, width: Math.min(area.width, frame.width), height: Math.min(area.height, frame.height) } : undefined;
}
function same(a: Point, b: Point) { return a.col === b.col && a.row === b.row; }
function before(a: Point, b: Point) { return a.row < b.row || a.row === b.row && a.col < b.col; }
function top(pane: PaneSurfacePane) { return pane.scroll ? Math.max(0, pane.scroll.max_offset_from_bottom - pane.scroll.offset_from_bottom) : 0; }
function thumb(pane: PaneSurfacePane) {
  const track = pane.scrollbar_rect, metrics = pane.scroll;
  if (!track || !metrics || !metrics.max_offset_from_bottom || !track.height) return;
  const length = Math.max(1, Math.min(track.height, Math.round(metrics.viewport_rows * track.height / (metrics.max_offset_from_bottom + metrics.viewport_rows))));
  return { top: track.y + Math.round((metrics.max_offset_from_bottom - metrics.offset_from_bottom) * (track.height - length) / metrics.max_offset_from_bottom), length };
}
function scrollOffset(pane: PaneSurfacePane, row: number, grab?: number) {
  const track = pane.scrollbar_rect, metrics = pane.scroll, bar = thumb(pane);
  if (!track || !metrics || !bar) return 0;
  const maxTop = track.height - bar.length;
  const desired = Math.max(0, Math.min(maxTop, Math.max(0, Math.min(track.height - 1, row - track.y)) - (grab ?? Math.floor(bar.length / 2))));
  return maxTop ? Math.max(0, metrics.max_offset_from_bottom - Math.round(desired * metrics.max_offset_from_bottom / maxTop)) : 0;
}

/** Inclusive display columns, matching native word selection for URLs and paths. */
export function wordBounds(text: string, column: number): [number, number] | undefined {
  let nextColumn = 0;
  const cells = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(({ segment }) => {
    const width = cellWidth(segment), start = width ? nextColumn : Math.max(0, nextColumn - 1);
    nextColumn += width;
    return { ch: segment, start, end: Math.max(0, nextColumn - 1) };
  });
  const index = cells.findIndex(cell => cell.start <= column && column <= cell.end);
  if (index < 0) return;
  const chars = cells.map(cell => cell.ch);
  const finish = (start: number, end: number): [number, number] | undefined => start <= index && end >= index ? [cells[start]!.start, cells[end]!.end] : undefined;
  for (let start = 0; start < chars.length; start++) {
    if (!chars.slice(start, start + 8).join('').startsWith('https://') && !chars.slice(start, start + 7).join('').startsWith('http://')) continue;
    let end = start;
    while (end + 1 < chars.length && !/\s/u.test(chars[end + 1]!)) end++;
    if (index < start || index > end) { start = end; continue; }
    while (end >= start) {
      const ch = chars[end]!, open = ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[ch];
      const balance = open ? chars.slice(start, end).reduce((n, value) => n + (value === open ? 1 : value === ch ? -1 : 0), 0) : 0;
      if (!'"\'`.,;:!?'.includes(ch) && (!open || balance > 0)) break;
      end--;
    }
    const bounds = finish(start, end); if (bounds) return bounds;
  }
  for (const quote of ['"', "'", '`']) {
    let start: number | undefined;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] !== quote) continue;
      let slashes = 0;
      for (let j = i - 1; j >= 0 && chars[j] === '\\'; j--) slashes++;
      if (slashes % 2) continue;
      if (start === undefined) start = i;
      else { if (index > start && index < i && chars.slice(start + 1, i).includes('/')) return finish(start + 1, i - 1); start = undefined; }
    }
  }
  const separator = (ch: string) => /\s/u.test(ch) || '|()[]{},;!（）\uff1a、。，'.includes(ch);
  if (separator(chars[index]!)) return;
  let start = index, end = index;
  while (start > 0 && !separator(chars[start - 1]!)) start--;
  while (end + 1 < chars.length && !separator(chars[end + 1]!)) end++;
  const trailing = (ch: string) => ')]}>"\'`.,;:!?'.includes(ch);
  while (start <= end && '([{<"\'`'.includes(chars[start]!)) start++;
  if (start < end && chars[end] === '$' && trailing(chars[end - 1]!)) end--;
  while (end >= start && trailing(chars[end]!)) end--;
  return finish(start, end);
}

interface PendingFocus { pane: string; snapshot: number; boot: string; failed?: boolean }
interface InputTarget { kind: 'pane' | 'popup'; id: string; boot: string; focus?: PendingFocus }
interface SelectionState extends HerdrSelection {
  pane: PaneSurfacePane; boot: string; generation: number; dragging: boolean; base: number;
  pointer?: Mouse; scrollOffsets: Set<number>;
  word?: { anchor: Point; bounds: [number, number] };
}

/** Per connection/tab ownership; async endpoint replies cannot retarget queued input. */
export class HerdrInputRouter {
  private readonly parser: VtInputParser;
  private queue = Promise.resolve();
  private reads = new Set<Promise<void>>();
  private disposed = false;
  private focus?: PendingFocus;
  private batch?: { target: InputTarget; events: ClientPaneInputEvent[]; bytes: number };
  private latest = new Map<string, { params: Record<string, unknown>; valid: () => boolean }>();
  private mouseGesture?: { target: InputTarget; rect: SurfaceRect; button: ClientMouseButton; last: Mouse };
  private splitGesture?: { split: PaneSurfaceSplit; offset: number; topology: string; boot: string; last?: number };
  private scrollbarGesture?: { pane: string; boot: string; grab: number };
  private selection?: SelectionState;
  private selectionRevision = 0;
  private selectionScrollTimer?: ReturnType<typeof setTimeout>;
  private lastClick?: { pane: string; point: Point; at: number };
  private scrollTargets = new Map<string, { offset: number; revision: number }>();
  constructor(private readonly options: RouterOptions) {
    this.parser = new VtInputParser(input => this.route(input), error => options.onError?.(error), options.escapeDelay);
  }
  write(data: string | Buffer) { this.parser.write(data); }
  async drain() {
    this.parser.flushEscape();
    let pending;
    do { pending = this.queue; await pending; await Promise.all(this.reads); } while (pending !== this.queue || this.reads.size);
  }
  private enqueue(action: () => void | Promise<void>, barrier = true) {
    this.batch = undefined;
    if (barrier) this.latest.clear();
    this.queue = this.queue.then(async () => { if (!this.disposed) await action(); }).catch(reason => { if (!this.disposed) this.options.onError?.(reason instanceof Error ? reason : new Error(String(reason))); });
  }
  private endpointLatest(key: string, method: string, params: Record<string, unknown>, valid: () => boolean) {
    const existing = this.latest.get(key);
    if (existing) { existing.params = params; existing.valid = valid; return; }
    const pending = { params, valid };
    this.enqueue(async () => {
      if (this.latest.get(key) === pending) this.latest.delete(key);
      if (pending.valid()) await this.options.request(method, pending.params);
    }, false);
    this.latest.set(key, pending);
  }
  private context() {
    const snapshot = this.options.getSnapshot(), surface = this.options.getSurface();
    if (!snapshot || !surface || snapshot.boot_id !== surface.boot_id || snapshot.focused_tab_id !== this.options.tabId) return;
    const ids = new Set(snapshot.panes.filter(pane => pane.tab_id === this.options.tabId).map(pane => pane.pane_id));
    const panes = surface.panes.filter(pane => ids.has(pane.pane_id) && pane.inner_rect.width > 0 && pane.inner_rect.height > 0);
    return { snapshot, surface, panes };
  }
  private valid(target: InputTarget) {
    const context = this.context();
    return !!context && context.snapshot.boot_id === target.boot && !target.focus?.failed
      && (target.kind === 'popup' ? context.surface.popup?.terminal_id === target.id && !!popupInputRect(context.surface) : !context.surface.popup && context.panes.some(pane => pane.pane_id === target.id));
  }
  private paneTarget(pane: PaneSurfacePane): InputTarget {
    return { kind: 'pane', id: pane.pane_id, boot: this.options.getSnapshot()!.boot_id, focus: this.focus?.pane === pane.pane_id ? this.focus : undefined };
  }
  private target(): InputTarget | undefined {
    const context = this.context();
    if (!context) return;
    if (context.surface.popup) return { kind: 'popup', id: context.surface.popup.terminal_id, boot: context.snapshot.boot_id };
    const id = this.focus?.pane ?? context.snapshot.focused_pane_id;
    const pane = context.panes.find(pane => pane.pane_id === id);
    return pane && this.paneTarget(pane);
  }
  private send(target: InputTarget, event: ClientPaneInputEvent) {
    const bytes = 'Paste' in event ? Buffer.byteLength(event.Paste) : 'TextCommit' in event ? Buffer.byteLength(event.TextCommit) : 64;
    const previous = this.batch;
    if (previous && previous.target.id === target.id && previous.target.kind === target.kind && previous.target.boot === target.boot
      && previous.target.focus === target.focus && previous.events.length < 128 && previous.bytes + bytes <= MAX_PENDING) {
      previous.events.push(event); previous.bytes += bytes; return;
    }
    const batch = { target, events: [event], bytes };
    this.enqueue(() => {
      if (this.batch === batch) this.batch = undefined;
      if (!this.valid(target)) return;
      const surface = this.options.getSurface()!;
      const rect = target.kind === 'popup' ? popupInputRect(surface)! : surface.panes.find(pane => pane.pane_id === target.id)!.inner_rect;
      const events = batch.events.map(event => {
        if (!('Mouse' in event) || !('Cell' in event.Mouse.position)) return event;
        const { column, row } = event.Mouse.position.Cell;
        return { Mouse: { ...event.Mouse, position: { Cell: { column: Math.min(rect.width - 1, column), row: Math.min(rect.height - 1, row) } } } };
      });
      this.options.send(target.kind === 'pane' ? { ClientShellPaneInput: { pane_id: target.id, events } } : { ClientShellPopupInput: { terminal_id: target.id, events } });
    });
    this.batch = batch;
  }
  private focusPane(pane: PaneSurfacePane) {
    const context = this.context();
    if (!context || (this.focus?.pane || context.snapshot.focused_pane_id) === pane.pane_id) return;
    const focus: PendingFocus = this.focus = { pane: pane.pane_id, snapshot: context.snapshot.revision, boot: context.snapshot.boot_id };
    const target: InputTarget = { kind: 'pane', id: pane.pane_id, boot: focus.boot, focus };
    this.enqueue(async () => {
      if (!this.valid(target)) { focus.failed = true; if (this.focus === focus) this.focus = undefined; return; }
      try { await this.options.request('pane.focus', { pane_id: pane.pane_id }); }
      catch (reason) { focus.failed = true; if (this.focus === focus) this.focus = undefined; throw reason; }
    });
  }
  private clearSelection() {
    this.stopSelectionScroll();
    const selected = !!this.selection;
    this.selection = undefined; this.selectionRevision++;
    if (selected) this.options.onSelection?.(undefined);
  }
  /** Called after snapshot/surface changes, before rendering the next frame. */
  refresh() {
    if (this.disposed) return;
    const context = this.context(), snapshot = this.options.getSnapshot();
    if (this.focus && snapshot) {
      if (snapshot.boot_id !== this.focus.boot || snapshot.focused_tab_id !== this.options.tabId
        || !snapshot.panes.some(pane => pane.pane_id === this.focus!.pane && pane.tab_id === this.options.tabId)) { this.focus.failed = true; this.focus = undefined; }
      else if (snapshot.revision > this.focus.snapshot && snapshot.focused_pane_id === this.focus.pane) this.focus = undefined;
    }
    // Snapshot and surface arrive separately. Preserve gestures through a short
    // projection gap; later input still requires a valid matching surface.
    if (!context && snapshot?.focused_tab_id === this.options.tabId && !this.options.getSurface()) return;
    if (this.mouseGesture) {
      if (!this.valid(this.mouseGesture.target)) this.mouseGesture = undefined;
      else this.mouseGesture.rect = this.mouseGesture.target.kind === 'popup' ? popupInputRect(context!.surface)! : context!.panes.find(pane => pane.pane_id === this.mouseGesture!.target.id)!.inner_rect;
    }
    if (this.splitGesture && (!context || context.surface.popup || context.snapshot.boot_id !== this.splitGesture.boot || this.topology(context) !== this.splitGesture.topology)) this.splitGesture = undefined;
    if (this.splitGesture && context) {
      this.splitGesture.split = context.surface.splits.find(split => split.direction === this.splitGesture!.split.direction && JSON.stringify(split.path) === JSON.stringify(this.splitGesture!.split.path))!;
    }
    if (this.scrollbarGesture && (!context || context.surface.popup || context.snapshot.boot_id !== this.scrollbarGesture.boot || !context.panes.some(pane => pane.pane_id === this.scrollbarGesture!.pane))) this.scrollbarGesture = undefined;
    if (this.selection) {
      if (!this.selectionValid(this.selection)) this.clearSelection();
      else {
        const selection = this.selection, pane = context!.panes.find(pane => pane.pane_id === selection.pane_id)!;
        if (top(pane) !== top(selection.pane)) {
          selection.pane = pane;
          if (selection.pointer) this.moveSelection(selection, pane, selection.pointer);
          else this.highlight(selection);
        }
      }
    }
    for (const [id, target] of this.scrollTargets) {
      const pane = context?.panes.find(pane => pane.pane_id === id);
      if (!pane || pane.content_revision > target.revision || pane.scroll?.offset_from_bottom === target.offset) this.scrollTargets.delete(id);
    }
  }
  private route(input: ParsedInput) {
    if (this.disposed) return;
    this.refresh();
    if ('focus' in input) {
      if (!input.focus) { this.releaseMouse(); this.splitGesture = undefined; this.scrollbarGesture = undefined; this.clearSelection(); this.lastClick = undefined; }
      this.enqueue(() => this.options.send({ ClientShellFocus: { focused: input.focus } }));
      return;
    }
    if ('mouse' in input) { this.routeMouse(input.mouse); return; }
    const target = this.target();
    if (!target) return;
    if ('Key' in input.event && this.selection && !this.selection.dragging) {
      const { code, modifiers } = input.event.Key;
      if (modifiers === (CONTROL | SHIFT) && typeof code === 'object' && 'Char' in code && code.Char.toLowerCase() === 'c'
        || modifiers === CONTROL && code === 'Insert') { this.copySelection(this.selection); return; }
    }
    this.clearSelection(); this.lastClick = undefined; this.scrollTargets.delete(target.id);
    this.send(target, input.event);
  }
  private mouseEvent(rect: SurfaceRect, event: Mouse, kind = event.kind): ClientPaneInputEvent | undefined {
    if (kind === 'Release') return;
    const point = local(rect, event);
    return { Mouse: { kind, position: { Cell: { column: point.col, row: point.row } }, geometry: null, modifiers: event.modifiers, lines: 3 } };
  }
  private releaseMouse() {
    const gesture = this.mouseGesture;
    this.mouseGesture = undefined;
    if (!gesture || !this.valid(gesture.target)) return;
    const event = this.mouseEvent(gesture.rect, gesture.last, { Up: gesture.button });
    if (event) this.send(gesture.target, event);
  }
  private topology(context: NonNullable<ReturnType<HerdrInputRouter['context']>>) { return JSON.stringify([context.panes.map(pane => pane.pane_id), context.surface.splits.map(split => [split.direction, split.path])]); }
  private scroll(pane: PaneSurfacePane, offset: number, selection?: SelectionState) {
    const target = this.paneTarget(pane);
    this.scrollTargets.set(pane.pane_id, { offset, revision: pane.content_revision });
    this.endpointLatest('scroll:' + pane.pane_id, 'pane.scroll', { pane_id: pane.pane_id, offset_from_bottom: offset }, () => this.valid(target) && (!selection || this.selection === selection && this.selectionValid(selection)));
  }
  private selectionValid(selection: SelectionState) {
    const context = this.context(), pane = context?.panes.find(pane => pane.pane_id === selection.pane_id);
    return !!pane && !context!.surface.popup && context!.snapshot.boot_id === selection.boot && selection.generation === this.selectionRevision
      && pane.content_revision === selection.pane.content_revision && pane.alternate_screen_active === selection.pane.alternate_screen_active
      && (top(pane) === top(selection.pane) || selection.scrollOffsets.has(pane.scroll?.offset_from_bottom ?? -1)) && JSON.stringify(pane.inner_rect) === JSON.stringify(selection.pane.inner_rect);
  }
  private highlight(selection: SelectionState) {
    const pane = this.context()?.panes.find(pane => pane.pane_id === selection.pane_id);
    if (!pane) return;
    const shift = selection.base - top(pane), inner = pane.inner_rect;
    const point = (value: Point): Point => {
      const row = value.row + shift;
      return row < 0 ? { row: 0, col: 0 } : row >= inner.height ? { row: inner.height - 1, col: inner.width - 1 } : { row, col: value.col };
    };
    this.options.onSelection?.({ pane_id: selection.pane_id, anchor: point(selection.anchor), cursor: point(selection.cursor) });
  }
  private stopSelectionScroll() { clearTimeout(this.selectionScrollTimer); this.selectionScrollTimer = undefined; }
  private moveSelection(selection: SelectionState, pane: PaneSurfacePane, event: Mouse) {
    selection.pointer = event;
    const point = local(pane.inner_rect, event), target = this.scrollTargets.get(pane.pane_id);
    const viewportTop = target && selection.scrollOffsets.has(target.offset) && pane.scroll ? pane.scroll.max_offset_from_bottom - target.offset : top(pane);
    const row = point.row + viewportTop - selection.base;
    if (selection.word) {
      const bounds = viewportTop === top(pane) ? this.bounds(pane, point) ?? [point.col, point.col] : [0, pane.inner_rect.width - 1];
      const anchor = { row: selection.word.anchor.row, col: selection.word.bounds[0] }, cursor = { row, col: bounds[0]! };
      selection.anchor = before(cursor, anchor) ? cursor : anchor;
      const anchorEnd = { row: selection.word.anchor.row, col: selection.word.bounds[1] }, cursorEnd = { row, col: bounds[1]! };
      selection.cursor = before(cursorEnd, anchorEnd) ? anchorEnd : cursorEnd;
    } else selection.cursor = { row, col: point.col };
    if (!same(selection.anchor, selection.cursor) || selection.word) this.highlight(selection);
  }
  private selectionScroll(selection: SelectionState) {
    this.stopSelectionScroll();
    if (this.disposed || this.selection !== selection || !selection.dragging || !this.selectionValid(selection) || !selection.pointer) return;
    const pane = this.context()!.panes.find(pane => pane.pane_id === selection.pane_id)!, metrics = pane.scroll, inner = pane.inner_rect, pointer = selection.pointer;
    if (!metrics || pane.alternate_screen_active) return;
    const distance = pointer.row < inner.y ? inner.y - pointer.row : pointer.row >= inner.y + inner.height ? inner.y + inner.height - pointer.row - 1 : 0;
    if (!distance) return;
    const previous = this.scrollTargets.get(pane.pane_id)?.offset ?? metrics.offset_from_bottom;
    const offset = Math.max(0, Math.min(metrics.max_offset_from_bottom, previous + Math.sign(distance) * Math.min(15, Math.abs(distance) * 3)));
    if (offset === previous) return;
    selection.scrollOffsets.add(offset);
    this.scroll(pane, offset, selection); this.moveSelection(selection, pane, pointer);
    this.selectionScrollTimer = setTimeout(() => this.selectionScroll(selection), 30);
    this.selectionScrollTimer.unref();
  }
  private copySelection(selection: SelectionState) {
    const base = selection.base;
    this.enqueue(() => {
      if (!this.selectionValid(selection)) return;
      // Selection reads must not hold subsequent typing behind a remote round trip.
      const read = this.options.request('pane.selection.read', { pane_id: selection.pane_id,
        anchor: { row: selection.anchor.row + base, col: selection.anchor.col }, cursor: { row: selection.cursor.row + base, col: selection.cursor.col }, content_revision: selection.pane.content_revision }).then(result => {
        if (this.disposed || !this.selectionValid(selection)) return;
        if (result && typeof result === 'object' && 'text' in result && typeof result.text === 'string'
          && (!('pane_id' in result) || result.pane_id === selection.pane_id)) this.options.onCopy?.(result.text);
      }).catch(reason => {
        if (!this.disposed && this.selectionValid(selection)) this.options.onError?.(reason instanceof Error ? reason : new Error(String(reason)));
      }).finally(() => this.reads.delete(read));
      this.reads.add(read);
    });
  }
  private bounds(pane: PaneSurfacePane, point: Point): [number, number] | undefined {
    const frame = this.options.getSurface()!.frame, inner = pane.inner_rect;
    let text = '';
    for (let x = 0; x < inner.width;) {
      const cell = frame.cells[(inner.y + point.row) * frame.width + inner.x + x];
      const symbol = cell?.symbol || ' ';
      text += symbol; x += Math.max(1, cellWidth(symbol));
    }
    return wordBounds(text, point.col);
  }
  private routeMouse(event: Mouse) {
    const context = this.context();
    if (!context) return;
    const kind = event.kind;
    const up = kind === 'Release' || typeof kind === 'object' && 'Up' in kind;
    const drag = typeof kind === 'object' && 'Drag' in kind;
    const down = typeof kind === 'object' && 'Down' in kind;
    if (down && this.mouseGesture) this.releaseMouse();
    if (this.mouseGesture && (up || drag)) {
      const gesture = this.mouseGesture;
      if (typeof kind === 'object' && ('Up' in kind && kind.Up !== gesture.button || 'Drag' in kind && kind.Drag !== gesture.button)) return;
      if (!this.valid(gesture.target)) { this.mouseGesture = undefined; return; }
      gesture.rect = gesture.target.kind === 'popup' ? popupInputRect(context.surface)! : context.panes.find(pane => pane.pane_id === gesture.target.id)!.inner_rect;
      gesture.last = event;
      const message = this.mouseEvent(gesture.rect, event, up ? { Up: gesture.button } : { Drag: gesture.button });
      if (message) this.send(gesture.target, message);
      if (up) this.mouseGesture = undefined;
      return;
    }
    if (context.surface.popup) {
      const popup = context.surface.popup, rect = popupInputRect(context.surface)!;
      if (!rect || !contains(rect, event) || !popup.mouse_reporting && !(typeof kind === 'string' && kind.startsWith('Scroll'))) return;
      if (up || drag) return;
      const target: InputTarget = { kind: 'popup', id: popup.terminal_id, boot: context.snapshot.boot_id }, message = this.mouseEvent(rect, event);
      if (message) this.send(target, message);
      if (down) this.mouseGesture = { target, rect, button: kind.Down, last: event };
      return;
    }
    if ((this.scrollbarGesture || this.splitGesture || this.selection?.dragging) && typeof kind === 'object'
      && ('Up' in kind && kind.Up !== 'Left' || 'Drag' in kind && kind.Drag !== 'Left')) return;
    if (this.scrollbarGesture && (up || drag)) {
      const gesture = this.scrollbarGesture, pane = context.panes.find(pane => pane.pane_id === gesture.pane);
      if (pane && context.snapshot.boot_id === gesture.boot) this.scroll(pane, scrollOffset(pane, event.row, gesture.grab));
      if (up) this.scrollbarGesture = undefined;
      return;
    }
    if (this.splitGesture && (up || drag)) {
      const gesture = this.splitGesture;
      if (gesture.boot === context.snapshot.boot_id && gesture.topology === this.topology(context)) {
        const split = gesture.split, horizontal = split.direction === 'Horizontal';
        const pointer = horizontal ? event.column : event.row, origin = horizontal ? split.area.x : split.area.y, length = horizontal ? split.area.width : split.area.height;
        const ratio = Math.max(.1, Math.min(.9, (pointer + gesture.offset - origin) / Math.max(1, length)));
        if (ratio !== gesture.last) {
          gesture.last = ratio;
          this.endpointLatest('split:' + JSON.stringify(split.path), 'layout.set_split_ratio', { tab_id: this.options.tabId, path: split.path, ratio }, () => {
            const current = this.context(); return !!current && !current.surface.popup && current.snapshot.boot_id === gesture.boot && this.topology(current) === gesture.topology;
          });
        }
      }
      if (up) this.splitGesture = undefined;
      return;
    }
    if (this.selection?.dragging && (up || drag)) {
      const selection = this.selection, pane = context.panes.find(pane => pane.pane_id === selection.pane_id)!;
      const point = local(pane.inner_rect, event);
      this.moveSelection(selection, pane, event);
      if (drag) this.selectionScroll(selection);
      if (drag && this.lastClick && !same(this.lastClick.point, point)) this.lastClick = undefined;
      if (up) {
        this.stopSelectionScroll();
        selection.dragging = false;
        if (same(selection.anchor, selection.cursor) && !selection.word) this.clearSelection();
        else this.copySelection(selection);
      }
      return;
    }
    if (down) { this.releaseMouse(); this.clearSelection(); this.splitGesture = undefined; this.scrollbarGesture = undefined; }
    if (down && kind.Down === 'Left') {
      const barPane = context.panes.find(pane => pane.scrollbar_rect && contains(pane.scrollbar_rect, event) && thumb(pane));
      if (barPane) {
        this.lastClick = undefined; this.focusPane(barPane);
        const bar = thumb(barPane)!;
        if (event.row >= bar.top && event.row < bar.top + bar.length) this.scrollbarGesture = { pane: barPane.pane_id, boot: context.snapshot.boot_id, grab: event.row - bar.top };
        else this.scroll(barPane, scrollOffset(barPane, event.row));
        return;
      }
      const split = context.surface.splits.find(split => contains(split.hit_rect, event));
      if (split) {
        this.lastClick = undefined;
        this.splitGesture = { split, offset: split.pos - (split.direction === 'Horizontal' ? event.column : event.row), topology: this.topology(context), boot: context.snapshot.boot_id };
        return;
      }
    }
    const pane = context.panes.find(pane => contains(pane.rect, event));
    if (!pane) return;
    if (down) this.focusPane(pane);
    if (!contains(pane.inner_rect, event)) return;
    if (typeof kind === 'string' && kind.startsWith('Scroll')) {
      this.focusPane(pane); this.clearSelection(); this.lastClick = undefined;
      if (!pane.mouse_reporting && !pane.alternate_screen_active && pane.scroll && (kind === 'ScrollUp' || kind === 'ScrollDown')) {
        const old = this.scrollTargets.get(pane.pane_id);
        const offset = Math.max(0, Math.min(pane.scroll.max_offset_from_bottom, (old && old.revision >= pane.content_revision ? old.offset : pane.scroll.offset_from_bottom) + (kind === 'ScrollUp' ? 3 : -3)));
        this.scroll(pane, offset);
      } else { const message = this.mouseEvent(pane.inner_rect, event); if (message) this.send(this.paneTarget(pane), message); }
      return;
    }
    if (pane.mouse_reporting) {
      if (up || drag) return;
      const target = this.paneTarget(pane), message = this.mouseEvent(pane.inner_rect, event);
      if (message) this.send(target, message);
      if (down) this.mouseGesture = { target, rect: pane.inner_rect, button: kind.Down, last: event };
    } else if (down && kind.Down === 'Left') {
      const point = local(pane.inner_rect, event), at = Date.now(), previous = this.lastClick;
      const double = !event.modifiers && previous?.pane === pane.pane_id && at - previous.at <= 350 && Math.abs(previous.point.row - point.row) <= 1 && Math.abs(previous.point.col - point.col) <= 1;
      this.lastClick = !event.modifiers && !double ? { pane: pane.pane_id, point, at } : undefined;
      const bounds = double ? this.bounds(pane, point) : undefined;
      this.selection = { pane_id: pane.pane_id, pane, anchor: bounds ? { row: point.row, col: bounds[0] } : point, cursor: bounds ? { row: point.row, col: bounds[1] } : point,
        boot: context.snapshot.boot_id, generation: this.selectionRevision, dragging: true, base: top(pane), scrollOffsets: new Set(), word: bounds ? { anchor: point, bounds } : undefined };
      if (bounds) this.highlight(this.selection);
    }
  }
  dispose() {
    this.disposed = true; this.parser.dispose(); this.mouseGesture = undefined; this.splitGesture = undefined; this.scrollbarGesture = undefined;
    this.clearSelection(); this.scrollTargets.clear(); this.latest.clear(); this.batch = undefined;
  }
}
