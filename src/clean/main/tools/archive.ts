import path from 'node:path';
import fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { Root } from '../../../shared/types.js';
import { ok, resolveToolPath } from './common.js';
import * as ArchiveFormat from './archive/format.js';
import { ZipFile } from './archive/zipfile.js';
import { TarFile } from './archive/tarfile.js';
import { ArchiveDecompress } from './archive/decompress.js';
import * as ArchiveSystem from './archive/system.js';

function globMatch(pattern: string, name: string): boolean {
  const source = pattern.replace(/\\/g, '/');
  let regex = '^';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === '*') {
      if (source[i + 1] === '*') { regex += '.*'; i++; }
      else regex += '[^/]*';
    } else if (ch === '?') regex += '[^/]';
    else regex += /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`${regex}$`, 'i').test(name.replace(/\\/g, '/'));
}

const DEFAULT_LIST_ENTRIES = 200
const MAX_READ_BYTES = 50 * 1024
const MAX_READ_ENTRY = 64 * 1024 * 1024
const MAX_TAR_DECOMPRESSED = 1024 * 1024 * 1024
const MAX_SINGLE_DECOMPRESSED = 512 * 1024 * 1024
const MAX_EXTRACT_ENTRY = 512 * 1024 * 1024
const MAX_EXTRACT_ENTRIES = 100_000
const MAX_EXTRACT_TOTAL = 20 * 1024 * 1024 * 1024
const MAX_CREATE_FILE = 512 * 1024 * 1024
const MAX_CREATE_TOTAL = 4 * 1024 * 1024 * 1024
const COMPRESSION_EXTS = [".gz", ".bz2", ".xz", ".zst", ".br", ".lz4", ".lzma"]

type DisplayEntry = {
  name: string
  dir: boolean
  unsafe: boolean
  size: number
  stored?: number
  date?: Date
  linkTo?: string
}

function isSystemFormat(format: ArchiveFormat.ArchiveFormat): boolean {
  if (format.kind === "7z" || format.kind === "rar") return true
  return format.kind === "compressed" && ArchiveFormat.SYSTEM_COMPRESSIONS.has(format.compression)
}

function formatLabel(format: ArchiveFormat.ArchiveFormat): string {
  const base = ArchiveFormat.formatName(format)
  if (format.kind === "compressed" && format.container === "tar") return `${base} (tar)`
  return base
}

async function detectArchive(filepath: string): Promise<ArchiveFormat.ArchiveFormat> {
  const handle = await fs.open(filepath, "r")
  try {
    const buf = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return ArchiveFormat.detect(new Uint8Array(buf.subarray(0, bytesRead)), filepath)
  } finally {
    await handle.close()
  }
}

async function readWhole(filepath: string, cap: number): Promise<Uint8Array> {
  const stat = await fs.stat(filepath)
  if (stat.size > cap) {
    throw new Error(
      `Archive is too large to process in-process (${ArchiveFormat.humanSize(stat.size)}). Use the bash tool with the system 'tar'/'7z' command, or install 7-Zip to enable the archive tool's system fallback.`,
    )
  }
  return new Uint8Array(await fs.readFile(filepath))
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Aborted by user")
}

// All pure-format listings share one shape so list/extract/read dispatch stays small.
async function resolveEntries(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
): Promise<{ format: ArchiveFormat.ArchiveFormat; entries: DisplayEntry[] }> {
  if (format.kind === "zip") {
    const reader = await ZipFile.fileReader(filepath)
    try {
      const entries = await ZipFile.readZip(reader)
      return {
        format,
        entries: entries.map((e) => ({
          name: e.name,
          dir: e.dir,
          unsafe: e.unsafe,
          size: e.size,
          stored: e.compSize,
          date: e.date,
        })),
      }
    } finally {
      await reader.close()
    }
  }

  if (format.kind === "tar") {
    const bytes = await readWhole(filepath, MAX_TAR_DECOMPRESSED)
    const entries = TarFile.readTar(bytes)
    return { format, entries: entries.map(toDisplay) }
  }

  if (format.kind === "compressed" && ArchiveFormat.PURE_COMPRESSIONS.has(format.compression)) {
    const compressed = await readWhole(filepath, MAX_SINGLE_DECOMPRESSED)
    const decompressed = ArchiveDecompress.decompress(format.compression, compressed)
    const resolved = ArchiveFormat.withTarContainer(format, decompressed)
    if (resolved.container === "tar") {
      const entries = TarFile.readTar(decompressed)
      return { format: resolved, entries: entries.map(toDisplay) }
    }
    return {
      format: resolved,
      entries: [{ name: stripCompressionExt(filepath), dir: false, unsafe: false, size: decompressed.length }],
    }
  }

  // Unreachable for callers that check isSystemFormat first.
  throw new Error(`Format ${ArchiveFormat.formatName(format)} requires a system tool`)
}

