import test from 'node:test';
import assert from 'node:assert/strict';
import { HerdrInputRouter, VtInputParser, wordBounds, type HerdrSelection } from './herdr/input.ts';
import { cellWidth, popupInnerRect } from './herdr/screen.ts';
import { encodeClientMessage, type ClientMessage, type ClientPaneInputEvent, type ClientShellSnapshot, type FrameData, type PaneSurfaceFrame, type PaneSurfacePane } from './herdr/wire.ts';
import { terminalKey } from '../web/src/terminal-input.ts';

type Parsed = Parameters<ConstructorParameters<typeof VtInputParser>[0]>[0];
const mouse = (code: number, column: number, row: number, up = false) => `\x1b[<${code};${column + 1};${row + 1}${up ? 'm' : 'M'}`;
function parse(...chunks: Array<string | Buffer>) {
  const events: Parsed[] = [], errors: Error[] = [];
  const parser = new VtInputParser(value => events.push(value), error => errors.push(error));
  for (const chunk of chunks) parser.write(chunk);
  parser.flushEscape(); parser.dispose();
  assert.deepEqual(errors, []);
  return events;
}
function events(values: Parsed[]) { return values.flatMap(value => 'event' in value ? [value.event] : []); }
function keyShape(value: ClientPaneInputEvent) { assert.ok('Key' in value); return { code: value.Key.code, modifiers: value.Key.modifiers }; }
function frame(width: number, height: number): FrameData {
  return { width, height, cursor: null, hyperlinks: [], graphics: Buffer.alloc(0), cells: Array.from({ length: width * height }, () => ({ symbol: ' ', fg: 0, bg: 0, modifier: 0, skip: false, hyperlink: null })) };
}
function fixture() {
  const panes: PaneSurfacePane[] = ['a', 'b'].map((pane_id, index) => ({ pane_id, content_revision: 7,
    rect: { x: index * 20, y: 0, width: 20, height: 12 }, inner_rect: { x: index * 20 + 1, y: 1, width: 17, height: 10 },
    scrollbar_rect: { x: index * 20 + 18, y: 1, width: 1, height: 10 }, scroll: { offset_from_bottom: 10, max_offset_from_bottom: 100, viewport_rows: 10 },
    focused: index === 0, mouse_reporting: false, sgr_pixel_mouse: false, alternate_screen_active: false, pixel_width: 170, pixel_height: 200 }));
  let surface: PaneSurfaceFrame = { boot_id: 'boot', projection_revision: 3, surface_revision: 5, frame: frame(40, 12), panes,
    splits: [{ direction: 'Horizontal', pos: 20, area: { x: 0, y: 0, width: 40, height: 12 }, hit_rect: { x: 19, y: 0, width: 2, height: 12 }, path: [] }], popup: null };
  let snapshot: ClientShellSnapshot = { boot_id: 'boot', revision: 5, focused_workspace_id: 'w', focused_tab_id: 't', focused_pane_id: 'a',
    tabs: [{ tab_id: 't', workspace_id: 'w', focused: true }], panes: panes.map(pane => ({ pane_id: pane.pane_id, tab_id: 't', workspace_id: 'w', focused: pane.focused, right_click_passthrough: false })) };
  const messages: ClientMessage[] = [], requests: Array<{ method: string; params: Record<string, unknown> }> = [], errors: Error[] = [], copied: string[] = [], selections: Array<HerdrSelection | undefined> = [];
  let handler: (method: string, params: Record<string, unknown>) => Promise<unknown> = async method => method === 'pane.selection.read' ? { text: 'selected', pane_id: 'a' } : {};
  const router = new HerdrInputRouter({ tabId: 't', getSurface: () => surface, getSnapshot: () => snapshot,
    send: message => { encodeClientMessage(message); messages.push(message); }, request: async (method, params) => { requests.push({ method, params }); return handler(method, params); },
    onCopy: value => copied.push(value), onSelection: value => selections.push(value), onError: value => errors.push(value) });
  return { router, panes, messages, requests, errors, copied, selections,
    get surface() { return surface; }, set surface(value: PaneSurfaceFrame) { surface = value; },
    get snapshot() { return snapshot; }, set snapshot(value: ClientShellSnapshot) { snapshot = value; },
    set handler(value: typeof handler) { handler = value; },
    inputs() { return messages.flatMap(message => typeof message !== 'string' && 'ClientShellPaneInput' in message ? [message.ClientShellPaneInput] : []); },
    row(pane: PaneSurfacePane, row: number, value: string) {
      let column = 0;
      for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
        const width = Math.max(1, cellWidth(segment));
        if (column + width > pane.inner_rect.width) break;
        const offset = (pane.inner_rect.y + row) * surface.frame.width + pane.inner_rect.x + column;
        surface.frame.cells[offset] = { ...surface.frame.cells[offset]!, symbol: segment };
        for (let i = 1; i < width; i++) surface.frame.cells[offset + i] = { ...surface.frame.cells[offset + i]!, symbol: '', skip: true };
        column += width;
      }
    },
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('native input parses fragmented Unicode, controls, escape and bracketed paste once', () => {
  const text = Buffer.from('中😀');
  const parsed = parse('aA\x00\x03\r\n\t\x7f', text.subarray(0, 2), text.subarray(2, 5), text.subarray(5), '\x1bb', '\x1b[20', '0~a\n\x1b[A中', '\x1b[20', '1~', '\x1b');
  const input = events(parsed);
  assert.deepEqual(input.slice(0, 8).map(keyShape), [
    { code: { Char: 'a' }, modifiers: 0 }, { code: { Char: 'A' }, modifiers: 1 }, { code: { Char: ' ' }, modifiers: 2 },
    { code: { Char: 'c' }, modifiers: 2 }, { code: 'Enter', modifiers: 0 }, { code: { Char: 'j' }, modifiers: 2 },
    { code: 'Tab', modifiers: 0 }, { code: 'Backspace', modifiers: 0 },
  ]);
  assert.deepEqual(input.slice(8, 10), [{ TextCommit: '中' }, { TextCommit: '😀' }]);
  assert.deepEqual(keyShape(input[10]!), { code: { Char: 'b' }, modifiers: 4 });
  assert.deepEqual(input[11], { Paste: 'a\n\x1b[A中' });
  assert.deepEqual(keyShape(input[12]!), { code: 'Esc', modifiers: 0 });
});

test('all softkey modifiers, navigation and function keys map to native semantic events', () => {
  const names = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', Delete: 'Delete', Insert: 'Insert', PageUp: 'PageUp', PageDown: 'PageDown' };
  for (let mask = 0; mask < 16; mask++) {
    const mods = { shift: !!(mask & 1), alt: !!(mask & 2), ctrl: !!(mask & 4), meta: !!(mask & 8) };
    const native = (mask & 1) | (mask & 2 ? 4 : 0) | (mask & 4 ? 2 : 0) | (mask & 8);
    for (const [name, expected] of Object.entries(names)) {
      for (const application of [false, true]) {
        const input = events(parse(terminalKey(name, mods, application)));
        assert.equal(input.length, 1); assert.deepEqual(keyShape(input[0]!), { code: expected, modifiers: native }, `${name}/${mask}/${application}`);
      }
    }
    for (let number = 1; number <= 12; number++) assert.deepEqual(keyShape(events(parse(terminalKey(`F${number}`, mods)))[0]!), { code: { F: number }, modifiers: native });
  }
  assert.deepEqual(events(parse('\x1b[1A', '\x1b[Z', '\x1bOp', '\x1bOM')).map(keyShape), [
    { code: 'Up', modifiers: 0 }, { code: 'BackTab', modifiers: 1 }, { code: { Char: '0' }, modifiers: 0 }, { code: 'Enter', modifiers: 0 },
  ]);
});

test('CSI-u and modifyOtherKeys retain modifiers; terminal responses and invalid scalars are ignored', () => {
  const input = events(parse('\x1b[99;6u', '\x1b[27;3;120~', '\x1b[55296u', '\x1b[27;1;55296~', '\x1b]52;c;abc\x07', '\x1bPquery\x1b\\', '\x1b[?1;2c', '\x1b[0n'));
  assert.deepEqual(input.map(keyShape), [{ code: { Char: 'c' }, modifiers: 3 }, { code: { Char: 'x' }, modifiers: 4 }]);
  const invalid = events(parse(Buffer.from([27, 0xe0, 0x80, 0x80])));
  for (const event of invalid) assert.doesNotThrow(() => encodeClientMessage({ ClientShellPaneInput: { pane_id: 'a', events: [event] } }));
});

test('every Enter modifier combination survives the browser link as a native semantic key', () => {
  for (let mask = 0; mask < 16; mask++) {
    const mods = { shift: !!(mask & 1), alt: !!(mask & 2), ctrl: !!(mask & 4), meta: !!(mask & 8) };
    const native = (mods.shift ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.alt ? 4 : 0) | (mods.meta ? 8 : 0);
    assert.deepEqual(events(parse(terminalKey('Enter', mods))).map(keyShape), [{ code: 'Enter', modifiers: native }]);
  }
});

test('SGR and byte-oriented X10 mouse parsing survives fragmentation and high coordinates', () => {
  assert.deepEqual(parse('\x1b[<20;', '10;12M', '\x1b[<0;10;12m', '\x1b[I\x1b[O', Buffer.from([27, 91, 77, 32, 200]), Buffer.from([100])), [
    { mouse: { kind: { Down: 'Left' }, column: 9, row: 11, modifiers: 3 } },
    { mouse: { kind: { Up: 'Left' }, column: 9, row: 11, modifiers: 0 } }, { focus: true }, { focus: false },
    { mouse: { kind: { Down: 'Left' }, column: 167, row: 67, modifiers: 0 } },
  ]);
  assert.deepEqual(parse(mouse(67, 2, 3), mouse(35, 4, 5), mouse(3, 4, 5)), [
    { mouse: { kind: 'ScrollRight', column: 2, row: 3, modifiers: 0 } }, { mouse: { kind: 'Moved', column: 4, row: 5, modifiers: 0 } }, { mouse: { kind: 'Release', column: 4, row: 5, modifiers: 0 } },
  ]);
});

test('standalone escape is emitted after its delay and disposal cancels pending escape', async () => {
  const values: Parsed[] = [], parser = new VtInputParser(value => values.push(value), error => { throw error; }, 5);
  parser.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 15));
  assert.deepEqual(events(values).map(keyShape), [{ code: 'Esc', modifiers: 0 }]);
  parser.write('\x1b'); parser.dispose(); await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(values.length, 1);
});

