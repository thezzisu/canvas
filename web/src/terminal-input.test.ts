import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalKey, terminalShortcut, modifiedText } from "./terminal-input.ts";

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

test("modified Enter preserves its semantic modifiers for the native client", () => {
  for (let mask = 0; mask < 16; mask++) {
    const modifiers = { shift: !!(mask & 1), alt: !!(mask & 2), ctrl: !!(mask & 4), meta: !!(mask & 8) };
    assert.equal(terminalKey("Enter", modifiers), !mask ? "\r" : mask === 2 ? "\x1b\r" : `\x1b[13;${mask + 1}u`);
  }
});

test("other basic keys keep traditional terminal semantics", () => {
  assert.equal(terminalKey("Tab", { shift: true }), "\x1b[Z");
  assert.equal(terminalKey("Tab", { shift: true, ctrl: true, alt: true, meta: true }), "\x1b[Z");
  assert.equal(terminalKey("Tab", { ctrl: true }), "\t");
  assert.equal(terminalKey("Backspace", { shift: true }), "\x7f");
  assert.equal(terminalKey("Backspace", { ctrl: true, alt: true }), "\x1b\b");
  assert.equal(terminalKey("Escape", { meta: true }), "\x1b\x1b");
  for (const text of ["中文", "😀", "echo ok\n", "\x1b[0n"]) {
    assert.equal(modifiedText(text, { shift: true, ctrl: true, alt: true, meta: true }), text);
  }
});

test("physical browser chords preserve Tab, Meta and control-key distinctions", () => {
  assert.equal(terminalShortcut({ key: "t", ctrlKey: true }), "\x1b[116;5u");
  assert.equal(terminalShortcut({ key: "w", ctrlKey: true }), "\x1b[119;5u");
  assert.equal(terminalShortcut({ key: "Tab", ctrlKey: true }), "\x1b[9;5u");
  assert.equal(terminalShortcut({ key: "Tab", ctrlKey: true, shiftKey: true }), "\x1b[9;6u");
  assert.equal(terminalShortcut({ key: "Tab", shiftKey: true }), "\x1b[Z");
  assert.equal(terminalShortcut({ key: "x", metaKey: true }), "\x1b[120;9u");
  assert.equal(terminalShortcut({ key: "x", altKey: true }), "\x1b[120;3u");
  assert.equal(terminalShortcut({ key: "Enter", shiftKey: true }), "\x1b[13;2u");
  assert.equal(terminalShortcut({ key: "Backspace", ctrlKey: true }), "\x1b[127;5u");
  assert.equal(terminalShortcut({ key: "Escape", metaKey: true }), "\x1b[27;9u");
});

test("physical chords use the produced layout glyph without applying Shift or Caps twice", () => {
  const azerty = { key: "a", code: "KeyQ", ctrlKey: true };
  const qwertz = { key: "z", code: "KeyY", metaKey: true };
  assert.equal(terminalShortcut(azerty), "\x1b[97;5u");
  assert.equal(terminalShortcut(qwertz), "\x1b[122;9u");
  assert.equal(terminalShortcut({ key: "A", shiftKey: true, ctrlKey: true }), "\x1b[65;6u");
  assert.equal(terminalShortcut({ key: "A", ctrlKey: true }), "\x1b[65;5u");
  assert.equal(terminalShortcut({ key: "a", shiftKey: true, ctrlKey: true }), "\x1b[97;6u");
  assert.equal(terminalShortcut({ key: "$", shiftKey: true, ctrlKey: true }), "\x1b[36;6u");
  assert.equal(terminalShortcut({ key: "é", ctrlKey: true }), "\x1b[233;5u");
  assert.equal(terminalShortcut({ key: "😀", metaKey: true }), "\x1b[128512;9u");
});

