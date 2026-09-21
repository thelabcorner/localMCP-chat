import { describe, expect, it } from 'vitest';
import { inspectPluginImageBytes, validatePluginImageBlock } from '../../../main/plugins/image-metadata.js';

function b64(bytes: Buffer): string { return bytes.toString('base64'); }

describe('plugin image metadata validation', () => {
  it('reads PNG dimensions without decoding image pixels', () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(640, 16);
    bytes.writeUInt32BE(480, 20);
    expect(inspectPluginImageBytes(bytes)).toEqual({ format: 'png', width: 640, height: 480 });
    expect(validatePluginImageBlock(b64(bytes), 'image/png')).toBeNull();
  });

  it('rejects a MIME/signature mismatch', () => {
    const bytes = Buffer.from('GIF89a\x20\x00\x10\x00', 'binary');
    expect(validatePluginImageBlock(b64(bytes), 'image/png')).toMatch(/MIME type/i);
  });

  it('rejects unsupported SVG instead of invoking an XML/native image decoder', () => {
    expect(validatePluginImageBlock(Buffer.from('<svg width="10" height="10"/>').toString('base64'), 'image/svg+xml'))
      .toMatch(/Only PNG, JPEG, GIF, WebP, and BMP/i);
  });

  it('rejects raster dimensions above the pixel ceiling', () => {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'ascii');
    bytes.writeUInt32BE(10_000, 16);
    bytes.writeUInt32BE(10_000, 20);
    expect(validatePluginImageBlock(b64(bytes), 'image/png')).toMatch(/36 megapixel/i);
  });
});
