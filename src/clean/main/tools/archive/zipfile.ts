import fs from "node:fs/promises"
import z from "node:zlib"
import { decode as bzip2Decode } from "seek-bzip"

const EOCD = 0x06054b50
const ZIP64_EOCD = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const ZIP64_ID = 0x0001

export type ZipEntry = {
  name: string
  dir: boolean
  unsafe: boolean
  size: number
  compSize: number
  method: number
  crc: number
  offset: number
  flags: number
  date: Date
}

export class ZipUnsupportedError extends Error {
  constructor(method: number, name: string) {
    super(`ZIP entry "${name}" uses unsupported compression method ${method}`)
  }
}

export type Reader = {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export function bufferReader(buf: Uint8Array): Reader {
  return {
    size: buf.length,
    read: (offset, length) =>
      Promise.resolve(buf.subarray(offset, Math.min(offset + length, buf.length))),
  }
}

export async function fileReader(file: string): Promise<Reader & { close(): Promise<void> }> {
  const handle = await fs.open(file, "r")
  const stat = await handle.stat()
  return {
    size: stat.size,
    read: (offset, length) => readAt(handle, offset, length),
    close: () => handle.close(),
  }
}

async function readAt(handle: fs.FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length)
  let pos = offset
  let total = 0
  while (total < length) {
    const { bytesRead } = await handle.read(buf, total, length - total, pos)
    if (bytesRead === 0) break
    total += bytesRead
    pos += bytesRead
  }
  return buf.subarray(0, total)
}