test('input batches plain typing while retaining endpoint and focus ordering', async () => {
  const f = fixture();
  f.router.write('x'.repeat(1025)); await f.router.drain();
  assert.equal(f.inputs().length, 9); assert.equal(f.inputs().flatMap(input => input.events).length, 1025);
  f.messages.length = 0;
  f.router.write(mouse(0, 22, 2) + 'hello' + mouse(0, 2, 2) + 'world'); await f.router.drain();
  assert.deepEqual(f.requests.map(request => [request.method, request.params.pane_id]), [['pane.focus', 'b'], ['pane.focus', 'a']]);
  assert.deepEqual(f.inputs().map(input => [input.pane_id, input.events.length]), [['b', 5], ['a', 5]]);
  assert.deepEqual(f.errors, []); f.router.dispose();
});

test('click then type is bound immediately but held until native focus succeeds', async () => {
  const f = fixture(), focus = deferred<unknown>();
  f.handler = async method => method === 'pane.focus' ? focus.promise : {};
  f.router.write(mouse(0, 22, 2)); await tick();
  f.router.write('typed'); await tick(); assert.equal(f.inputs().length, 0);
  focus.resolve({}); await f.router.drain();
  assert.deepEqual(f.inputs().map(input => input.pane_id), ['b']);
  f.snapshot = { ...f.snapshot, revision: 6, focused_pane_id: 'b' }; f.router.refresh(); f.router.write('!'); await f.router.drain();
  assert.equal(f.inputs().at(-1)!.pane_id, 'b'); f.router.dispose();
});

