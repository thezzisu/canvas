import type { WebSocket } from "ws";
import { z } from "zod";
import { noteContentPaste } from "../shared/paste.ts";
import type { AssetStore } from "./assets.ts";
import type { Source, Store } from "./state.ts";
import type { UploadService } from "./uploads.ts";

const sendSchema = z.object({ id: z.string().min(1).max(100), composer: z.string().uuid(), version: z.number().int().nonnegative() }).strict();

/** Send exactly the draft version the sender saw; files stream from Canvas storage, never through the browser. */
export async function sendComposer(store: Store, assets: AssetStore, uploads: UploadService,
  source: Source, windowId: string, socket: WebSocket, session: string, input: unknown) {
  const parsed = sendSchema.safeParse(input);
  const raw = input && typeof input === "object" && "id" in input && typeof input.id === "string" ? input.id.slice(0, 100) : "";
  const id = parsed.success ? parsed.data.id : raw;
  const fail = (error: string) => {
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: "upload-progress", id, state: "failed", transferred: 0, total: 0, error }));
  };
  if (!parsed.success) { fail("invalidRequest"); return; }
  const target = { sourceId: source.id, windowId }, composer = store.composer(target);
  if (!composer || composer.id !== parsed.data.composer || composer.version !== parsed.data.version) { fail("draftChanged"); return; }
  const { files, parts } = noteContentPaste(composer.content);
  if (!parts.some(part => typeof part !== "string" || part.trim())) { fail("draftEmpty"); return; }
  const owned = new Map(store.noteAttachments(composer.id).map(asset => [asset.id, asset]));
  const stored = [];
  for (const assetId of files) {
    const asset = owned.get(assetId);
    if (!asset) { fail("fileMissing"); return; }
    stored.push({ name: asset.filename, size: asset.size, open: async () => (await assets.read(asset.id))?.body });
  }
  await uploads.sendStored(source, windowId, socket, session, { id, files: stored, parts,
    delivered: () => {
      // Delivery already happened; a newer draft or storage failure only leaves the draft in place.
      try { store.completeComposerSend(target, composer.version, files); }
      catch (error) { console.error("Composer delivered but could not be cleared", error); }
    } });
}
