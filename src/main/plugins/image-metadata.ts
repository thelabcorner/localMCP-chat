const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_PLUGIN_IMAGE_PIXELS = 36_000_000;

export interface PluginImageMetadata {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp';
  width: number;
  height: number;
}

const MIME_BY_FORMAT: Record<PluginImageMetadata['format'], string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp'
};

function png(bytes: Buffer): PluginImageMetadata | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) return null;
  return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gif(bytes: Buffer): PluginImageMetadata | null {
  if (bytes.length < 10) return null;
  const signature = bytes.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return { format: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function jpeg(bytes: Buffer): PluginImageMetadata | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes.readUInt8(offset++);
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (JPEG_SOF.has(marker)) {
      if (length < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return { format: 'jpeg', width, height };
    }
    offset += length;
  }
  return null;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes.readUIntLE(offset, 3);
}

function webp(bytes: Buffer): PluginImageMetadata | null {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return { format: 'webp', width: readUInt24LE(bytes, 24) + 1, height: readUInt24LE(bytes, 27) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return {
      format: 'webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff
    };
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes.readUInt32LE(21);
    return { format: 'webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

function bmp(bytes: Buffer): PluginImageMetadata | null {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 2) !== 'BM') return null;
  const dibSize = bytes.readUInt32LE(14);
  if (dibSize < 40) return null;
  const width = bytes.readInt32LE(18);
  const height = Math.abs(bytes.readInt32LE(22));
  if (width <= 0) return null;
  return { format: 'bmp', width, height };
}

export function inspectPluginImageBytes(bytes: Buffer): PluginImageMetadata | null {
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes) ?? bmp(bytes);
}

function decodedBase64UpperBound(value: string): number {
  return Math.ceil(value.length / 4) * 3;
}

/**
 * Validates plugin image blocks without invoking a native image decoder in the privileged main
 * process. Common raster formats expose dimensions in bounded headers; unsupported formats are
 * rejected instead of being decoded merely to discover metadata.
 */
export function validatePluginImageBlock(data: string, mimeType: string): string | null {
  if (typeof data !== 'string' || typeof mimeType !== 'string') return 'PLUGIN_IMAGE_INVALID: Image data and MIME type must be strings.';
  if (data.length === 0 || data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    return 'PLUGIN_IMAGE_INVALID: Image data is not valid base64.';
  if (decodedBase64UpperBound(data) > MAX_IMAGE_BYTES)
    return 'PLUGIN_IMAGE_TOO_LARGE: Encoded image exceeds the 12 MiB decoded-byte limit.';

  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES)
    return 'PLUGIN_IMAGE_TOO_LARGE: Image exceeds the 12 MiB decoded-byte limit.';
  const info = inspectPluginImageBytes(bytes);
  if (!info) return 'PLUGIN_IMAGE_UNSUPPORTED: Only PNG, JPEG, GIF, WebP, and BMP plugin images are accepted.';
  if (info.width <= 0 || info.height <= 0 || info.width > MAX_PLUGIN_IMAGE_PIXELS || info.height > MAX_PLUGIN_IMAGE_PIXELS || info.width * info.height > MAX_PLUGIN_IMAGE_PIXELS)
    return 'PLUGIN_IMAGE_TOO_LARGE: Image exceeds the 36 megapixel limit.';
  if (mimeType.toLowerCase() !== MIME_BY_FORMAT[info.format])
    return 'PLUGIN_IMAGE_INVALID: Image MIME type does not match its file signature.';
  return null;
}