test('failed focus drops already queued input without misrouting it to the old pane', async () => {
  const f = fixture(), focus = deferred<unknown>();
  f.handler = async () => focus.promise;
  f.router.write(mouse(0, 22, 2) + 'never'); await tick(); focus.reject(new Error('focus failed')); await f.router.drain();
  assert.equal(f.inputs().length, 0); assert.match(f.errors[0]!.message, /focus failed/);
  f.router.write('old'); await f.router.drain(); assert.equal(f.inputs()[0]!.pane_id, 'a'); f.router.dispose();
});

test('pending input cannot cross tab, boot, removed-pane or popup boundaries', async () => {
  for (const change of ['tab', 'boot', 'pane', 'popup']) {
    const f = fixture(), focus = deferred<unknown>();
    f.handler = async () => focus.promise;
    f.router.write(mouse(0, 22, 2) + 'never'); await tick();
    if (change === 'tab') f.snapshot = { ...f.snapshot, focused_tab_id: 'other' };
    if (change === 'boot') f.snapshot = { ...f.snapshot, boot_id: 'new' };
    if (change === 'pane') f.snapshot = { ...f.snapshot, panes: f.snapshot.panes.filter(pane => pane.pane_id !== 'b') };
    if (change === 'popup') f.surface = { ...f.surface, popup: { terminal_id: 'pop', title: '', frame: frame(10, 5), width: null, height: null, mouse_reporting: false, sgr_pixel_mouse: false, pixel_width: 100, pixel_height: 100 } };
    f.router.refresh(); focus.resolve({}); await f.router.drain(); assert.equal(f.inputs().length, 0, change); f.router.dispose();
  }
});