test("virtual Shift is additional to the DOM glyph and never reapplies physical Shift", () => {
  assert.equal(terminalShortcut({ key: "a", ctrlKey: true }, { shift: true }), "\x1b[65;6u");
  assert.equal(terminalShortcut({ key: "A", ctrlKey: true }, { shift: true }), "\x1b[97;6u");
  assert.equal(terminalShortcut({ key: "A", shiftKey: true, ctrlKey: true }, { shift: true }), "\x1b[65;6u");
  assert.equal(terminalShortcut({ key: "4" }, { shift: true }), "\x1b[36;2u");
  assert.equal(terminalShortcut({ key: "$", shiftKey: true }, { shift: true }), "\x1b[36;2u");
  assert.equal(terminalShortcut({ key: "ArrowLeft", ctrlKey: true }, { shift: true, meta: true }), "\x1b[1;14D");
});

test("plain typing remains in xterm while physical function keys reach the terminal", () => {
  for (const event of [{ key: "a" }, { key: "A", shiftKey: true }, { key: "$", shiftKey: true }, { key: "中" }, { key: "😀" },
    { key: "Tab" }, { key: "Enter" }, { key: "ArrowLeft" }, { key: "Backspace" }]) {
    assert.equal(terminalShortcut(event), "", event.key);
  }
  assert.equal(terminalShortcut({ key: "F1" }), "\x1bOP");
  assert.equal(terminalShortcut({ key: "F12" }), "\x1b[24~");
  assert.equal(terminalShortcut({ key: "ArrowLeft", altKey: true }, {}, true), "\x1b[1;3D");
  assert.equal(terminalShortcut({ key: "Unidentified", ctrlKey: true }), "");
  assert.equal(terminalShortcut({ key: "Shift", shiftKey: true }), "");
});

test("physical shortcut capture yields to composition, AltGraph and native third-level input", () => {
  for (const event of [
    { key: "Enter", ctrlKey: true, isComposing: true },
    { key: "Enter", shiftKey: true, keyCode: 229 },
    { key: "Process", ctrlKey: true }, { key: "Dead", altKey: true }, { key: "AltGraph", ctrlKey: true },
    { key: "@", ctrlKey: true, altKey: true, getModifierState: (name: string) => name === "AltGraph" },
  ]) assert.equal(terminalShortcut(event, { meta: true }), "", event.key);
  assert.equal(terminalShortcut({ key: "@", ctrlKey: true, altKey: true }, {}, false, "Win32"), "");
  assert.equal(terminalShortcut({ key: "é", altKey: true }, {}, false, "MacIntel"), "");
  assert.equal(terminalShortcut({ key: "ArrowLeft", ctrlKey: true, altKey: true }, {}, false, "Win32"), "\x1b[1;7D");
  assert.equal(terminalShortcut({ key: "ArrowLeft", altKey: true }, {}, false, "MacIntel"), "\x1b[1;3D");
  assert.equal(terminalShortcut({ key: "x", ctrlKey: true, altKey: true }, {}, false, "MacIntel"), "\x1b[120;7u");
  assert.equal(terminalShortcut({ key: "@", ctrlKey: true, altKey: true, metaKey: true }, {}, false, "Win32"), "\x1b[64;15u");
});

test("Mac select-all stays local while other Command chords retain terminal semantics", () => {
  assert.equal(terminalShortcut({ key: "a", metaKey: true }, {}, false, "MacIntel"), "");
  assert.equal(terminalShortcut({ key: "A", metaKey: true }, {}, false, "MacIntel"), "");
  assert.equal(terminalShortcut({ key: "a", metaKey: true, ctrlKey: true }, {}, false, "MacIntel"), "\x1b[97;13u");
  assert.equal(terminalShortcut({ key: "A", metaKey: true, shiftKey: true }, {}, false, "MacIntel"), "\x1b[65;10u");
  assert.equal(terminalShortcut({ key: "a", metaKey: true, altKey: true }, {}, false, "MacIntel"), "\x1b[97;11u");
  assert.equal(terminalShortcut({ key: "w", metaKey: true }, {}, false, "MacIntel"), "\x1b[119;9u");
  assert.equal(terminalShortcut({ key: "a", metaKey: true }, {}, false, "Linux"), "\x1b[97;9u");
});