function toDisplay(e: TarFile.TarEntry): DisplayEntry {
  return {
    name: e.name,
    dir: e.dir,
    unsafe: e.unsafe,
    size: e.size,
    date: new Date(e.mtime * 1000),
    linkTo: e.linkTo,
  }
}

function stripCompressionExt(filepath: string): string {
  const base = path.basename(filepath)
  const lower = base.toLowerCase()
  for (const ext of COMPRESSION_EXTS) {
    if (lower.endsWith(ext)) return base.slice(0, -ext.length)
  }
  return base.replace(/\.[^.]+$/, "")
}

function entryMatches(pattern: string, name: string): boolean {
  return name === pattern || name.startsWith(pattern + "/") || globMatch(pattern, name)
}

function filterEntries(entries: DisplayEntry[], patterns: readonly string[]): DisplayEntry[] {
  if (!patterns.length) return entries
  return entries.filter((e) => patterns.some((pattern) => entryMatches(pattern, e.name)))
}

function sortEntries(entries: DisplayEntry[]): DisplayEntry[] {
  return entries.toSorted((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function renderList(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
  entries: DisplayEntry[],
  filtered: boolean,
  offset: number,
  limit: number,
): string {
  const total = entries.reduce((sum, e) => sum + e.size, 0)
  const lines = [
    `<archive>${filepath}</archive>`,
    `<format>${formatLabel(format)}</format>`,
    `<entries>${entries.length}</entries>`,
    `<uncompressed>${ArchiveFormat.humanSize(total)}</uncompressed>`,
    "",
  ]

  const shown = entries.slice(offset, offset + limit)
  for (const entry of shown) {
    const marker = entry.unsafe ? "[!]" : entry.dir ? "[D]" : "   "
    const size =
      entry.stored !== undefined
        ? `${ArchiveFormat.humanSize(entry.size)} (${ArchiveFormat.humanSize(entry.stored)} stored)`
        : ArchiveFormat.humanSize(entry.size)
    lines.push(
      `  ${marker} ${entry.name}${entry.dir ? "/" : ""}${entry.unsafe ? " — unsafe path, will not extract" : ` — ${size}`}`,
    )
  }
  if (offset > 0 || offset + shown.length < entries.length) {
    lines.push("")
    const next = offset + shown.length < entries.length ? offset + shown.length : null
    lines.push(`(Showing entries ${shown.length ? offset + 1 : offset}-${offset + shown.length} of ${entries.length}.${next === null ? "" : ` Continue with offset=${next + 1}.`})`)
  } else if (filtered) {
    lines.push(`(Matches ${entries.length} entries. Use a broader entries filter to see more.)`)
  }
  if (entries.length > 0) {
    lines.push("")
    lines.push(`Use the read action with entry="<path>" to view a file inside without extracting.`)
  }
  return lines.join("\n")
}

async function extractPure(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
  dest: string,
  selection: DisplayEntry[],
  overwrite: boolean,
  signal: AbortSignal,
): Promise<{
  extracted: number
  dirs: number
  skipped: number
  links: number
  blocked: number
  errors: string[]
  totalBytes: number
}> {
  const result = { extracted: 0, dirs: 0, skipped: 0, links: 0, blocked: 0, errors: [] as string[], totalBytes: 0 }

  if (selection.length > MAX_EXTRACT_ENTRIES) {
    throw new Error(
      `Too many entries to extract (${selection.length} > ${MAX_EXTRACT_ENTRIES}). Use the entries filter to narrow the selection.`,
    )
  }
  const totalSize = selection.reduce((sum, e) => sum + e.size, 0)
  if (totalSize > MAX_EXTRACT_TOTAL) {
    throw new Error(
      `Extraction would expand to ${ArchiveFormat.humanSize(totalSize)}, over the ${ArchiveFormat.humanSize(MAX_EXTRACT_TOTAL)} safety cap. Use the entries filter or extract in parts.`,
    )
  }

  if (format.kind === "zip") {
    const reader = await ZipFile.fileReader(filepath)
    try {
      const all = new Map((await ZipFile.readZip(reader)).map((e) => [e.name, e]))
      for (const entry of selection) {
        checkAbort(signal)
        if (entry.unsafe) {
          result.blocked++
          continue
        }
        const zipEntry = all.get(entry.name)
        if (!zipEntry) {
          result.errors.push(`entry vanished: ${entry.name}`)
          continue
        }
        if (entry.dir) {
          await mkdirSafe(dest, entry.name)
          result.dirs++
          continue
        }
        if (zipEntry.size > MAX_EXTRACT_ENTRY) {
          result.errors.push(
            `${entry.name}: over ${ArchiveFormat.humanSize(MAX_EXTRACT_ENTRY)} in-process limit; extract with the bash tool instead`,
          )
          continue
        }
        if (zipEntry.flags & 0x0001) {
          result.errors.push(`${entry.name}: encrypted entries are not supported`)
          continue
        }
        const target = await safeJoin(dest, entry.name)
        if (await exists(target)) {
          if (!overwrite) {
            result.skipped++
            continue
          }
          const st = await fs.lstat(target)
          if (st.isDirectory()) {
            result.skipped++
            continue
          }
        }
        const data = await ZipFile.readZipEntry(reader, zipEntry)
        await writeOut(target, data, zipEntry.date)
        result.extracted++
        result.totalBytes += data.length
      }
    } finally {
      await reader.close()
    }
    return result
  }

  // tar containers (tar, tar.gz, tar.bz2, tar.zst, ...)
  let tarBytes: Uint8Array
  if (format.kind === "tar") {
    tarBytes = await readWhole(filepath, MAX_TAR_DECOMPRESSED)
  } else if (format.kind === "compressed") {
    const compressed = await readWhole(filepath, MAX_SINGLE_DECOMPRESSED)
    tarBytes = ArchiveDecompress.decompress(format.compression, compressed)
    if (format.container !== "tar") {
      // single-file compressed blob: write the decompressed content to `dest`.
      if (selection.length !== 1) {
        throw new Error(`Expected exactly one output file, got ${selection.length}`)
      }
      const data = tarBytes
      if (data.length > MAX_EXTRACT_ENTRY)
        throw new Error(`Decompressed size ${ArchiveFormat.humanSize(data.length)} exceeds the in-process limit`)
      const target = dest
      if (!(await exists(target)) || overwrite) {
        await writeOut(target, data, new Date())
        result.extracted++
        result.totalBytes += data.length
      } else {
        result.skipped++
      }
      return result
    }
  } else {
    throw new Error(`Cannot extract ${formatLabel(format)} archives in-process`)
  }
  const all = new Map(TarFile.readTar(tarBytes).map((e) => [e.name, e]))
  for (const entry of selection) {
    checkAbort(signal)
    if (entry.unsafe) {
      result.blocked++
      continue
    }
    if (entry.dir) {
      await mkdirSafe(dest, entry.name)
      result.dirs++
      continue
    }
    if (entry.linkTo !== undefined) {
      // Symlinks are skipped for safety; internal hardlinks materialize the
      // target file's content so relative links still resolve.
      const targetName = entry.linkTo.replace(/\\/g, "/")
      const src = all.get(targetName)
      if (src && src.type === "file") {
        const data = TarFile.entryData(tarBytes, src)
        const target = await safeJoin(dest, entry.name)
        if (!(await exists(target)) || overwrite) {
          await writeOut(target, data, new Date(entry.date ? entry.date.getTime() : Date.now()))
          result.extracted++
          result.totalBytes += data.length
        } else {
          result.skipped++
        }
        continue
      }
      result.links++
      continue
    }
    const tarEntry = all.get(entry.name)
    if (!tarEntry) {
      result.errors.push(`entry vanished: ${entry.name}`)
      continue
    }
    if (tarEntry.size > MAX_EXTRACT_ENTRY) {
      result.errors.push(
        `${entry.name}: over ${ArchiveFormat.humanSize(MAX_EXTRACT_ENTRY)} in-process limit; extract with the bash tool instead`,
      )
      continue
    }
    const target = await safeJoin(dest, entry.name)
    if (await exists(target)) {
      if (!overwrite) {
        result.skipped++
        continue
      }
      const st = await fs.lstat(target)
      if (st.isDirectory()) {
        result.skipped++
        continue
      }
    }
    const data = TarFile.entryData(tarBytes, tarEntry)
    await writeOut(target, data, new Date(tarEntry.mtime * 1000))
    result.extracted++
    result.totalBytes += data.length
  }
  return result
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function mkdirSafe(dest: string, name: string) {
  await fs.mkdir(path.join(dest, name), { recursive: true })
}

// Resolve an entry name under dest, refusing path traversal and writes that
// would pass through a pre-existing symlink.
async function safeJoin(dest: string, name: string): Promise<string> {
  const target = path.resolve(dest, name)
  if (target !== dest && !target.startsWith(dest + path.sep)) {
    throw new Error(`Refusing to write outside extraction root: ${name}`)
  }
  const rel = path.relative(dest, path.dirname(target))
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside extraction root: ${name}`)
  }
  let cursor = dest
  for (const part of rel === "" ? [] : rel.split(path.sep)) {
    cursor = path.join(cursor, part)
    try {
      const st = await fs.lstat(cursor)
      if (st.isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${cursor}`)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue
      throw error
    }
  }
  return target
}

async function writeOut(target: string, data: Uint8Array, date: Date) {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, data)
  await fs.utimes(target, date, date).catch(() => undefined)
}