test('application mouse coordinates are pane-local and captured through cross-pane drag and release', async () => {
  const f = fixture(); f.panes[1]!.mouse_reporting = true;
  f.router.write(mouse(0, 23, 3) + mouse(32, 0, 11) + mouse(0, 0, 11, true)); await f.router.drain();
  const input = f.inputs().flatMap(input => { assert.equal(input.pane_id, 'b'); return input.events; });
  assert.deepEqual(input.map(event => { assert.ok('Mouse' in event); return [event.Mouse.kind, event.Mouse.position]; }), [
    [{ Down: 'Left' }, { Cell: { column: 2, row: 2 } }], [{ Drag: 'Left' }, { Cell: { column: 0, row: 9 } }], [{ Up: 'Left' }, { Cell: { column: 0, row: 9 } }],
  ]); f.router.dispose();
});

test('losing focus releases held native mouse before focus notification', async () => {
  const f = fixture(); f.panes[0]!.mouse_reporting = true;
  f.router.write(mouse(0, 3, 3) + '\x1b[O'); await f.router.drain();
  assert.deepEqual(f.inputs().flatMap(input => input.events).map(event => { assert.ok('Mouse' in event); return event.Mouse.kind; }), [{ Down: 'Left' }, { Up: 'Left' }]);
  assert.deepEqual(f.messages.at(-1), { ClientShellFocus: { focused: false } });
  f.router.write(mouse(32, 4, 4) + mouse(0, 4, 4, true)); await f.router.drain(); assert.equal(f.messages.length, 2); f.router.dispose();
});

