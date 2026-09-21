export type TarEntryType = "file" | "dir" | "hardlink" | "symlink" | "other"

export type TarEntry = {
  name: string
  dir: boolean
  unsafe: boolean
  size: number
  mtime: number
  mode: number
  type: TarEntryType
  linkTo?: string
  dataOffset: number
}

export type TarSource = {
  name: string
  data: Uint8Array
  mtime?: number
  mode?: number
  type?: "file" | "dir"
}

// Parse a tar stream (ustar / GNU / PAX). Reads headers sequentially, so the
// caller can provide the whole decompressed buffer or a large file slice.
export function readTar(buf: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let pos = 0
  let pendingName: string | undefined
  let pendingLink: string | undefined
  let pax: Pax = {}

  while (pos + 512 <= buf.length) {
    const block = buf.subarray(pos, pos + 512)
    if (allZero(block)) break
    if (!isUstar(block)) break

    const typeflag = block[156] === 0 ? 0x30 : block[156]
    const size = parseNumber(block, 124, 12)
    const mtime = parseNumber(block, 136, 12)
    const mode = parseNumber(block, 100, 8)
    const rawName = joinName(field(block, 0, 100), field(block, 345, 155))
    const rawLink = field(block, 157, 100)
    const next = pos + 512 + blockSize(size)

    if (typeflag === 0x4c) {
      // 'L' GNU long name
      pendingName = decodeEntryName(buf.subarray(pos + 512, pos + 512 + size))
      pos = next
      continue
    }
    if (typeflag === 0x4b) {
      // 'K' GNU long link target
      pendingLink = decodeEntryName(buf.subarray(pos + 512, pos + 512 + size))
      pos = next
      continue
    }
    if (typeflag === 0x78 || typeflag === 0x67) {
      // 'x' extended (next-entry) / 'g' global PAX records
      const records = paxRecords(buf.subarray(pos + 512, pos + 512 + size))
      if (typeflag === 0x67) pax = { ...pax, ...records }
      else pax = { ...pax, ...records }
      pos = next
      continue
    }

    const name = pendingName ?? pax.path ?? rawName
    const linkTo = pendingLink ?? pax.linkpath ?? (rawLink !== "" ? rawLink : undefined)
    const finalSize = pax.size !== undefined ? pax.size : size
    const finalMtime = pax.mtime !== undefined ? pax.mtime : mtime
    const finalMode = pax.mode !== undefined ? pax.mode : mode

    const { name: clean, dir, unsafe } = normalizeName(name)
    const type: TarEntryType =
      typeflag === 0x31 ? "hardlink"
      : typeflag === 0x32 ? "symlink"
      : typeflag === 0x35 || typeflag === 0x44 ? "dir"
      : typeflag === 0x30 || typeflag === 0 ? "file"
      : "other"

    entries.push({
      name: clean,
      dir: dir || type === "dir",
      unsafe,
      size: finalSize,
      mtime: finalMtime,
      mode: finalMode,
      type,
      linkTo,
      dataOffset: pos + 512,
    })

    pendingName = undefined
    pendingLink = undefined
    pax = {}
    pos = next
  }
  return entries
}

export function entryData(buf: Uint8Array, entry: TarEntry): Uint8Array {
  const end = Math.min(entry.dataOffset + entry.size, buf.length)
  return buf.subarray(entry.dataOffset, end)
}

// Create a tar stream in memory (ustar format). Entry names must be short
// enough to split into ustar name + prefix.
export function createTar(files: TarSource[]): Uint8Array {
  const now = Math.floor(Date.now() / 1000)
  const chunks: Uint8Array[] = []
  for (const file of files) {
    const dir = file.type === "dir"
    const size = dir ? 0 : file.data.length
    const header = tarHeader(file.name, size, file.mtime ?? now, file.mode ?? 0o644, dir)
    chunks.push(header, file.data)
    const padding = blockSize(size) - size
    if (padding > 0) chunks.push(new Uint8Array(padding))
  }
  chunks.push(new Uint8Array(1024))
  return concat(chunks)
}