function renderExtract(dest: string, result: Awaited<ReturnType<typeof extractPure>>): string {
  const lines = [
    `Extracted ${result.extracted} files and ${result.dirs} directories (${ArchiveFormat.humanSize(result.totalBytes)}) to ${dest}`,
  ]
  if (result.skipped) lines.push(`${result.skipped} existing entries skipped (use overwrite=true to replace them)`)
  if (result.links) lines.push(`${result.links} symlinks skipped for safety`)
  if (result.blocked) lines.push(`${result.blocked} unsafe paths (traversal/absolute) skipped`)
  if (result.errors.length) {
    lines.push(`${result.errors.length} entries could not be extracted:`)
    lines.push(...result.errors.slice(0, 5).map((e) => `  - ${e}`))
  }
  if (
    result.errors.length === 0 &&
    result.extracted === 0 &&
    result.skipped === 0 &&
    result.blocked === 0 &&
    result.links === 0
  ) {
    lines.push("Nothing matched. Check the entries filter against the archive's listing.")
  }
  return lines.join("\n")
}

async function readEntryData(
  filepath: string,
  format: ArchiveFormat.ArchiveFormat,
  pattern: string,
): Promise<{ name: string; data: Uint8Array; size: number }> {
  if (format.kind === "zip") {
    const reader = await ZipFile.fileReader(filepath)
    try {
      const entry = await findZipEntry(reader, pattern)
      if (entry.dir) throw new Error(`"${pattern}" is a directory`)
      if (entry.size > MAX_READ_ENTRY) {
        throw new Error(
          `Entry is ${ArchiveFormat.humanSize(entry.size)}; too large to read in-process. Extract it instead.`,
        )
      }
      if (entry.flags & 0x0001) throw new Error(`"${entry.name}" is encrypted and cannot be read`)
      const data = await ZipFile.readZipEntry(reader, entry)
      return { name: entry.name, data, size: entry.size }
    } finally {
      await reader.close()
    }
  }

  if (format.kind === "tar") {
    const tarBytes = await readWhole(filepath, MAX_TAR_DECOMPRESSED)
    return tarEntryRead(tarBytes, pattern)
  }

  if (format.kind === "compressed") {
    const compressed = await readWhole(filepath, MAX_SINGLE_DECOMPRESSED)
    const data = ArchiveDecompress.decompress(format.compression, compressed)
    if (ArchiveFormat.isTarBytes(data)) {
      return tarEntryRead(data, pattern)
    }
    if (data.length > MAX_READ_ENTRY) {
      throw new Error(
        `Decompressed size ${ArchiveFormat.humanSize(data.length)} is too large to read in-process. Extract it instead.`,
      )
    }
    return { name: stripCompressionExt(filepath), data, size: data.length }
  }

  throw new Error(`Reading from ${formatLabel(format)} archives requires a system tool`)
}

