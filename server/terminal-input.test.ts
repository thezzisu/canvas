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
