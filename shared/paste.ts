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

/** Render both the preview paths and the server's completed upload paths identically. */
export function renderPasteParts(parts: readonly PastePart[], paths: readonly string[]): string {
  return parts.map(part => {
    if (typeof part === "string") return part;
    const path = paths[part.file];
    if (path === undefined || path.includes("\0")) throw new Error("Invalid paste file reference");
    if (part.format === "path") return quotePath(path);
    const label = (part.label ?? "").replace(/[\r\n]+/gu, " ").replace(/[\\[\]*_`<>&]/gu, "\\$&");
    return `${part.image ? "!" : ""}[${label}](${markdownPath(path)})`;
  }).join("");
}
