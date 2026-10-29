export const DEFAULT_BACKGROUND_OPACITY = 0.35;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class BackgroundError extends Error {
  constructor(message: string, public status: 400 | 415) { super(message); }
}

export function backgroundContentType(value: string | undefined): string {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!imageTypes.has(type)) throw new BackgroundError("Choose a PNG, JPEG or WebP image", 415);
  return type;
}

// Authentication and origin validation precede this read. Photos have no
// application-imposed byte/pixel limit; ordinary JSON requests keep their cap.
export async function readBackground(request: Request): Promise<Buffer> {
  const image = Buffer.from(await request.arrayBuffer());
  if (!image.length) throw new BackgroundError("Choose an image", 400);
  return image;
}

export function storedBackgroundContentType(bytes: Uint8Array): string {
  const image = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (image.subarray(0, 8).equals(pngSignature)) return "image/png";
  if (image.length >= 3 && image[0] === 255 && image[1] === 216 && image[2] === 255) return "image/jpeg";
  if (image.length >= 12 && image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new BackgroundError("Choose a PNG, JPEG or WebP image", 400);
}

/** The browser decodes the image. The server preserves its original bytes. */
export function validateBackground(image: Buffer, contentType: string): void {
  if (storedBackgroundContentType(image) !== backgroundContentType(contentType))
    throw new BackgroundError("Image contents do not match the file type", 400);
}
