import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bindTerminalMouseDefaults,
  rightMouseInput,
  type RightMouseAction,
} from './terminal-mouse-defaults.ts'
import type { RightClickMode } from './terminal-settings.ts'

function fixture(mode: RightClickMode = 'menu') {
  const view = new EventTarget(),
    document = Object.assign(new EventTarget(), { defaultView: view })
  const surface = Object.assign(new EventTarget(), { ownerDocument: document })
  let active = true
  const sent: RightMouseAction[] = []
  const controller = bindTerminalMouseDefaults(
    surface as unknown as HTMLElement,
    () => active,
    () => mode,
    (_event, action) => {
      if (active) sent.push(action)
      return active
    },
  )
  const event = (
    target: EventTarget,
    type: string,
    button = 2,
    buttons = type.endsWith('up') ? 0 : button === 2 ? 2 : button === 1 ? 4 : 1,
  ) => {
    const value = new Event(type, { cancelable: true })
    Object.assign(value, { button, buttons })
    target.dispatchEvent(value)
    return value.defaultPrevented
  }
  const press = () => {
    event(document, 'pointerdown')
    event(surface, 'pointerdown')
    return event(surface, 'mousedown')
  }
  return {
    view,
    document,
    surface,
    sent,
    controller,
    event,
    press,
    mode(value: RightClickMode) {
      mode = value
    },
    active(value: boolean) {
      active = value
    },
  }
}

test('default pane menu owns the entire gesture while browser contextmenu is always prevented', () => {
  const f = fixture()
  assert(f.press())
  assert(f.controller.allowsContextMenu())
  f.mode('terminal')
  assert(f.event(f.document, 'mousemove'))
  assert(f.event(f.document, 'mouseup'))
  assert(f.event(f.surface, 'contextmenu'))
  assert(f.controller.allowsContextMenu())
  assert.deepEqual(f.sent, [], 'switching to native mid-gesture cannot leak drag/up')
  f.press()
  assert(!f.controller.allowsContextMenu())
  assert.deepEqual(f.sent, ['down'])
  f.controller.dispose()
  assert.deepEqual(f.sent, ['down', 'up'])
})

test('terminal mode sends one down/drag/up through external preference and modifier changes', () => {
  const f = fixture('terminal')
  assert(f.press())
  assert(!f.controller.allowsContextMenu())
  f.mode('menu')
  f.event(f.document, 'keydown')
  assert(f.event(f.document, 'mousemove'))
  assert(f.event(f.document, 'mouseup'))
  assert(f.event(f.surface, 'contextmenu'))
  assert(!f.controller.allowsContextMenu())
  assert.deepEqual(f.sent, ['down', 'drag', 'up'])
  f.event(f.document, 'pointerdown', 0)
  assert(f.controller.allowsContextMenu(), 'new gestures use the new preference')
  f.controller.dispose()
})

test('blur and disposal release a held native button once and disconnected views send no input', () => {
  for (const type of ['blur', 'visibilitychange']) {
    const f = fixture('terminal')
    f.press()
    f.event(type === 'blur' ? f.view : f.document, type)
    assert.deepEqual(f.sent, ['down', 'up'])
    f.controller.dispose()
    assert.equal(f.sent.length, 2)
  }
  const f = fixture('terminal')
  f.active(false)
  f.press()
  f.event(f.document, 'mousemove')
  f.event(f.document, 'mouseup')
  assert.deepEqual(f.sent, [])
  f.controller.dispose()
})

test('middle mouse consumes only its own browser paste and keeps ordinary clipboard input', () => {
  const f = fixture(),
    middle = () => {
      f.event(f.document, 'pointerdown', 1)
      f.event(f.surface, 'pointerdown', 1)
      f.event(f.surface, 'mousedown', 1)
    }
  assert(!f.event(f.surface, 'paste'))
  middle()
  assert(f.event(f.surface, 'auxclick', 1))
  assert(f.event(f.surface, 'paste'))
  assert(!f.event(f.surface, 'paste'))
  for (const [target, type] of [
    [f.document, 'keydown'],
    [f.document, 'pointerdown'],
    [f.view, 'blur'],
    [f.document, 'visibilitychange'],
  ] as const) {
    middle()
    f.event(target, type, 0)
    assert(
      !f.event(f.surface, 'paste'),
      'a new pointer, keyboard or OS interaction permits an explicit paste',
    )
  }
  f.controller.dispose()
  assert(!f.event(f.surface, 'contextmenu'))
})

test('right reports preserve modifiers, scaled coordinates and outside releases without private xterm APIs', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 }
  const point = { clientX: 120, clientY: 70, shiftKey: true, altKey: true, ctrlKey: true }
  assert.equal(rightMouseInput(point, 'down', rect, 80, 20), '\x1b[<30;5;3M')
  assert.equal(rightMouseInput(point, 'drag', rect, 80, 20), '\x1b[<62;5;3M')
  assert.equal(
    rightMouseInput({ ...point, clientX: 1000, clientY: -30 }, 'up', rect, 80, 20),
    '\x1b[<30;80;1m',
  )
  assert.equal(rightMouseInput({ ...point, clientX: 99 }, 'down', rect, 80, 20), '')
  assert.equal(rightMouseInput(point, 'down', { ...rect, width: 0 }, 80, 20), '')
})

test('a rejected native press never attaches drag/release or emits an unmatched button-up', () => {
  const document = new EventTarget(),
    surface = Object.assign(new EventTarget(), { ownerDocument: document })
  const sent: RightMouseAction[] = []
  const controller = bindTerminalMouseDefaults(
    surface as unknown as HTMLElement,
    () => true,
    () => 'terminal',
    (_event, action) => {
      sent.push(action)
      return false
    },
  )
  const send = (target: EventTarget, type: string) => {
    const event = new Event(type, { cancelable: true })
    Object.assign(event, { button: 2, buttons: type === 'mouseup' ? 0 : 2 })
    target.dispatchEvent(event)
    return event.defaultPrevented
  }
  send(surface, 'pointerdown')
  assert(send(surface, 'mousedown'))
  assert(!send(document, 'mousemove'))
  assert(!send(document, 'mouseup'))
  assert(send(surface, 'contextmenu'))
  assert(!controller.allowsContextMenu())
  controller.dispose()
  assert.deepEqual(sent, ['down'])
})