async function tarEntryRead(tarBytes: Uint8Array, pattern: string) {
  const entry = findTarEntry(TarFile.readTar(tarBytes), pattern)
  if (entry.dir) throw new Error(`"${pattern}" is a directory`)
  if (entry.size > MAX_READ_ENTRY) {
    throw new Error(
      `Entry is ${ArchiveFormat.humanSize(entry.size)}; too large to read in-process. Extract it instead.`,
    )
  }
  return { name: entry.name, data: TarFile.entryData(tarBytes, entry), size: entry.size }
}

async function findZipEntry(reader: ZipFile.Reader, pattern: string): Promise<ZipFile.ZipEntry> {
  const entries = await ZipFile.readZip(reader)
  const exact = entries.find((e) => e.name === pattern)
  if (exact) return exact
  const matches = entries.filter((e) => globMatch(pattern, e.name))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(
      `"${pattern}" matches ${matches.length} entries; be more specific:\n${matches
        .slice(0, 10)
        .map((e) => "  " + e.name)
        .join("\n")}`,
    )
  }
  return missingEntry(
    pattern,
    entries.map((e) => e.name),
  )
}

function findTarEntry(entries: TarFile.TarEntry[], pattern: string): TarFile.TarEntry {
  const exact = entries.find((e) => e.name === pattern)
  if (exact) return exact
  const matches = entries.filter((e) => globMatch(pattern, e.name))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(
      `"${pattern}" matches ${matches.length} entries; be more specific:\n${matches
        .slice(0, 10)
        .map((e) => "  " + e.name)
        .join("\n")}`,
    )
  }
  return missingEntry(
    pattern,
    entries.map((e) => e.name),
  )
}

