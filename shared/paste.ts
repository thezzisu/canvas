export type PastePart = string | {
  file: number;
  format: "path" | "markdown";
  label?: string;
  image?: boolean;
};

// Keep the complete begin message comfortably below the 128 KiB socket limit.
export const MAX_UPLOAD_BEGIN_BYTES = 120 * 1024;
export const MAX_PASTE_PARTS = 2048;
export const MAX_TERMINAL_PASTE_BYTES = 1024 * 1024;

function quotePath(path: string): string {
  if (path.includes("\0")) throw new Error("Invalid paste path");
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function markdownPath(path: string): string {
  return path.replace(/[%\s"'<>\\[\]?#&()`]/gu, character =>
    encodeURIComponent(character).replace(/[!'()*]/gu, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`));
}

export interface PasteSegment { text: string; file: boolean }

/** Keep each file occurrence a separate terminal paste event. */
export function renderPasteSegments(parts: readonly PastePart[], paths: readonly string[]): PasteSegment[] {
  return parts.map(part => {
    if (typeof part === "string") return { text: part, file: false };
    const path = paths[part.file];
    if (path === undefined || path.includes("\0")) throw new Error("Invalid paste file reference");
    if (part.format === "path") return { text: quotePath(path), file: true };
    const label = (part.label ?? "").replace(/[\r\n]+/gu, " ").replace(/[\\[\]*_`<>&]/gu, "\\$&");
    return { text: `${part.image ? "!" : ""}[${label}](${markdownPath(path)})`, file: true };
  }).filter(segment => segment.text.length > 0);
}

/** Uploaded files without surrounding text are separated like a native multi-file drop. */
export function filePasteParts(count: number): PastePart[] {
  return Array.from({ length: count }, (_, file): PastePart[] => file ? [" ", { file, format: "path" }] : [{ file, format: "path" }]).flat();
}

/** Preview text and delivered segments concatenate to exactly the same content. */
export function renderPasteParts(parts: readonly PastePart[], paths: readonly string[]): string {
  return renderPasteSegments(parts, paths).map(segment => segment.text).join("");
}