test('native history wheel coalesces offsets; application and alternate-screen wheel stay native', async () => {
  const f = fixture();
  f.router.write(mouse(64, 3, 3).repeat(5)); await f.router.drain();
  assert.deepEqual(f.requests, [{ method: 'pane.scroll', params: { pane_id: 'a', offset_from_bottom: 25 } }]);
  f.panes[0]!.mouse_reporting = true; f.router.write(mouse(65, 3, 3));
  f.panes[1]!.alternate_screen_active = true; f.router.write(mouse(64, 23, 3)); await f.router.drain();
  assert.deepEqual(f.inputs().flatMap(input => input.events).map(event => { assert.ok('Mouse' in event); return event.Mouse.kind; }), ['ScrollDown', 'ScrollUp']);
  f.router.dispose();
});

test('history scrolling respects typing barriers and fresh external offsets', async () => {
  const f = fixture(); f.router.write(mouse(64, 3, 3) + 'x' + mouse(64, 3, 3)); await f.router.drain();
  assert.equal(f.requests.length, 2); assert.deepEqual(f.requests.map(request => request.params.offset_from_bottom), [13, 13]);
  f.panes[0] = { ...f.panes[0]!, content_revision: 8, scroll: { offset_from_bottom: 40, max_offset_from_bottom: 100, viewport_rows: 10 } };
  f.router.refresh(); f.router.write(mouse(65, 3, 3)); await f.router.drain(); assert.equal(f.requests.at(-1)!.params.offset_from_bottom, 37); f.router.dispose();
});

test('scrollbar track clicks and thumb dragging use native history with clamping', async () => {
  const f = fixture();
  f.router.write(mouse(0, 18, 1)); await f.router.drain();
  assert.equal(f.requests[0]!.params.offset_from_bottom, 100);
  f.panes[0]!.scroll!.offset_from_bottom = 0; f.router.refresh();
  f.router.write(mouse(0, 18, 10) + mouse(32, 18, 0) + mouse(0, 18, 0, true)); await f.router.drain();
  assert.equal(f.requests.at(-1)!.params.offset_from_bottom, 100);
  assert.equal(f.inputs().length, 0); f.router.dispose();
});

test('split dragging sends final bounded ratio and drops requests for changed topology', async () => {
  const f = fixture();
  f.router.write(mouse(0, 20, 3) + mouse(32, 0, 3) + mouse(32, 39, 3) + mouse(0, 39, 3, true)); await f.router.drain();
  assert.deepEqual(f.requests, [{ method: 'layout.set_split_ratio', params: { tab_id: 't', path: [], ratio: .9 } }]);
  f.router.write(mouse(0, 20, 3) + mouse(32, 1, 3)); f.surface = { ...f.surface, splits: [] }; f.router.refresh(); await f.router.drain();
  assert.equal(f.requests.length, 1); f.router.dispose();
});

test('ordinary shell drag selection highlights viewport cells and copies absolute native history rows', async () => {
  const f = fixture();
  f.router.write(mouse(0, 3, 2) + mouse(32, 7, 3) + mouse(0, 7, 3, true)); await f.router.drain();
  assert.deepEqual(f.selections.at(-1), { pane_id: 'a', anchor: { row: 1, col: 2 }, cursor: { row: 2, col: 6 } });
  assert.deepEqual(f.requests, [{ method: 'pane.selection.read', params: { pane_id: 'a', anchor: { row: 91, col: 2 }, cursor: { row: 92, col: 6 }, content_revision: 7 } }]);
  assert.deepEqual(f.copied, ['selected']); assert.equal(f.inputs().length, 0); f.router.dispose();
});

