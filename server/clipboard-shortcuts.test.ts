import { test } from "node:test";
import assert from "node:assert/strict";
import { isPasteShortcut, type ClipboardShortcutEvent } from "../web/src/clipboard-shortcuts.ts";

test("browser paste includes OS-injected shortcuts without a physical key code", () => {
  for (const type of ["keydown", "keypress", "keyup"]) {
    for (const fields of [
      { code: "KeyV", key: "v", keyCode: 86 },
      { code: "", key: "v", keyCode: 86 },
      { code: "Unidentified", key: "V", keyCode: 86 },
      { code: "", key: "Unidentified", keyCode: 86 },
      { which: 86 },
    ]) {
      assert.equal(isPasteShortcut({ ...fields, type, ctrlKey: true }), true, JSON.stringify({ fields, type }));
      assert.equal(isPasteShortcut({ ...fields, type, metaKey: true }), true);
    }
  }
  assert.equal(isPasteShortcut({ type: "keypress", charCode: 118, ctrlKey: true }), true);
  assert.equal(isPasteShortcut({ type: "keypress", which: 118, ctrlKey: true }), true);
  assert.equal(isPasteShortcut({ type: "keypress", keyCode: 118, ctrlKey: true }), true);
  assert.equal(isPasteShortcut({ type: "keydown", keyCode: 118, ctrlKey: true }), false, "F7 is not a paste shortcut");
});

test("native paste alternatives keep their modifier semantics", () => {
  assert.equal(isPasteShortcut({ code: "KeyV", ctrlKey: true, shiftKey: true }), true);
  for (const insert of [{ code: "Insert" }, { key: "Insert" }, { keyCode: 45 }, { which: 45 }]) {
    assert.equal(isPasteShortcut({ ...insert, shiftKey: true }), true);
    assert.equal(isPasteShortcut(insert), false);
    assert.equal(isPasteShortcut({ ...insert, ctrlKey: true }), false, "Ctrl+Insert is copy");
    assert.equal(isPasteShortcut({ ...insert, shiftKey: true, ctrlKey: true }), false);
    assert.equal(isPasteShortcut({ ...insert, shiftKey: true, metaKey: true }), false);
  }
});

test("ordinary input, composition and AltGr never become browser paste", () => {
  const rejected: ClipboardShortcutEvent[] = [
    { code: "KeyV", key: "v" },
    { key: "v" },
    { code: "KeyC", key: "c", keyCode: 86, ctrlKey: true },
    { code: "F7", key: "F7", keyCode: 118, ctrlKey: true },
    { code: "KeyV", ctrlKey: true, altKey: true },
    { code: "KeyV", ctrlKey: true, isComposing: true },
    { code: "KeyV", ctrlKey: true, keyCode: 229 },
    { code: "KeyV", ctrlKey: true, key: "Process" },
    { code: "KeyV", ctrlKey: true, key: "Dead" },
    { code: "KeyV", ctrlKey: true, getModifierState: modifier => modifier === "AltGraph" },
    { key: "\x16" },
  ];
  for (const event of rejected) assert.equal(isPasteShortcut(event), false, JSON.stringify(event));
});
