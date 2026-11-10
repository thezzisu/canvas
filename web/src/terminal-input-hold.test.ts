import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalInputHold } from './terminal-input-hold.ts'

test('writes pass through without a hold', () => {
  const input = new TerminalInputHold(), sent: string[] = []
  input.write(() => sent.push('a'))
  assert.equal(sent.join(''), 'a')
})

test('held writes follow in order once the last overlapping hold is released', () => {
  const input = new TerminalInputHold(), sent: string[] = []
  // A composer flush hold hands over to the delivery hold without a gap.
  const flush = input.hold()
  input.write(() => sent.push('a'))
  const delivery = input.hold()
  flush()
  input.write(() => sent.push('b'))
  assert.equal(sent.join(''), '')
  delivery()
  assert.equal(sent.join(''), 'ab')
  input.write(() => sent.push('c'))
  assert.equal(sent.join(''), 'abc')
})

test('a repeated release cannot end another hold', () => {
  const input = new TerminalInputHold(), sent: string[] = []
  const first = input.hold(), second = input.hold()
  first(); first()
  input.write(() => sent.push('a'))
  assert.equal(sent.join(''), '')
  second()
  assert.equal(sent.join(''), 'a')
})