test('selection refresh and newer input invalidate late copy replies', async () => {
  for (const change of ['key', 'content', 'scroll', 'geometry', 'dispose']) {
    const f = fixture(), read = deferred<unknown>(); f.handler = async () => read.promise;
    f.router.write(mouse(0, 2, 2) + mouse(32, 7, 2) + mouse(0, 7, 2, true)); await tick();
    if (change === 'key') f.router.write('x');
    if (change === 'content') f.panes[0] = { ...f.panes[0]!, content_revision: 8 };
    if (change === 'scroll') f.panes[0] = { ...f.panes[0]!, scroll: { ...f.panes[0]!.scroll!, offset_from_bottom: 50 } };
    if (change === 'geometry') f.panes[0] = { ...f.panes[0]!, inner_rect: { ...f.panes[0]!.inner_rect, width: 16 } };
    if (change === 'dispose') f.router.dispose(); else f.router.refresh();
    read.resolve({ text: 'stale' }); await f.router.drain(); assert.deepEqual(f.copied, [], change); assert.equal(f.selections.at(-1), undefined, change); f.router.dispose();
  }
});

test('double click selects complete words and drag expands by words before copying once', async () => {
  const f = fixture(); f.row(f.panes[0]!, 1, 'one two three');
  f.router.write(mouse(0, 6, 2) + mouse(0, 6, 2, true) + mouse(0, 6, 2) + mouse(32, 11, 2) + mouse(0, 11, 2, true)); await f.router.drain();
  assert.deepEqual(f.selections.at(-1), { pane_id: 'a', anchor: { row: 1, col: 4 }, cursor: { row: 1, col: 12 } });
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0]!.params.anchor, { row: 91, col: 4 }); assert.deepEqual(f.requests[0]!.params.cursor, { row: 91, col: 12 });
  assert.deepEqual(f.copied, ['selected']); f.router.dispose();
});

test('word boundaries preserve URL punctuation, quoted paths and wide graphemes', () => {
  assert.deepEqual(wordBounds('abc def', 5), [4, 6]); assert.equal(wordBounds('abc def', 3), undefined);
  const url = 'https://x.test/a_(b)?q=1'; assert.deepEqual(wordBounds(`(${url}).`, 12), [1, url.length]);
  assert.deepEqual(wordBounds('"/tmp/my file.txt"', 9), [1, 16]);
  assert.deepEqual(wordBounds('中😀文 test', 3), [0, 5]);
  assert.deepEqual(wordBounds('e\u0301clair end', 2), [0, 5]);
});

test('copy shortcut reuses retained selection; application copy keys pass through without selection', async () => {
  const f = fixture();
  f.router.write(mouse(0, 2, 2) + mouse(32, 7, 2) + mouse(0, 7, 2, true)); await f.router.drain();
  f.router.write('\x1b[99;6u'); await f.router.drain(); assert.equal(f.copied.length, 2); assert.equal(f.inputs().length, 0);
  f.router.write('x\x1b[99;6u'); await f.router.drain(); assert.equal(f.inputs().flatMap(input => input.events).length, 2); f.router.dispose();
});

test('popup input is isolated from underlying panes and captured mouse stays popup-local', async () => {
  const f = fixture(); f.surface = { ...f.surface, popup: { terminal_id: 'pop', title: '', frame: frame(10, 4), width: null, height: null, mouse_reporting: true, sgr_pixel_mouse: false, pixel_width: 100, pixel_height: 80 } };
  const rect = popupInnerRect(f.surface)!;
  f.router.write('hello' + mouse(0, 2, 2) + mouse(0, rect.x + 2, rect.y + 1) + mouse(32, 39, 11) + '\x1b[O'); await f.router.drain();
  assert.equal(f.inputs().length, 0); assert.equal(f.requests.length, 0);
  const inputs = f.messages.flatMap(message => typeof message !== 'string' && 'ClientShellPopupInput' in message ? message.ClientShellPopupInput.events : []);
  assert.equal(inputs.length, 8);
  assert.deepEqual(inputs.slice(5).map(event => { assert.ok('Mouse' in event); return [event.Mouse.kind, event.Mouse.position]; }), [
    [{ Down: 'Left' }, { Cell: { column: 2, row: 1 } }], [{ Drag: 'Left' }, { Cell: { column: 9, row: 3 } }], [{ Up: 'Left' }, { Cell: { column: 9, row: 3 } }],
  ]); f.router.dispose();
});

