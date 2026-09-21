import path from "path"

export type Compression = "none" | "gzip" | "bzip2" | "xz" | "zstd" | "brotli" | "lz4" | "lzma"

export type ArchiveFormat =
  | { kind: "zip" }
  | { kind: "tar"; compression: "none" }
  // Outer compression whose decompressed payload may itself be a tar.
  | { kind: "compressed"; compression: Exclude<Compression, "none">; container: "tar" | "single" }
  | { kind: "7z" }
  | { kind: "rar" }
  | { kind: "unknown" }

// Single-file codecs handled in-process (node zlib / Bun zstd / seek-bzip).
export const PURE_COMPRESSIONS: ReadonlySet<string> = new Set(["gzip", "bzip2", "zstd", "brotli"])
// Codecs only handled through a system tool (7-Zip or tar).
export const SYSTEM_COMPRESSIONS: ReadonlySet<string> = new Set(["xz", "lz4", "lzma"])

export function formatName(format: ArchiveFormat): string {
  if (format.kind === "tar") return "tar"
  if (format.kind === "compressed") return format.compression
  if (format.kind === "zip") return "ZIP"
  if (format.kind === "7z") return "7-Zip"
  if (format.kind === "rar") return "RAR"
  return "unknown"
}

const COMPRESSION_EXT: Record<string, Exclude<Compression, "none">> = {
  ".gz": "gzip",
  ".bz2": "bzip2",
  ".xz": "xz",
  ".zst": "zstd",
  ".br": "brotli",
  ".lz4": "lz4",
  ".lzma": "lzma",
}

// Suffixes that imply the decompressed payload is a tar (`.tar.gz`, `.tgz`, …).
const TAR_SUFFIXES: Record<string, Compression> = {
  ".tar": "none",
  ".tar.gz": "gzip",
  ".tgz": "gzip",
  ".tar.bz2": "bzip2",
  ".tbz2": "bzip2",
  ".tar.xz": "xz",
  ".txz": "xz",
  ".tar.zst": "zstd",
  ".tzst": "zstd",
  ".tar.lz4": "lz4",
  ".tar.lzma": "lzma",
}

function detectMagic(bytes: Uint8Array): ArchiveFormat | undefined {
  const b = bytes
  const has = (hex: number[], at = 0) => hex.every((byte, i) => b[at + i] === byte)

  if (has([0x50, 0x4b, 0x03, 0x04]) || has([0x50, 0x4b, 0x05, 0x06]) || has([0x50, 0x4b, 0x07, 0x08])) {
    return { kind: "zip" }
  }
  if (has([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: "7z" }
  if (has([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { kind: "rar" }
  if (has([0x1f, 0x8b])) return { kind: "compressed", compression: "gzip", container: "single" }
  if (has([0x42, 0x5a, 0x68])) return { kind: "compressed", compression: "bzip2", container: "single" }
  if (has([0x28, 0xb5, 0x2f, 0xfd])) return { kind: "compressed", compression: "zstd", container: "single" }
  if (has([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return { kind: "compressed", compression: "xz", container: "single" }
  if (has([0x04, 0x22, 0x4d, 0x18])) return { kind: "compressed", compression: "lz4", container: "single" }
  if (has([0x5d, 0x00, 0x00, 0x00])) return { kind: "compressed", compression: "lzma", container: "single" }

  // Plain tar: "ustar" at offset 257 in the first header.
  if (b.length > 262 && b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72) {
    return { kind: "tar", compression: "none" }
  }
  return undefined
}

function extensionFormat(name: string): ArchiveFormat | undefined {
  const base = path.basename(name).toLowerCase()
  for (const [suffix, compression] of Object.entries(TAR_SUFFIXES)) {
    if (base.endsWith(suffix)) {
      return compression === "none"
        ? { kind: "tar", compression: "none" }
        : { kind: "compressed", compression, container: "tar" }
    }
  }
  for (const [suffix, compression] of Object.entries(COMPRESSION_EXT)) {
    if (base.endsWith(suffix)) return { kind: "compressed", compression, container: "single" }
  }
  if (base.endsWith(".zip")) return { kind: "zip" }
  if (base.endsWith(".7z")) return { kind: "7z" }
  if (base.endsWith(".rar")) return { kind: "rar" }
  return undefined
}

// Detect the container from the leading bytes, falling back to the extension
// when the magic is absent or ambiguous (e.g. `.br` has no magic).
export function detect(bytes: Uint8Array, name: string): ArchiveFormat {
  const byMagic = detectMagic(bytes)
  if (byMagic) return refineByExt(byMagic, name)
  return extensionFormat(name) ?? { kind: "unknown" }
}

// Magic bytes cannot tell a `.tar.xz` from a plain `.xz`, so when the filename
// names a tar-compression suffix, assume the payload is a tar. This matters for
// formats the system backend handles without decompressing first.
function refineByExt(format: ArchiveFormat, name: string): ArchiveFormat {
  if (format.kind !== "compressed" || format.container !== "single") return format
  const base = path.basename(name).toLowerCase()
  for (const suffix of [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz4", ".tar.lzma", ".tgz", ".tbz2", ".txz", ".tzst"]) {
    if (base.endsWith(suffix)) return { ...format, container: "tar" }
  }
  return format
}

// Refine a compressed stream once its decompressed bytes are known: a `.gz`
// that holds a tar becomes a tar archive rather than a single file.
export function withTarContainer(
  format: ArchiveFormat & { kind: "compressed" },
  decompressed: Uint8Array,
): ArchiveFormat & { kind: "compressed" } {
  return { ...format, container: isTarBytes(decompressed) ? "tar" : "single" }
}

export function isTarBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && bytes[257] === 0x75 && bytes[258] === 0x73 && bytes[259] === 0x74 && bytes[260] === 0x61 && bytes[261] === 0x72
}

// Human-readable size, e.g. 123456 -> "121 KB".
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const rounded =
    value >= 100 ? Math.round(value) : value >= 10 ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100
  return `${rounded} ${units[unit]}`
}

// The format an archive will be created as, inferred from its destination name.
export function createFormatForExt(name: string): ArchiveFormat | undefined {
  const base = path.basename(name).toLowerCase()
  if (base.endsWith(".zip")) return { kind: "zip" }
  if (base.endsWith(".7z")) return { kind: "7z" }
  for (const [suffix, compression] of Object.entries(TAR_SUFFIXES)) {
    if (base.endsWith(suffix)) {
      return compression === "none"
        ? { kind: "tar", compression: "none" }
        : { kind: "compressed", compression, container: "tar" }
    }
  }
  for (const [suffix, compression] of Object.entries(COMPRESSION_EXT)) {
    if (base.endsWith(suffix)) return { kind: "compressed", compression, container: "single" }
  }
  return undefined
}

// Default extraction directory for an archive path: `data.zip` -> `data`,
// `src.tar.gz` -> `src`, placed next to the archive.
export function defaultDestination(archivePath: string): string {
  const base = path.basename(archivePath)
  const lower = base.toLowerCase()
  for (const suffix of Object.keys(TAR_SUFFIXES)) {
    if (lower.endsWith(suffix)) return path.join(path.dirname(archivePath), base.slice(0, -suffix.length))
  }
  for (const suffix of [".zip", ".7z", ".rar"]) {
    if (lower.endsWith(suffix)) return path.join(path.dirname(archivePath), base.slice(0, -suffix.length))
  }
  const ext = path.extname(base)
  return path.join(path.dirname(archivePath), ext ? base.slice(0, -ext.length) : `${base}-extracted`)
}


export * as ArchiveFormat from "./format"

