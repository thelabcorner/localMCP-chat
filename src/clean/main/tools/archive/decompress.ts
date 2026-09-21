import z from "node:zlib"
import { decode as bzip2Decode } from "seek-bzip"
import type { Compression } from "./format"

// In-process decompression for the pure backend. Node 22+ zlib covers
// gzip/brotli/zstd, seek-bzip covers bzip2.
export function decompress(compression: Compression, data: Uint8Array): Uint8Array {
  switch (compression) {
    case "gzip":
      return z.gunzipSync(Buffer.from(data))
    case "brotli":
      return z.brotliDecompressSync(Buffer.from(data))
    case "bzip2":
      return bzip2Decode(Buffer.from(data))
    case "zstd":
      return z.zstdDecompressSync(Buffer.from(data))
    default:
      throw new Error(`No in-process decompressor for ${compression} compression`)
  }
}

export function compress(compression: Compression, data: Uint8Array): Uint8Array {
  switch (compression) {
    case "gzip":
      return z.gzipSync(Buffer.from(data), { level: 6 })
    case "brotli":
      return z.brotliCompressSync(Buffer.from(data))
    case "zstd":
      return z.zstdCompressSync(Buffer.from(data))
    default:
      throw new Error(`No in-process compressor for ${compression} compression`)
  }
}


export * as ArchiveDecompress from "./decompress"