test('oversized paste is rejected through its end marker without leaking text into shell input', () => {
  const values: Parsed[] = [], errors: Error[] = [], parser = new VtInputParser(value => values.push(value), error => errors.push(error));
  parser.write('\x1b[200~'); parser.write('x'.repeat(1024 * 1024)); parser.write('oversized\n');
  parser.write('must not type\r\x1b[20'); parser.write('1~z');
  assert.equal(errors.length, 1); assert.match(errors[0]!.message, /Pasted text exceeds/);
  assert.deepEqual(events(values).map(keyShape), [{ code: { Char: 'z' }, modifiers: 0 }]); parser.dispose();
  const exact = parse('\x1b[200~', 'x'.repeat(1024 * 1024), '\x1b[201~');
  assert.equal(events(exact).length, 1); assert.ok('Paste' in events(exact)[0]!); assert.equal((events(exact)[0] as { Paste: string }).Paste.length, 1024 * 1024);
});

test('oversized terminal replies remain ignored across fragmented terminators', async () => {
  const values: Parsed[] = [], errors: Error[] = [], parser = new VtInputParser(value => values.push(value), error => errors.push(error), 1);
  parser.write('\x1b]52;c;' + 'a'.repeat(1024 * 1024)); parser.write('\x1b');
  await new Promise(resolve => setTimeout(resolve, 5)); parser.write('\\z');
  assert.equal(errors.length, 1); assert.deepEqual(events(values).map(keyShape), [{ code: { Char: 'z' }, modifiers: 0 }]); parser.dispose();
});

test('extended control keys retain explicit semantics instead of reinterpreting legacy bytes', () => {
  assert.deepEqual(events(parse('\x1b[8;5u\x1b[27;3;8~\x1b[65;5u')).map(keyShape), [
    { code: 'Backspace', modifiers: 2 }, { code: 'Backspace', modifiers: 4 }, { code: { Char: 'A' }, modifiers: 2 },
  ]);
});

test('external resize clamps queued mouse and focus-loss release to the current pane size', async () => {
  const f = fixture(), focus = deferred<unknown>(); f.panes[1]!.mouse_reporting = true;
  f.handler = async () => focus.promise;
  f.router.write(mouse(0, 37, 10)); await tick();
  f.panes[1] = { ...f.panes[1]!, inner_rect: { x: 21, y: 1, width: 5, height: 4 } }; f.router.refresh(); f.router.write('\x1b[O');
  focus.resolve({}); await f.router.drain();
  assert.deepEqual(f.inputs().flatMap(input => input.events).map(event => { assert.ok('Mouse' in event); return event.Mouse.position; }), [{ Cell: { column: 4, row: 3 } }, { Cell: { column: 4, row: 3 } }]); f.router.dispose();
});

test('split dragging follows externally resized container geometry', async () => {
  const f = fixture(); f.router.write(mouse(0, 20, 3));
  f.surface = { ...f.surface, frame: frame(80, 12), splits: [{ ...f.surface.splits[0]!, area: { x: 0, y: 0, width: 80, height: 12 } }] }; f.router.refresh();
  f.router.write(mouse(32, 39, 3) + mouse(0, 39, 3, true)); await f.router.drain();
  assert.equal(f.requests[0]!.params.ratio, 39 / 80); f.router.dispose();
});

test('unrelated button release does not end an active application drag', async () => {
  const f = fixture(); f.panes[0]!.mouse_reporting = true;
  f.router.write(mouse(0, 3, 3) + mouse(2, 4, 3, true) + mouse(32, 5, 3) + mouse(0, 5, 3, true)); await f.router.drain();
  assert.deepEqual(f.inputs().flatMap(input => input.events).map(event => { assert.ok('Mouse' in event); return event.Mouse.kind; }), [{ Down: 'Left' }, { Drag: 'Left' }, { Up: 'Left' }]); f.router.dispose();
});