// Parse the central directory of a ZIP archive. Only metadata is read, so this
// works on arbitrarily large archives without decompressing anything.
export async function readZip(reader: Reader): Promise<ZipEntry[]> {
  const size = reader.size
  if (size < 22) return []
  const tailLen = Math.min(size, 22 + 0xffff)
  const tail = await reader.read(size - tailLen, tailLen)

  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error("Not a ZIP archive (missing end-of-central-directory record)")

  const eocdAbs = size - tailLen + eocd
  let numEntries = u16(tail, eocd + 10)
  let cdSize = u32(tail, eocd + 12)
  let cdOffset = u32(tail, eocd + 16)

  if (numEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = await reader.read(eocdAbs - 20, 20)
    if (locator.length === 20 && u32(locator, 0) === ZIP64_LOCATOR) {
      const record = await reader.read(Number(u64(locator, 8)), 56)
      if (u32(record, 0) === ZIP64_EOCD) {
        numEntries = Number(u64(record, 32))
        cdSize = Number(u64(record, 40))
        cdOffset = Number(u64(record, 48))
      }
    }
  }

  const cd = await reader.read(cdOffset, cdSize)
  const entries: ZipEntry[] = []
  let pos = 0
  while (pos + 46 <= cd.length) {
    if (u32(cd, pos) !== CENTRAL) break
    const flags = u16(cd, pos + 8)
    const method = u16(cd, pos + 10)
    let compSize = u32(cd, pos + 20)
    let uncompSize = u32(cd, pos + 24)
    const nameLen = u16(cd, pos + 28)
    const extraLen = u16(cd, pos + 30)
    const commentLen = u16(cd, pos + 32)
    let localOffset = u32(cd, pos + 42)
    const nameBytes = cd.subarray(pos + 46, pos + 46 + nameLen)
    const extra = cd.subarray(pos + 46 + nameLen, pos + 46 + nameLen + extraLen)

    const zip64 = zip64Fields(extra, uncompSize === 0xffffffff, compSize === 0xffffffff, localOffset === 0xffffffff)
    if (uncompSize === 0xffffffff) uncompSize = zip64[0] ?? uncompSize
    if (compSize === 0xffffffff) compSize = zip64[1] ?? compSize
    if (localOffset === 0xffffffff) localOffset = zip64[2] ?? localOffset

    const { name, dir, unsafe } = normalizeEntryName(decodeName(nameBytes, flags))
    entries.push({
      name,
      dir,
      unsafe,
      size: uncompSize,
      compSize,
      method,
      crc: u32(cd, pos + 16),
      offset: localOffset,
      flags,
      date: dosToDate(u16(cd, pos + 12), u16(cd, pos + 14)),
    })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

// Extract a single entry. Inflates in memory, so callers should bound the
// uncompressed size before reading giant entries.
export async function readZipEntry(reader: Reader, entry: ZipEntry): Promise<Uint8Array> {
  const local = await reader.read(entry.offset, 30)
  if (local.length < 30 || u32(local, 0) !== LOCAL) {
    throw new Error(`Corrupt ZIP archive: bad local header for "${entry.name}"`)
  }
  const nameLen = u16(local, 26)
  const extraLen = u16(local, 28)
  const dataStart = entry.offset + 30 + nameLen + extraLen
  const comp = await reader.read(dataStart, entry.compSize)

  let data: Uint8Array
  switch (entry.method) {
    case 0:
      data = comp
      break
    case 8:
      data = z.inflateRawSync(Buffer.from(comp))
      break
    case 12:
      data = bzip2Decode(Buffer.from(comp))
      break
    case 93:
      data = z.zstdDecompressSync(Buffer.from(comp))
      break
    default:
      throw new ZipUnsupportedError(entry.method, entry.name)
  }
  if ((z.crc32(Buffer.from(data)) >>> 0) !== (entry.crc >>> 0)) {
    throw new Error(`Corrupt ZIP archive: CRC mismatch for "${entry.name}"`)
  }
  return data
}

export type ZipSource = {
  name: string
  data: Uint8Array
  date: Date
  dir?: boolean
}

function encodeEntry(file: ZipSource) {
  const dir = file.dir || file.name.endsWith("/")
  const crc = z.crc32(Buffer.from(file.data)) >>> 0
  const deflated = z.deflateRawSync(Buffer.from(file.data), { level: 6 })
  const useStore = dir || deflated.length >= file.data.length
  const method = useStore ? 0 : 8
  const payload = useStore ? file.data : deflated
  const { time, date } = dateToDos(file.date)
  const nameBytes = new TextEncoder().encode(dir && !file.name.endsWith("/") ? file.name + "/" : file.name)
  const flags = 0x0800
  const version = useStore ? 10 : 20

  const local = new Uint8Array(30)
  w32(local, 0, LOCAL)
  w16(local, 4, version)
  w16(local, 6, flags)
  w16(local, 8, method)
  w16(local, 10, time)
  w16(local, 12, date)
  w32(local, 14, crc)
  w32(local, 18, payload.length)
  w32(local, 22, file.data.length)
  w16(local, 26, nameBytes.length)
  w16(local, 28, 0)

  return { local, nameBytes, payload, crc, method, time, date, version, uncompSize: file.data.length }
}

function centralFor(
  offset: number,
  entry: { nameBytes: Uint8Array; payload: Uint8Array; crc: number; method: number; time: number; date: number; version: number; uncompSize: number },
) {
  const { nameBytes, payload, crc, method, time, date, version, uncompSize } = entry
  const header = new Uint8Array(46)
  w32(header, 0, CENTRAL)
  w16(header, 4, 0x031e)
  w16(header, 6, version)
  w16(header, 8, 0x0800)
  w16(header, 10, method)
  w16(header, 12, time)
  w16(header, 14, date)
  w32(header, 16, crc)
  w32(header, 20, payload.length)
  w32(header, 24, uncompSize)
  w16(header, 28, nameBytes.length)
  w16(header, 30, 0)
  w16(header, 32, 0)
  w16(header, 34, 0)
  w16(header, 36, 0)
  w32(header, 38, 0)
  w32(header, 42, offset)
  return concat([header, nameBytes])
}

function eocd(entries: number, cdSize: number, cdOffset: number) {
  const out = new Uint8Array(22)
  w32(out, 0, EOCD)
  w16(out, 8, entries)
  w16(out, 10, entries)
  w32(out, 12, cdSize)
  w32(out, 16, cdOffset)
  return out
}

export type Writer = {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
}

function handleWriter(dest: string): Writer {
  let handle: fs.FileHandle | undefined
  return {
    write: async (bytes) => {
      handle ??= await fs.open(dest, "w")
      await handle.write(bytes)
    },
    close: async () => {
      await handle?.close()
    },
  }
}

function memoryWriter(): Writer & { bytes(): Uint8Array } {
  const chunks: Uint8Array[] = []
  let total = 0
  return {
    write: (bytes) => {
      chunks.push(bytes)
      total += bytes.length
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
    bytes: () => {
      const out = new Uint8Array(total)
      let pos = 0
      for (const chunk of chunks) {
        out.set(chunk, pos)
        pos += chunk.length
      }
      return out
    },
  }
}

async function writeZipEntries(writer: Writer, files: ZipSource[]) {
  let offset = 0
  const central: Uint8Array[] = []
  for (const file of files) {
    const entry = encodeEntry(file)
    await writer.write(entry.local)
    await writer.write(entry.nameBytes)
    await writer.write(entry.payload)
    central.push(centralFor(offset, entry))
    offset += 30 + entry.nameBytes.length + entry.payload.length
  }
  const cd = concat(central)
  await writer.write(cd)
  await writer.write(eocd(files.length, cd.length, offset))
  return { count: files.length, bytes: offset }
}

export async function writeZip(dest: string, files: ZipSource[]) {
  const writer = handleWriter(dest)
  try {
    return await writeZipEntries(writer, files)
  } finally {
    await writer.close()
  }
}

export async function zipToBuffer(files: ZipSource[]): Promise<Uint8Array> {
  const writer = memoryWriter()
  await writeZipEntries(writer, files)
  return writer.bytes()
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.length
  }
  return out
}

function normalizeEntryName(raw: string): { name: string; dir: boolean; unsafe: boolean } {
  const normalized = raw.replace(/\\/g, "/")
  const dir = normalized.endsWith("/")
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".")
  let unsafe = normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)
  for (const segment of segments) {
    if (segment === "..") unsafe = true
  }
  return { name: segments.join("/"), dir, unsafe }
}