function missingEntry(pattern: string, names: string[]): never {
  const base = path.basename(pattern)
  const suggestions = names
    .filter(
      (name) =>
        name.toLowerCase().includes(base.toLowerCase()) ||
        base.toLowerCase().includes(name.split("/").pop()?.toLowerCase() ?? ""),
    )
    .slice(0, 3)
  const hint = suggestions.length ? `\nDid you mean one of these?\n${suggestions.map((s) => "  " + s).join("\n")}` : ""
  throw new Error(`Entry not found: ${pattern}${hint}`)
}

function renderRead(
  filepath: string,
  name: string,
  data: Uint8Array,
  offset: number,
  limit?: number,
): { output: string; truncated: boolean } {
  if (isBinary(data)) {
    throw new Error(
      `Cannot read binary file entry: ${name} (${ArchiveFormat.humanSize(data.length)}). Extract it or list the archive instead.`,
    )
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
  const lines = text.replace(/\n$/, "").split("\n")
  const start = Math.max(0, offset - 1)
  const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit)
  const shown = lines.slice(start, end)
  const out: string[] = []
  let bytes = 0
  const rendered: string[] = []
  for (let i = 0; i < shown.length; i++) {
    const line = shown[i]!
    const size = Buffer.byteLength(line, "utf-8") + 1
    if (bytes + size > MAX_READ_BYTES) break
    rendered.push(`${i + start + 1}: ${line}`)
    bytes += size
  }
  out.push(`<path>${filepath}</path>`, `<entry>${name}</entry>`, "<type>file</type>", "<content>\n")
  out.push(rendered.join("\n"))
  const truncated = rendered.length < shown.length || start + shown.length < lines.length
  const last = start + rendered.length
  if (truncated) {
    out.push(
      "",
      `\n(Output capped at ${MAX_READ_BYTES / 1024} KB. Showing lines ${start + 1}-${last}. Use offset=${last + 1} to continue.)`,
    )
  } else {
    out.push("", `\n(End of entry - total ${lines.length} lines)`)
  }
  out.push("</content>")
  return { output: out.join("\n"), truncated }
}