function tarHeader(name: string, size: number, mtime: number, mode: number, dir: boolean): Uint8Array {
  const header = new Uint8Array(512)
  const { name: shortName, prefix } = splitName(name)
  writeField(header, 0, shortName)
  writeOctal(header, 100, 8, dir ? (mode & 0o7777) | 0o40000 : mode & 0o7777)
  writeOctal(header, 108, 8, 0) // uid
  writeOctal(header, 116, 8, 0) // gid
  writeOctal(header, 124, 12, size)
  writeOctal(header, 136, 12, mtime)
  writeField(header, 156, dir ? "5" : "0")
  writeField(header, 257, "ustar")
  writeField(header, 263, "00")
  if (prefix) writeField(header, 345, prefix)

  // Header checksum: computed with the field treated as 8 spaces, stored as
  // 6 octal digits + NUL + space per the ustar spec.
  const sum = header.reduce((total, byte) => total + byte, 0) + 8 * 32
  const digits = sum.toString(8).padStart(6, "0")
  for (let i = 0; i < 6; i++) header[148 + i] = digits.charCodeAt(i)
  header[154] = 0
  header[155] = 0x20
  return header
}

function splitName(name: string): { name: string; prefix: string } {
  if (name.length <= 100) return { name, prefix: "" }
  const parts = name.split("/")
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/")
    const rest = parts.slice(i).join("/")
    if (prefix.length <= 155 && rest.length <= 100) return { name: rest, prefix }
  }
  throw new Error(`tar entry name is too long to store: ${name}`)
}

function writeField(buf: Uint8Array, offset: number, text: string) {
  const bytes = new TextEncoder().encode(text)
  for (let i = 0; i < bytes.length && offset + i < buf.length; i++) buf[offset + i] = bytes[i]!
}

// Numeric fields are `len - 1` octal digits, zero-padded, NUL-terminated.
// Leading NUL bytes (rather than '0' chars) break strict readers like
// Python's tarfile, so the field must be filled with zero digits.
function writeOctal(buf: Uint8Array, offset: number, len: number, value: number) {
  const digits = value.toString(8).padStart(len - 1, "0").slice(-(len - 1))
  for (let i = 0; i < digits.length; i++) buf[offset + i] = digits.charCodeAt(i)
}

function isUstar(block: Uint8Array): boolean {
  return (
    block[257] === 0x75 && block[258] === 0x73 && block[259] === 0x74 && block[260] === 0x61 && block[261] === 0x72
  )
}

function field(block: Uint8Array, offset: number, len: number): string {
  let end = offset
  while (end < offset + len && block[end] !== 0) end++
  return new TextDecoder().decode(block.subarray(offset, end))
}

function joinName(name: string, prefix: string): string {
  return prefix ? `${prefix}/${name}` : name
}

function parseNumber(block: Uint8Array, offset: number, len: number): number {
  const first = block[offset] ?? 0
  if (first & 0x80) {
    let value = first & 0x7f
    for (let i = offset + 1; i < offset + len; i++) value = value * 256 + (block[i] ?? 0)
    if (first & 0x40) value -= 1 << (8 * len - 1)
    return value
  }
  let text = ""
  for (let i = offset; i < offset + len; i++) {
    const byte = block[i] ?? 0
    if (byte === 0 || byte === 0x20) continue
    text += String.fromCharCode(byte)
  }
  if (!text) return 0
  const parsed = parseInt(text, 8)
  return Number.isNaN(parsed) ? 0 : parsed
}

function decodeEntryName(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/, "")
}

type Pax = { path?: string; linkpath?: string; size?: number; mtime?: number; mode?: number }

function paxRecords(bytes: Uint8Array): Pax {
  const out: Pax = {}
  const text = new TextDecoder().decode(bytes)
  let pos = 0
  while (pos < text.length) {
    const space = text.indexOf(" ", pos)
    if (space === -1) break
    const len = Number.parseInt(text.slice(pos, space), 10)
    if (Number.isNaN(len) || len <= 0) break
    const record = text.slice(space + 1, Math.min(pos + len - 1, text.length))
    const eq = record.indexOf("=")
    if (eq !== -1) {
      const key = record.slice(0, eq)
      const value = record.slice(eq + 1)
      if (key === "path") out.path = value
      else if (key === "linkpath") out.linkpath = value
      else if (key === "size") out.size = Number(value)
      else if (key === "mtime") out.mtime = Number(value)
      else if (key === "mode") out.mode = Number.parseInt(value, 8)
    }
    pos = space + 1 + record.length + 1
  }
  return out
}

function blockSize(size: number): number {
  return Math.ceil(size / 512) * 512
}

function allZero(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function normalizeName(raw: string): { name: string; dir: boolean; unsafe: boolean } {
  const normalized = raw.replace(/\\/g, "/")
  const dir = normalized.endsWith("/")
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".")
  let unsafe = normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)
  for (const segment of segments) {
    if (segment === "..") unsafe = true
  }
  return { name: segments.join("/"), dir, unsafe }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  return out
}


export * as TarFile from "./tarfile"

