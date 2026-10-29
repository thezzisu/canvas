import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalKey, modifiedText } from "../web/src/terminal-input.ts";

test("soft terminal keys respect normal and application cursor modes", () => {
  assert.equal(terminalKey("ArrowUp"), "\x1b[A");
  assert.equal(terminalKey("ArrowLeft", {}, true), "\x1bOD");
  assert.equal(terminalKey("Home", {}, true), "\x1bOH");
  assert.equal(terminalKey("End"), "\x1b[F");
  assert.equal(terminalKey("ArrowDown", { ctrl: true }, true), "\x1b[1;5B");
  assert.equal(terminalKey("ArrowRight", { ctrl: true, alt: true }), "\x1b[1;7C");
  assert.equal(terminalKey("PageDown", { alt: true }), "\x1b[6;3~");
  assert.equal(terminalKey("Delete"), "\x1b[3~");
  assert.equal(terminalKey("F1"), "\x1bOP");
  assert.equal(terminalKey("F12", { ctrl: true }), "\x1b[24;5~");
});

test("soft modifiers generate terminal chords rather than browser shortcuts", () => {
  assert.equal(terminalKey("c", { ctrl: true }), "\x03");
  assert.equal(terminalKey("d", { ctrl: true }), "\x04");
  assert.equal(terminalKey("z", { ctrl: true }), "\x1a");
  assert.equal(terminalKey("[", { ctrl: true }), "\x1b");
  assert.equal(terminalKey(" ", { ctrl: true }), "\x00");
  assert.equal(terminalKey("?", { ctrl: true }), "\x7f");
  assert.equal(terminalKey("b", { alt: true }), "\x1bb");
  assert.equal(terminalKey("Tab"), "\t");
  assert.equal(terminalKey("Escape"), "\x1b");
  assert.equal(terminalKey("Enter"), "\r");
  assert.equal(terminalKey("BackTab"), "\x1b[Z");
});

test("IME and pasted text are never rewritten as control chords", () => {
  for (const text of ["中文", "😀", "echo safe\n", "\x1b[200~clipboard\x1b[201~", "\r"]) {
    assert.equal(modifiedText(text, { ctrl: true, alt: true }), text);
  }
  assert.equal(modifiedText("v", { ctrl: false, alt: false }), "v");
  assert.equal(terminalKey("UnsupportedKey", { ctrl: true }), "");
});

test("all modifier combinations retain their independent bits on special keys", () => {
  for (let mask = 0; mask < 16; mask++) {
    const modifiers = { shift: !!(mask & 1), alt: !!(mask & 2), ctrl: !!(mask & 4), meta: !!(mask & 8) };
    assert.equal(terminalKey("ArrowLeft", modifiers, true), mask ? `\x1b[1;${mask + 1}D` : "\x1bOD");
    assert.equal(terminalKey("Delete", modifiers), `\x1b[3${mask ? `;${mask + 1}` : ""}~`);
    assert.equal(terminalKey("F4", modifiers), mask ? `\x1b[1;${mask + 1}S` : "\x1bOS");
  }
  assert.equal(terminalKey("ArrowLeft", { shift: true }), "\x1b[1;2D");
  assert.equal(terminalKey("ArrowLeft", { shift: true, ctrl: true }), "\x1b[1;6D");
  assert.equal(terminalKey("Home", { meta: true }), "\x1b[1;9H");
});

test("virtual Shift and Caps affect letters and symbols before terminal control encoding", () => {
  assert.equal(terminalKey("a", { shift: true }), "A");
  assert.equal(terminalKey("A", { shift: true }), "a");
  assert.equal(terminalKey("/", { shift: true }), "?");
  assert.equal(terminalKey("[", { shift: true }), "{");
  assert.equal(terminalKey("c", { shift: true, ctrl: true }), "\x03");
  assert.equal(terminalKey("-", { shift: true, ctrl: true }), "\x1f");
  assert.equal(terminalKey("[", { shift: true, ctrl: true }), "\x1b");
  assert.equal(terminalKey("\\", { shift: true, ctrl: true }), "\x1c");
  assert.equal(terminalKey("]", { shift: true, ctrl: true }), "\x1d");
  assert.equal(terminalKey("/", { shift: true, ctrl: true }), "\x7f");
  assert.equal(terminalKey("b", { alt: true, meta: true, shift: true }), "\x1bB");
  assert.equal(terminalKey("b", { meta: true }), "\x1bb");
});

test("basic keys keep traditional terminal semantics rather than inventing an extended protocol", () => {
  assert.equal(terminalKey("Tab", { shift: true }), "\x1b[Z");
  assert.equal(terminalKey("Tab", { shift: true, ctrl: true, alt: true, meta: true }), "\x1b[Z");
  assert.equal(terminalKey("Tab", { ctrl: true }), "\t");
  assert.equal(terminalKey("Enter", { shift: true }), "\r");
  assert.equal(terminalKey("Backspace", { shift: true }), "\x7f");
  assert.equal(terminalKey("Backspace", { ctrl: true, alt: true }), "\x1b\b");
  assert.equal(terminalKey("Escape", { meta: true }), "\x1b\x1b");
  for (const text of ["中文", "😀", "echo ok\n", "\x1b[0n"]) {
    assert.equal(modifiedText(text, { shift: true, ctrl: true, alt: true, meta: true }), text);
  }
});