test('a slow selection read never blocks typing and cannot copy after newer input', async () => {
  const f = fixture(), read = deferred<unknown>(); f.handler = async () => read.promise;
  f.router.write(mouse(0, 2, 2) + mouse(32, 7, 2) + mouse(0, 7, 2, true)); await tick();
  f.router.write('continue'); await tick(); assert.equal(f.inputs().flatMap(input => input.events).length, 8);
  read.resolve({ text: 'stale' }); await f.router.drain(); assert.deepEqual(f.copied, []); f.router.dispose();
});

test('dragging beyond pane edge scrolls native history and keeps absolute selection endpoints', async () => {
  const f = fixture();
  f.router.write(mouse(0, 4, 5) + mouse(32, 4, 0)); await f.router.drain();
  assert.deepEqual([...f.requests], [{ method: 'pane.scroll', params: { pane_id: 'a', offset_from_bottom: 13 } }]);
  f.panes[0] = { ...f.panes[0]!, scroll: { ...f.panes[0]!.scroll!, offset_from_bottom: 13 } }; f.router.refresh();
  assert.deepEqual(f.selections.at(-1), { pane_id: 'a', anchor: { row: 7, col: 3 }, cursor: { row: 0, col: 3 } });
  f.router.write(mouse(0, 4, 0, true)); await f.router.drain();
  const read = f.requests.find(request => request.method === 'pane.selection.read')!;
  assert.deepEqual(read.params.anchor, { row: 94, col: 3 }); assert.deepEqual(read.params.cursor, { row: 87, col: 3 });
  assert.deepEqual(f.copied, ['selected']); f.router.dispose();
});

test('selection autoscroll ticks while held and stops on release, blur, disposal or returning inside', async () => {
  for (const stop of ['release', 'blur', 'dispose', 'inside']) {
    const f = fixture();
    f.router.write(mouse(0, 4, 5) + mouse(32, 4, 0)); await f.router.drain();
    await new Promise(resolve => setTimeout(resolve, 45)); await f.router.drain();
    assert.ok(f.requests.filter(request => request.method === 'pane.scroll').length >= 2, stop);
    if (stop === 'release') f.router.write(mouse(0, 4, 0, true));
    if (stop === 'blur') f.router.write('\x1b[O');
    if (stop === 'dispose') f.router.dispose();
    if (stop === 'inside') f.router.write(mouse(32, 4, 4));
    await f.router.drain(); const count = f.requests.filter(request => request.method === 'pane.scroll').length;
    await new Promise(resolve => setTimeout(resolve, 55)); await f.router.drain();
    assert.equal(f.requests.filter(request => request.method === 'pane.scroll').length, count, stop); f.router.dispose();
  }
});

test('selection autoscroll stops at scroll bounds and never runs in alternate screen', async () => {
  for (const alternate of [false, true]) {
    const f = fixture(); f.panes[0]!.alternate_screen_active = alternate; f.panes[0]!.scroll!.offset_from_bottom = 99;
    f.router.write(mouse(0, 4, 5) + mouse(32, 4, 0)); await f.router.drain();
    await new Promise(resolve => setTimeout(resolve, 45)); await f.router.drain();
    assert.deepEqual(f.requests.map(request => request.params.offset_from_bottom), alternate ? [] : [100]); f.router.dispose();
  }
});

test('blur cancels unsent selection scroll requests behind an in-flight focus operation', async () => {
  const f = fixture(), focus = deferred<unknown>(); f.handler = async method => method === 'pane.focus' ? focus.promise : {};
  f.router.write(mouse(0, 24, 5) + mouse(32, 24, 0)); await tick();
  f.router.write('\x1b[O'); focus.resolve({}); await f.router.drain();
  assert.deepEqual(f.requests.map(request => request.method), ['pane.focus']); f.router.dispose();
});
