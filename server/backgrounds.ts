import sharp from "sharp";

export const DEFAULT_BACKGROUND_OPACITY = 0.35;
const imageFormats = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpeg"],
  ["image/webp", "webp"],
]);

export class BackgroundError extends Error {
  constructor(
    message: string,
    public status: 400 | 415,
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

// Read only after authentication and origin validation. Photo uploads have no
// application-imposed byte limit; ordinary JSON requests retain their own cap.
export async function readBackground(request: Request): Promise<Buffer> {
  const image = Buffer.from(await request.arrayBuffer());
  if (!image.length) throw new BackgroundError("Choose an image", 400);
  return image;
}

export function storedBackgroundContentType(image: Uint8Array): string {
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  return pngSignature.every((byte, index) => image[index] === byte)
    ? "image/png"
    : "image/webp";
}

export async function normalizeBackground(
  input: Buffer,
  contentType: string,
): Promise<Buffer> {
  const expectedFormat = imageFormats.get(backgroundContentType(contentType));
  try {
    const pipeline = sharp(input, {
      limitInputPixels: false,
      failOn: "warning",
      sequentialRead: true,
    });
    const metadata = await pipeline.metadata();
    if (metadata.format !== expectedFormat)
      throw new BackgroundError(
        "Image contents do not match the file type",
        400,
      );
    if (!metadata.width || !metadata.height)
      throw new BackgroundError("Invalid image dimensions", 400);
    if ((metadata.pages ?? 1) > 1)
      throw new BackgroundError("Choose a still image", 400);
    // Re-encoding rejects malformed pixel data and removes embedded metadata.
    pipeline.rotate();
    // WebP cannot encode an axis above 16383 pixels. Keep wide panoramas at
    // their original resolution by storing PNG instead of rejecting/resizing.
    return await (
      metadata.width > 16383 || metadata.height > 16383
        ? pipeline.png()
        : pipeline.webp({ quality: 86 })
    ).toBuffer();
  } catch (error) {
    if (error instanceof BackgroundError) throw error;
    throw new BackgroundError("Unable to decode or process this image", 400);
  }
}