function isBinary(data: Uint8Array): boolean {
  if (data.length === 0) return false
  const sample = Math.min(data.length, 4096)
  let nonPrintable = 0
  for (let i = 0; i < sample; i++) {
    const b = data[i]!
    if (b === 0) return true
    if (b < 9 || (b > 13 && b < 32)) nonPrintable++
  }
  return nonPrintable / sample > 0.3
}

type SourceEntry = { name: string; data: Uint8Array; date: Date; dir?: boolean }

async function collectSources(sources: string[]): Promise<SourceEntry[]> {
  const out: SourceEntry[] = []
  const acc = { total: 0 }
  for (const source of sources) {
    const stat = await fs.stat(source)
    if (stat.isFile()) {
      await addFile(out, acc, path.basename(source), source, stat)
      continue
    }
    if (stat.isDirectory()) {
      out.push({ name: path.basename(source), data: new Uint8Array(0), date: stat.mtime, dir: true })
      await walkDir(source, path.basename(source), out, acc)
      continue
    }
    throw new Error(`Source is neither a file nor a directory: ${source}`)
  }
  return out
}

async function addFile(collected: SourceEntry[], acc: { total: number }, name: string, file: string, stat: Stats) {
  if (stat.size > MAX_CREATE_FILE) {
    throw new Error(
      `${file} is ${ArchiveFormat.humanSize(stat.size)}; the create action caps files at ${ArchiveFormat.humanSize(MAX_CREATE_FILE)}`,
    )
  }
  acc.total += stat.size
  if (acc.total > MAX_CREATE_TOTAL)
    throw new Error(`Sources exceed the ${ArchiveFormat.humanSize(MAX_CREATE_TOTAL)} create cap`)
  collected.push({ name, data: new Uint8Array(await fs.readFile(file)), date: stat.mtime })
}

async function walkDir(dir: string, prefix: string, collected: SourceEntry[], acc: { total: number }) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      const stat = await fs.stat(full)
      collected.push({ name: `${prefix}/${entry.name}`, data: new Uint8Array(0), date: stat.mtime, dir: true })
      await walkDir(full, `${prefix}/${entry.name}`, collected, acc)
      continue
    }
    const st = await fs.stat(full)
    await addFile(collected, acc, `${prefix}/${entry.name}`, full, st)
  }
}

async function createPure(dest: string, format: ArchiveFormat.ArchiveFormat, sources: string[]): Promise<string> {
  const files = await collectSources(sources)
  const fileCount = files.filter((f) => !f.dir).length

  if (format.kind === "zip") {
    const result = await ZipFile.writeZip(
      dest,
      files.map((f) => ({ name: f.name, data: f.data, date: f.date, dir: f.dir })),
    )
    return `Created ${dest} (ZIP, ${fileCount} files, ${ArchiveFormat.humanSize(result.bytes)}).`
  }

  if (format.kind === "tar") {
    const tar = TarFile.createTar(toTarSource(files))
    await fs.writeFile(dest, tar)
    return `Created ${dest} (tar, ${fileCount} files, ${ArchiveFormat.humanSize(tar.length)}).`
  }

  if (format.kind === "compressed" && format.container === "tar") {
    const tar = TarFile.createTar(toTarSource(files))
    const payload = ArchiveDecompress.compress(format.compression, tar)
    await fs.writeFile(dest, payload)
    return `Created ${dest} (${format.compression} tar, ${fileCount} files, ${ArchiveFormat.humanSize(payload.length)}).`
  }

  if (format.kind === "compressed" && format.container === "single") {
    if (files.length !== 1 || files[0]!.dir) {
      throw new Error(
        `Single-file ${format.compression} archives need exactly one source file. Use a zip/tar archive for directories or multiple files.`,
      )
    }
    const payload = ArchiveDecompress.compress(format.compression, files[0]!.data)
    await fs.writeFile(dest, payload)
    return `Created ${dest} (${format.compression}, ${ArchiveFormat.humanSize(payload.length)}).`
  }

  throw new Error(`Cannot create ${formatLabel(format)} archives in-process`)
}

