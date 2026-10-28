import sharp from "sharp";

export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
export const MAX_BACKGROUND_PIXELS = 16_000_000;
export const DEFAULT_BACKGROUND_OPACITY = 0.35;
const imageFormats = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

export class BackgroundError extends Error {
  constructor(
    message: string,
    public status: 400 | 413 | 415,
  ) {
    super(message);
  }
}

export function backgroundContentType(value: string | undefined): string {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!imageFormats.has(type))
    throw new BackgroundError("Choose a PNG, JPEG or WebP image", 415);
  return type;
}

// Read the actual stream under a hard cap, even when Content-Length is absent
// or inaccurate. Do this only after authentication and origin validation.
export async function readBackground(request: Request): Promise<Buffer> {
  const length = Number(request.headers.get("content-length"));
  if (length > MAX_BACKGROUND_BYTES)
    throw new BackgroundError("Background image must be 8 MiB or smaller", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new BackgroundError("Choose an image", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BACKGROUND_BYTES) {
        await reader.cancel();
        throw new BackgroundError(
          "Background image must be 8 MiB or smaller",
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new BackgroundError("Choose an image", 400);
  return Buffer.concat(chunks, size);
}

export async function normalizeBackground(
  input: Buffer,
  contentType: string,
): Promise<Buffer> {
  const expectedFormat = imageFormats.get(backgroundContentType(contentType));
  if (input.length > MAX_BACKGROUND_BYTES)
    throw new BackgroundError("Background image must be 8 MiB or smaller", 413);
  try {
    const pipeline = sharp(input, {
      limitInputPixels: MAX_BACKGROUND_PIXELS,
      failOn: "warning",
      sequentialRead: true,
    }).timeout({ seconds: 10 });
    const metadata = await pipeline.metadata();
    if (metadata.format !== expectedFormat)
      throw new BackgroundError(
        "Image contents do not match the file type",
        400,
      );
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_BACKGROUND_PIXELS
    )
      throw new BackgroundError(
        "Background image must be 16 megapixels or smaller",
        400,
      );
    if ((metadata.pages ?? 1) > 1)
      throw new BackgroundError("Choose a still image", 400);
    // Re-encoding rejects malformed pixel data and removes embedded metadata.
    return await pipeline.rotate().webp({ quality: 86 }).toBuffer();
  } catch (error) {
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError(
      "Invalid image, or image exceeds 16 megapixels",
      400,
    );
  }
}
