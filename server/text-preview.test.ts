import { test } from "node:test";
import assert from "node:assert/strict";
import { readTextPreview, textPreviewLimit } from "../web/src/text-preview.ts";
import { locale } from "../web/src/i18n.ts";

test("text preview decodes split UTF-8 literally without interpreting markup", async t => {
  const content = new TextEncoder().encode("中文 <b>literal</b>\n");
  let index = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) {
      if (index < content.length) controller.enqueue(content.slice(index, ++index));
      else controller.close();
    },
  })));
  const result = await readTextPreview("/api/downloads/fixture?preview=1", content.length, new AbortController().signal);
  assert.deepEqual(result, { text: "中文 <b>literal</b>\n", truncated: false });
});

test("text preview cancels its response after a bounded prefix and drops an incomplete final codepoint", async t => {
  let cancelled = false;
  const prefix = new TextEncoder().encode("a".repeat(textPreviewLimit - 1) + "中" + "unread");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(prefix); },
    cancel() { cancelled = true; },
  })));
  const result = await readTextPreview("/api/downloads/fixture?preview=1", prefix.length, new AbortController().signal);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "a".repeat(textPreviewLimit - 1));
  assert.equal(cancelled, true, "preview does not continue downloading a large file");
});

test("text preview handles expired staged tickets without reading the error response as a file", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response('{"error":"Download expired"}', { status: 404 }));
  const previous = locale.value;
  t.after(() => { locale.value = previous; });
  for (const [language, message] of [["zh-CN", "文件已过期或不存在"], ["en", "File expired or not found"]] as const) {
    locale.value = language;
    await assert.rejects(readTextPreview("/api/downloads/fixture?preview=1", 0, new AbortController().signal), { message });
  }
});