function toTarSource(files: SourceEntry[]) {
  return files.map((f) => ({
    name: f.name,
    data: f.data,
    mtime: Math.floor(f.date.getTime() / 1000),
    type: f.dir ? ("dir" as const) : ("file" as const),
  }))
}

export interface ArchiveInput {
  action: 'list' | 'extract' | 'read' | 'create';
  path: string;
  destination?: string;
  entries?: string[];
  entry?: string;
  source?: string[];
  overwrite?: boolean;
  offset?: number;
  limit?: number;
}

function safeSystemEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
  return normalized.split('/').every((segment) => segment !== '..');
}

function checkedLines(input: ArchiveInput): void {
  if (!input.path?.trim()) throw new Error('archive path is required');
  if (!['list', 'extract', 'read', 'create'].includes(input.action)) throw new Error(`unsupported archive action: ${String(input.action)}`);
  if (input.entries && input.entries.length < 1) throw new Error('entries must contain at least one pattern');
  if (input.source && input.source.length < 1) throw new Error('source must contain at least one path');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 1)) throw new Error('offset must be a positive integer');
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) throw new Error('limit must be a positive integer');
}

async function ensureWriteAllowed(writeAllowed: boolean): Promise<void> {
  if (!writeAllowed) throw new Error('TOOL_DISABLED: archive extraction/creation requires write access in localMCP-chat.');
}