function decodeName(bytes: Uint8Array, flags: number): string {
  const utf8 = flags & 0x0800
  if (utf8) return new TextDecoder().decode(bytes)
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
  if (!decoded.includes("\uFFFD")) return decoded
  return new TextDecoder("latin1").decode(bytes)
}

export function dosToDate(time: number, date: number): Date {
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  )
}

function dateToDos(d: Date) {
  const year = Math.max(d.getFullYear(), 1980)
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

function zip64Fields(extra: Uint8Array, wantUncomp: boolean, wantComp: boolean, wantOffset: boolean): (number | undefined)[] {
  const out: (number | undefined)[] = []
  let pos = 0
  while (pos + 4 <= extra.length) {
    const id = u16(extra, pos)
    const len = u16(extra, pos + 2)
    const data = extra.subarray(pos + 4, pos + 4 + len)
    if (id === ZIP64_ID) {
      let p = 0
      if (wantUncomp) {
        out.push(p + 8 <= data.length ? Number(u64(data, p)) : undefined)
        p += 8
      }
      if (wantComp) {
        out.push(p + 8 <= data.length ? Number(u64(data, p)) : undefined)
        p += 8
      }
      if (wantOffset) {
        out.push(p + 8 <= data.length ? Number(u64(data, p)) : undefined)
      }
    }
    pos += 4 + len
  }
  return out
}

function u16(buf: Uint8Array, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8)
}

function u32(buf: Uint8Array, offset: number): number {
  return (u16(buf, offset) | (u16(buf, offset + 2) << 16)) >>> 0
}

function u64(buf: Uint8Array, offset: number): bigint {
  return BigInt(u32(buf, offset)) | (BigInt(u32(buf, offset + 4)) << 32n)
}

function w16(buf: Uint8Array, offset: number, value: number) {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
}

function w32(buf: Uint8Array, offset: number, value: number) {
  w16(buf, offset, value & 0xffff)
  w16(buf, offset + 2, (value >>> 16) & 0xffff)
}


export * as ZipFile from "./zipfile"