export async function archiveTool(roots: readonly Root[], input: ArchiveInput, writeAllowed: boolean) {
  checkedLines(input);
  const signal = new AbortController().signal;

  if (input.action === 'create') {
    await ensureWriteAllowed(writeAllowed);
    if (!input.source?.length) throw new Error("The create action requires 'source' paths.");
    const dest = await resolveToolPath(roots, input.path, { allowMissing: true });
    const sources = await Promise.all(input.source.map(async (source) => (await resolveToolPath(roots, source)).real));
    const destStat = await fs.stat(dest.real).catch(() => undefined);
    if (destStat?.isDirectory()) throw new Error(`Destination looks like a directory; give create a full archive path: ${dest.virtual}`);
    const format = ArchiveFormat.createFormatForExt(dest.real);
    if (!format) throw new Error(`Cannot infer archive format from "${dest.virtual}". Supported: .zip, .tar, .tar.gz/.tgz, .gz, .br, .zst, .tar.zst, .7z.`);
    let summary: string;
    if (format.kind === '7z') summary = await ArchiveSystem.systemCreate(dest.real, sources, signal);
    else if (format.kind === 'compressed' && !ArchiveFormat.PURE_COMPRESSIONS.has(format.compression)) {
      throw new Error(`Creating ${format.compression} archives in-process is not supported. Use exec_command with the system archive utility.`);
    } else summary = await createPure(dest.real, format, sources);
    summary = summary.replaceAll(dest.real, dest.virtual);
    return ok(summary, { action: 'create', format: formatLabel(format), count: sources.length, truncated: false });
  }

  const archive = await resolveToolPath(roots, input.path);
  const stat = await fs.stat(archive.real);
  if (!stat.isFile()) throw new Error(`Archive path is not a file: ${archive.virtual}`);
  const format = await detectArchive(archive.real);
  if (format.kind === 'unknown') throw new Error('Unrecognized file format. Expected a zip, tar, gzip/brotli/zstd/bzip2 stream, 7z, rar, xz, lz4, or lzma archive.');

  if (input.action === 'list') {
    let entries: DisplayEntry[];
    let resolvedFormat: ArchiveFormat.ArchiveFormat = format;
    if (isSystemFormat(format)) {
      entries = (await ArchiveSystem.systemList(format, archive.real, signal)).map((entry) => ({ ...entry, unsafe: !safeSystemEntry(entry.name) }));
    } else {
      const resolved = await resolveEntries(archive.real, format);
      resolvedFormat = resolved.format;
      entries = resolved.entries;
    }
    const filtered = filterEntries(entries, input.entries ?? []);
    const sorted = sortEntries(filtered);
    const offset = Math.max(0, (input.offset ?? 1) - 1);
    const limit = input.limit ?? DEFAULT_LIST_ENTRIES;
    const output = renderList(archive.virtual, resolvedFormat, sorted, Boolean(input.entries?.length), offset, limit);
    const shown = Math.max(0, Math.min(limit, sorted.length - offset));
    const nextOffset = offset + shown < sorted.length ? offset + shown + 1 : null;
    return ok(output, { action: 'list', format: formatLabel(resolvedFormat), count: sorted.length, shown, offset: offset + 1, nextOffset, truncated: nextOffset !== null });
  }

  if (input.action === 'read') {
    const entry = input.entry;
    if (!entry && !(format.kind === 'compressed' && format.container === 'single')) {
      throw new Error("The read action requires an 'entry' path or glob pattern (except for single-file compressed archives).");
    }
    let data: Uint8Array;
    let name: string;
    let size: number;
    if (isSystemFormat(format)) {
      data = await ArchiveSystem.systemRead(format, archive.real, format.kind === 'compressed' ? '' : entry!, signal);
      name = entry ?? stripCompressionExt(archive.real);
      size = data.length;
    } else {
      const resolved = await readEntryData(archive.real, format, entry ?? stripCompressionExt(archive.real));
      data = resolved.data;
      name = resolved.name;
      size = resolved.size;
    }
    const rendered = renderRead(archive.virtual, name, data, input.offset ?? 1, input.limit);
    return ok(rendered.output, { action: 'read', format: formatLabel(format), count: size, truncated: rendered.truncated, entry: name });
  }

  await ensureWriteAllowed(writeAllowed);
  const singleByExt = format.kind === 'compressed' && format.container === 'single';
  const pureSingle = singleByExt && ArchiveFormat.PURE_COMPRESSIONS.has(format.compression);
  let destinationInput = input.destination;
  if (!destinationInput) {
    const realDefault = singleByExt && pureSingle
      ? path.join(path.dirname(archive.real), stripCompressionExt(archive.real))
      : ArchiveFormat.defaultDestination(archive.real);
    destinationInput = realDefault;
  }
  let destination = await resolveToolPath(roots, destinationInput, { allowMissing: true });
  if (pureSingle && input.destination) {
    const current = await fs.stat(destination.real).catch(() => undefined);
    if (current?.isDirectory()) destination = await resolveToolPath(roots, path.join(destination.real, stripCompressionExt(archive.real)), { allowMissing: true });
  }

  if (isSystemFormat(format)) {
    if (input.entries?.length) throw new Error('Filtered extraction is not supported for system-backed archive formats; omit entries or use exec_command explicitly.');
    const listed = await ArchiveSystem.systemList(format, archive.real, signal);
    const unsafe = listed.filter((item) => !safeSystemEntry(item.name)).slice(0, 10);
    if (unsafe.length) throw new Error(`Refusing system extraction because the archive contains unsafe paths:\n${unsafe.map((item) => `  ${item.name}`).join('\n')}`);
    if (format.kind === 'compressed' && format.container === 'single') {
      const data = await ArchiveSystem.systemRead(format, archive.real, '', signal);
      await writeOut(destination.real, data, new Date());
      const summary = `Decompressed ${archive.virtual} to ${destination.virtual} (${ArchiveFormat.humanSize(data.length)}).`;
      return ok(summary, { action: 'extract', format: formatLabel(format), count: 1, truncated: false, destination: destination.virtual });
    }
    await fs.mkdir(destination.real, { recursive: true });
    const systemSummary = await ArchiveSystem.systemExtract(format, archive.real, destination.real, signal);
    const output = `Extracted to ${destination.virtual}\n${systemSummary}`;
    return ok(output, { action: 'extract', format: formatLabel(format), count: listed.length, truncated: false, destination: destination.virtual });
  }

  const resolved = await resolveEntries(archive.real, format);
  const isSingleFile = resolved.format.kind === 'compressed' && resolved.format.container === 'single';
  const selection = isSingleFile ? resolved.entries : filterEntries(resolved.entries, input.entries ?? []);
  const result = await extractPure(archive.real, resolved.format, destination.real, selection, input.overwrite ?? false, signal);
  const output = renderExtract(destination.virtual, result);
  return ok(output, { action: 'extract', format: formatLabel(resolved.format), count: result.extracted, truncated: false, destination: destination.virtual, skipped: result.skipped, blocked: result.blocked });
}
