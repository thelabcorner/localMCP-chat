import { createHash } from "node:crypto"
import { parse as parseJsonc, type ParseError as JsoncParseError } from "jsonc-parser"
import { deserialize, serialize, EJSON } from "bson"

// Pure JSON analysis/manipulation helpers for the json tool. No I/O here — the
// tool layer owns file access, permissions, and dispatch.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type JsonType = "null" | "object" | "array" | "string" | "number" | "boolean" | "undefined"

export type Limits = {
  maxBytes: number
  maxDepth: number
  maxObjectKeys: number
  maxArrayItems: number
  maxNodes: number
  maxStringPreview: number
  maxSearchResults: number
  maxDiffs: number
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxBytes: 25 * 1024 * 1024,
  maxDepth: 10,
  maxObjectKeys: 60,
  maxArrayItems: 30,
  maxNodes: 1200,
  maxStringPreview: 120,
  maxSearchResults: 200,
  maxDiffs: 300,
})

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"])

export function escapeXml(value: unknown): string {
  const text =
    value == null ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value) ?? ""
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export type ParseResult =
  | { ok: true; value: Json; bytes: number; parseMs: number }
  | { ok: false; error: string; position: number; line: number; column: number; excerpt: string; bytes: number; parseMs: number }

export function parseJsonWithDiagnostics(input: string | Uint8Array, fileHint?: string): ParseResult & { format: "json" | "jsonc" | "jsonl" | "bson" } {
  const started = performance.now()
  let buf: any
  if (typeof input !== "string") buf = Buffer.from(input as any)
  const fmt = detectFormat(input, fileHint, buf)
  if (fmt === "bson" && buf) {
    try {
      const native = deserialize(buf as any)
      const value = EJSON.serialize(native) as Json
      return { ok: true, value, bytes: buf.length, parseMs: performance.now() - started, format: "bson" }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: "BSON parse failed: " + message, position: 0, line: 0, column: 0, excerpt: "", bytes: buf.length, parseMs: performance.now() - started, format: "bson" }
    }
  }
  let text = typeof input === "string" ? input : (buf as Buffer).toString("utf8")
  text = text.replace(/^\uFEFF/, "")
  const bytes = Buffer.byteLength(text, "utf8")
  if (fmt === "jsonl" || isProbablyJsonLines(text)) {
    try {
      const lines = text.split(/\r?\n/)
      const docs: Json[] = []
      for (const raw of lines) {
        const ln = raw.trim()
        if (!ln) continue
        const v = tolerantParse(ln)
        docs.push(v as Json)
      }
      return { ok: true, value: docs as Json, bytes, parseMs: performance.now() - started, format: "jsonl" }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: "JSONL line parse: " + message, position: 0, line: 0, column: 0, excerpt: text.slice(0, 200), bytes, parseMs: performance.now() - started, format: "jsonl" }
    }
  }
  try {
    const value = tolerantParse(text) as Json
    const f = fmt === "jsonc" ? "jsonc" : "json"
    return { ok: true, value, bytes, parseMs: performance.now() - started, format: f }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const posMatch = message.match(/position\s+(\d+)/i)
    const position = posMatch ? Number(posMatch[1]) : -1
    let line = 0
    let column = 0
    let excerpt = ""
    if (position >= 0) {
      const before = text.slice(0, position)
      line = before.split("\n").length
      column = before.length - before.lastIndexOf("\n")
      const start = Math.max(0, position - 80)
      const end = Math.min(text.length, position + 120)
      excerpt = text.slice(start, end)
    }
    return {
      ok: false,
      error: message,
      position,
      line,
      column,
      excerpt,
      bytes,
      parseMs: performance.now() - started,
      format: "json",
    }
  }
}

function tolerantParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {}
  const errors: JsoncParseError[] = []
  const v = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    throw new Error(errors.map(e => `jsonc error at ${e.offset}`).join("; "))
  }
  return v
}

function isProbablyJsonLines(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length > 0)
  if (lines.length < 2) return false
  return lines.every(l => {
    const t = l.trim()
    return (t[0] === "{" && t[t.length-1] === "}") || (t[0] === "[" && t[t.length-1] === "]")
  })
}

export function detectFormat(input: string | Uint8Array, fileHint?: string, buf?: any): "json" | "jsonc" | "jsonl" | "bson" {
  if (fileHint && /\.bson$/i.test(fileHint)) return "bson"
  const b: any = buf ? Buffer.from(buf) : (input instanceof Uint8Array || Buffer.isBuffer(input) ? Buffer.from(input as any) : undefined)
  if (b) {
    if (fileHint && /\.bson$/i.test(fileHint)) return "bson"
    // only treat buffer as bson if it has strong binary signals (nulls) or explicit hint
    const head = b.subarray(0, Math.min(512, b.length))
    const hasNul = head.includes(0)
    if (hasNul) return "bson"
    // rough bson size prefix match only if looks non-text
    if (b.length > 4) {
      try {
        const sz = b.readUInt32LE(0)
        if (sz > 4 && sz <= b.length && hasNul) return "bson"
      } catch {}
    }
    // otherwise treat buffer content as text (from jsonText or text file)
  }
  const t = (typeof input === "string" ? input : (b ? b.toString("utf8") : String(input))).replace(/^\uFEFF/, "").trim()
  if (fileHint && /\.jsonl|\.ndjson/i.test(fileHint)) return "jsonl"
  if (isProbablyJsonLines(t)) return "jsonl"
  if (/\/\*|\/\/|,[ \t\r\n]*[}\]]/.test(t)) return "jsonc"
  return "json"
}

export function bsonSerialize(extended: unknown): Buffer {
  const native = EJSON.deserialize(extended as any)
  return Buffer.from(serialize(native as any))
}

export function stringifyForFormat(value: unknown, format: string, indent?: number, sortKeys = false): string {
  if (format === "jsonl" && Array.isArray(value)) {
    return value.map(v => stableStringify(v, 0, sortKeys)).join("\n") + "\n"
  }
  if (format === "bson") {
    return stableStringify(value, indent ?? 2, sortKeys) + "\n"
  }
  return stableStringify(value, indent, sortKeys) + (indent === 0 ? "" : "\n")
}

export function typeOfJson(value: unknown): JsonType {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value as JsonType
}

export function previewValue(value: unknown, max = DEFAULT_LIMITS.maxStringPreview): string {
  const t = typeOfJson(value)
  if (t === "string") return JSON.stringify(String(value).length > max ? String(value).slice(0, max) + "…" : value)
  if (t === "number" || t === "boolean" || t === "null") return JSON.stringify(value)
  if (t === "array") return `[${(value as Json[]).length} item${(value as Json[]).length === 1 ? "" : "s"}]`
  if (t === "object") {
    const keys = Object.keys(value as Record<string, unknown>)
    return `{${keys.length} key${keys.length === 1 ? "" : "s"}}`
  }
  return String(value)
}

export function jsonPointerEscape(part: string | number): string {
  return String(part).replaceAll("~", "~0").replaceAll("/", "~1")
}

export function pointerFor(parent: string, part: string | number): string {
  return parent === "" ? "/" + jsonPointerEscape(part) : parent + "/" + jsonPointerEscape(part)
}

export function pathFor(parent: string, part: string | number): string {
  if (typeof part === "number" || /^\d+$/.test(part)) return `${parent}[${part}]`
  return /^[A-Za-z_$][\w$]*$/.test(part) ? `${parent}.${part}` : `${parent}[${JSON.stringify(part)}]`
}

function shapeSignature(value: unknown, depth = 0): string {
  const t = typeOfJson(value)
  if (depth > 3) return t
  if (t === "array") {
    const inner = [...new Set((value as Json[]).slice(0, 8).map((x) => shapeSignature(x, depth + 1)))].sort().join("|")
    return `array<${inner || "unknown"}>`
  }
  if (t === "object") {
    const keys = Object.keys(value as Record<string, unknown>).slice(0, 12).sort()
    return `object{${keys.map((k) => `${k}:${shapeSignature((value as Record<string, Json>)[k], depth + 1)}`).join(",")}}`
  }
  return t
}

function summarizeArrayItems(arr: Json[]) {
  const itemTypes = new Map<string, number>()
  const shapeCounts = new Map<string, number>()
  const sample = arr.slice(0, Math.min(arr.length, 24))
  for (const item of sample) {
    const t = typeOfJson(item)
    itemTypes.set(t, (itemTypes.get(t) ?? 0) + 1)
    const shape = shapeSignature(item)
    shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1)
  }
  return {
    itemTypes: [...itemTypes.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count })),
    homogeneous: shapeCounts.size <= 1,
    shapeCount: shapeCounts.size,
    dominantShape: [...shapeCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "empty",
  }
}

export type Scaffold = {
  lines: string[]
  stats: {
    nodes: number
    objects: number
    arrays: number
    primitives: number
    strings: number
    numbers: number
    booleans: number
    nulls: number
    maxDepthSeen: number
    truncatedNodes: number
    repeatedShapes: { shape: string; count: number }[]
  }
}

export function buildScaffold(value: unknown, options: Partial<Limits> = {}): Scaffold {
  const limits = { ...DEFAULT_LIMITS, ...options }
  const lines: string[] = []
  const rawShapes = new Map<string, number>()
  const stats = {
    nodes: 0,
    objects: 0,
    arrays: 0,
    primitives: 0,
    strings: 0,
    numbers: 0,
    booleans: 0,
    nulls: 0,
    maxDepthSeen: 0,
    truncatedNodes: 0,
  }

  function addLine(depth: number, s: string) {
    lines.push(`${"  ".repeat(depth)}${s}`)
  }

  function walk(node: unknown, jsonPath: string, pointer: string, depth: number, keyLabel = "$") {
    if (stats.nodes >= limits.maxNodes) {
      stats.truncatedNodes++
      if (stats.truncatedNodes === 1) addLine(depth, `… <truncated reason="maxNodes" max="${limits.maxNodes}" />`)
      return
    }
    stats.nodes++
    stats.maxDepthSeen = Math.max(stats.maxDepthSeen, depth)
    const t = typeOfJson(node)
    if (t === "object") stats.objects++
    else if (t === "array") stats.arrays++
    else {
      stats.primitives++
      if (t === "string") stats.strings++
      else if (t === "number") stats.numbers++
      else if (t === "boolean") stats.booleans++
      else if (t === "null") stats.nulls++
    }
    const shape = t === "object" || t === "array" ? shapeSignature(node) : t
    rawShapes.set(shape, (rawShapes.get(shape) ?? 0) + 1)

    if (t === "object") {
      const keys = Object.keys(node as Record<string, unknown>)
      addLine(depth, `${keyLabel}: object keys=${keys.length} path=${jsonPath} ptr=${pointer || "/"}${keys.length ? ` [${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", …" : ""}]` : ""}`)
      if (depth >= limits.maxDepth) {
        addLine(depth + 1, `… depth limit (${limits.maxDepth})`)
        return
      }
      const limited = keys.slice(0, limits.maxObjectKeys)
      for (const key of limited) {
        walk((node as Record<string, Json>)[key], pathFor(jsonPath, key), pointerFor(pointer, key), depth + 1, key)
      }
      if (keys.length > limited.length) addLine(depth + 1, `… ${keys.length - limited.length} more keys hidden (raise maxObjectKeys)`)
      return
    }
    if (t === "array") {
      const summary = summarizeArrayItems(node as Json[])
      addLine(depth, `${keyLabel}: array len=${(node as Json[]).length} itemTypes=${summary.itemTypes.map((x) => `${x.type}:${x.count}`).join("|") || "empty"} homogeneous=${summary.homogeneous} path=${jsonPath} ptr=${pointer || "/"} shape=${summary.dominantShape.slice(0, 160)}`)
      if (depth >= limits.maxDepth) {
        addLine(depth + 1, `… depth limit (${limits.maxDepth})`)
        return
      }
      const limited = (node as Json[]).slice(0, limits.maxArrayItems)
      for (let i = 0; i < limited.length; i++) {
        walk(limited[i], `${jsonPath}[${i}]`, pointerFor(pointer, i), depth + 1, `[${i}]`)
      }
      if ((node as Json[]).length > limited.length) addLine(depth + 1, `… ${(node as Json[]).length - limited.length} more items hidden (raise maxArrayItems)`)
      return
    }
    addLine(depth, `${keyLabel}: ${t} = ${previewValue(node, limits.maxStringPreview)} path=${jsonPath} ptr=${pointer || "/"}`)
  }

  walk(value, "$", "", 0)
  const repeatedShapes = [...rawShapes.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([shape, count]) => ({ shape: shape.slice(0, 220), count }))
  return { lines, stats: { ...stats, repeatedShapes } }
}

export function scaffoldToXml(scaffold: Scaffold, meta: { source?: string; bytes?: number; parseMs?: number } = {}) {
  const stats = scaffold.stats
  const repeated = stats.repeatedShapes.length
    ? `\n  <repeated-shapes>\n${stats.repeatedShapes.map((r) => `    <shape count="${r.count}">${escapeXml(r.shape)}</shape>`).join("\n")}\n  </repeated-shapes>`
    : ""
  return [
    `<json-scaffold source="${escapeXml(meta.source ?? "")}" bytes="${meta.bytes ?? 0}" parseMs="${(meta.parseMs ?? 0).toFixed(3)}" nodes="${stats.nodes}" objects="${stats.objects}" arrays="${stats.arrays}" primitives="${stats.primitives}" maxDepth="${stats.maxDepthSeen}" truncated="${stats.truncatedNodes}">`,
    `  <summary>${escapeXml(`objects=${stats.objects}, arrays=${stats.arrays}, strings=${stats.strings}, numbers=${stats.numbers}, booleans=${stats.booleans}, nulls=${stats.nulls}`)}</summary>`,
    repeated,
    `  <tree>\n${escapeXml(scaffold.lines.join("\n"))}\n  </tree>`,
    "  <suggested-calls>",
    `    <call>${escapeXml(JSON.stringify({ mode: "query", path: "$.some.path" }))}</call>`,
    `    <call>${escapeXml(JSON.stringify({ mode: "search", query: "key or value text" }))}</call>`,
    `    <call>${escapeXml(JSON.stringify({ mode: "schema" }))}</call>`,
    "  </suggested-calls>",
    "</json-scaffold>",
  ]
    .filter(Boolean)
    .join("\n")
}

export function parseJsonPath(expr: string): (string | number)[] {
  if (!expr || expr === "$") return []
  const s = expr.trim()
  if (!s.startsWith("$")) throw new Error("JSON path must start with $")
  const tokens: (string | number)[] = []
  let i = 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === ".") {
      i++
      const start = i
      while (i < s.length && /[A-Za-z0-9_$-]/.test(s[i]!)) i++
      if (start === i) throw new Error(`Invalid empty property at ${i}`)
      tokens.push(s.slice(start, i))
      continue
    }
    if (ch === "[") {
      i++
      if (s[i] === '"' || s[i] === "'") {
        const quote = s[i++]
        let val = ""
        while (i < s.length && s[i] !== quote) {
          if (s[i] === "\\") {
            val += s[i + 1] ?? ""
            i += 2
          } else val += s[i++]
        }
        if (s[i] !== quote) throw new Error("Unclosed bracket string")
        i++
        if (s[i] !== "]") throw new Error("Expected ]")
        i++
        tokens.push(val)
      } else {
        const start = i
        while (i < s.length && s[i] !== "]") i++
        if (s[i] !== "]") throw new Error("Unclosed bracket")
        const raw = s.slice(start, i).trim()
        i++
        if (!/^\d+$/.test(raw)) throw new Error(`Only numeric array indexes or quoted keys are supported in brackets: ${raw}`)
        tokens.push(Number(raw))
      }
      continue
    }
    throw new Error(`Unexpected path token '${ch}' at ${i}`)
  }
  return tokens
}

export function getAtPath(value: unknown, expr: string): { found: boolean; value?: unknown } {
  const tokens = parseJsonPath(expr)
  let cur: unknown = value
  for (const token of tokens) {
    if (cur == null) return { found: false }
    if (typeof token === "number") {
      if (!Array.isArray(cur) || token < 0 || token >= cur.length) return { found: false }
    } else if (typeof cur !== "object" || !(token in cur)) {
      return { found: false }
    }
    cur = (cur as Record<string, unknown>)[token]
  }
  return { found: true, value: cur }
}

export type SearchHit = {
  path: string
  pointer: string
  key?: string | number
  type: JsonType
  preview: string
  reason: "key" | "value" | "type"
}

export function searchJson(value: unknown, query: string, options: { type?: string; maxResults?: number; maxDepth?: number } = {}): SearchHit[] {
  const q = (query ?? "").toLowerCase()
  const max = options.maxResults ?? DEFAULT_LIMITS.maxSearchResults
  const results: SearchHit[] = []

  function walk(node: unknown, jsonPath: string, pointer: string, depth: number, key?: string | number) {
    if (results.length >= max) return
    const t = typeOfJson(node)
    const keyMatch = key !== undefined && String(key).toLowerCase().includes(q)
    const valueMatch = t !== "object" && t !== "array" && String(node).toLowerCase().includes(q)
    if (keyMatch || valueMatch || (options.type && options.type === t)) {
      results.push({
        path: jsonPath,
        pointer: pointer || "/",
        key,
        type: t,
        preview: previewValue(node),
        reason: keyMatch ? "key" : valueMatch ? "value" : "type",
      })
    }
    if (depth >= (options.maxDepth ?? 40)) return
    if (t === "object") {
      for (const k of Object.keys(node as Record<string, unknown>)) {
        walk((node as Record<string, Json>)[k], pathFor(jsonPath, k), pointerFor(pointer, k), depth + 1, k)
      }
    } else if (t === "array") {
      for (let i = 0; i < (node as Json[]).length; i++) {
        walk((node as Json[])[i], `${jsonPath}[${i}]`, pointerFor(pointer, i), depth + 1, i)
      }
    }
  }
  walk(value, "$", "", 0)
  return results
}

export function searchResultsToXml(results: SearchHit[], query: string) {
  return [
    `<json-search query="${escapeXml(query)}" results="${results.length}">`,
    ...results.map((r, i) => `  <hit rank="${i + 1}" path="${escapeXml(r.path)}" ptr="${escapeXml(r.pointer)}" type="${r.type}" reason="${r.reason}">${escapeXml(r.preview)}</hit>`),
    "</json-search>",
  ].join("\n")
}

export function stableStringify(value: unknown, indent?: number, sortKeys = false): string {
  if (!sortKeys) return JSON.stringify(value, null, indent)
  function order(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(order)
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = order((v as Record<string, unknown>)[key])
      return out
    }
    return v
  }
  return JSON.stringify(order(value), null, indent)
}

type PatchOp = {
  op: string
  path: string
  value?: unknown
  from?: string
}

function assertSafeKey(key: string | number) {
  if (typeof key === "string" && FORBIDDEN_KEYS.has(key)) throw new Error(`Forbidden key for prototype-pollution safety: ${key}`)
}

function cloneJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function pointerToTokens(ptr: string | undefined): (string | number)[] {
  if (!ptr) return []
  if (!ptr.startsWith("/")) throw new Error(`JSON pointer must start with /: ${ptr}`)
  return ptr
    .slice(1)
    .split("/")
    .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"))
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x))
}

function getAtTokens(root: unknown, tokens: (string | number)[]): unknown {
  let cur: unknown = root
  for (const t of tokens) {
    assertSafeKey(t)
    if (cur == null || !(t in (cur as object))) throw new Error(`Path not found: /${tokens.join("/")}`)
    cur = (cur as Record<string, unknown>)[t]
  }
  return cur
}

function parentAtPath(root: Json, pathTokens: (string | number)[], create = false): { parent: Json | Json[]; key: string | number } {
  if (!pathTokens.length) return { parent: root, key: "" }
  let cur: Json | Json[] = root
  for (let i = 0; i < pathTokens.length - 1; i++) {
    const token = pathTokens[i]!
    assertSafeKey(token)
    const next = cur as Record<string, unknown>
    if (next[token] === undefined) {
      if (!create) throw new Error(`Path does not exist at segment ${String(token)}`)
      ;(cur as Record<string, Json>)[token] = typeof pathTokens[i + 1] === "number" ? [] : {}
    }
    cur = next[token] as Json | Json[]
    if (cur == null || typeof cur !== "object") throw new Error(`Cannot descend into non-object at segment ${String(token)}`)
  }
  const key = pathTokens[pathTokens.length - 1]!
  assertSafeKey(key)
  return { parent: cur, key }
}

function addAtTokens(root: Json, tokens: (string | number)[], value: unknown) {
  if (!tokens.length) throw new Error("Replacing document root with add is intentionally refused")
  const { parent, key } = parentAtPath(root, tokens, true)
  if (Array.isArray(parent)) {
    if (key === "-") parent.push(value as Json)
    else parent.splice(Number(key), 0, value as Json)
  } else {
    ;(parent as Record<string, Json>)[key as string] = value as Json
  }
}

function replaceAtTokens(root: Json, tokens: (string | number)[], value: unknown) {
  if (!tokens.length) throw new Error("Replacing document root is intentionally refused")
  const { parent, key } = parentAtPath(root, tokens, false)
  if (!(key in (parent as object))) throw new Error(`Path not found for replace: ${tokens.join("/")}`)
  ;(parent as Record<string, Json>)[key as string] = value as Json
}

function removeAtTokens(root: Json, tokens: (string | number)[]) {
  if (!tokens.length) throw new Error("Removing document root is refused")
  const { parent, key } = parentAtPath(root, tokens, false)
  if (Array.isArray(parent)) parent.splice(Number(key), 1)
  else delete (parent as Record<string, Json>)[key as string]
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function applyPatchOperation(rootValue: Json, op: PatchOp): Json {
  const root = rootValue
  const operation = op.op
  if (!["add", "replace", "remove", "test", "copy", "move"].includes(operation)) throw new Error(`Unsupported patch op: ${operation}`)
  const tokens = pointerToTokens(op.path)
  if (operation === "test") {
    const got = getAtTokens(root, tokens)
    if (!deepEqual(got, op.value)) throw new Error(`Patch test failed at ${op.path}`)
    return root
  }
  if (operation === "copy" || operation === "move") {
    if (!op.from) throw new Error(`Patch op ${operation} requires a "from" pointer`)
    const val = cloneJson(getAtTokens(root, pointerToTokens(op.from)))
    if (operation === "move") removeAtTokens(root, pointerToTokens(op.from))
    addAtTokens(root, tokens, val)
    return root
  }
  if (operation === "add") addAtTokens(root, tokens, op.value)
  else if (operation === "replace") replaceAtTokens(root, tokens, op.value)
  else removeAtTokens(root, tokens)
  return root
}

export function applyJsonPatch(value: Json, operations: unknown[]): Json {
  const root = cloneJson(value)
  for (const raw of operations ?? []) {
    const op = raw as PatchOp
    applyPatchOperation(root, op)
  }
  return root
}

function mergeSchemas(a: Json | undefined, b: Json | undefined): Json | undefined {
  if (!a) return b
  if (!b) return a
  const ta = (a as { type?: string | string[] }).type
  const tb = (b as { type?: string | string[] }).type
  if (ta !== tb) {
    const union = [...(Array.isArray(ta) ? ta : ta ? [ta] : []), ...(Array.isArray(tb) ? tb : tb ? [tb] : [])]
    const types = [...new Set(union)].sort((a, b) => a.localeCompare(b))
    return { type: types } as Json
  }
  const aObj = a as { type: string; properties?: Record<string, Json>; required?: string[]; items?: Json }
  const bObj = b as { type: string; properties?: Record<string, Json>; required?: string[]; items?: Json }
  if (aObj.type === "object") {
    const properties = { ...aObj.properties }
    for (const [k, v] of Object.entries(bObj.properties ?? {})) {
      const merged = mergeSchemas(properties[k], v)
      if (merged !== undefined) properties[k] = merged
    }
    const required = [...new Set([...(aObj.required ?? []), ...(bObj.required ?? [])])].filter((k) => aObj.properties?.[k] && bObj.properties?.[k])
    return { type: "object", properties, required } as Json
  }
  if (aObj.type === "array") return { type: "array", items: mergeSchemas(aObj.items, bObj.items) ?? {} } as Json
  return a
}

export function inferJsonSchema(value: unknown, options: { maxArrayItems?: number; maxObjectKeys?: number } = {}): Json {
  const t = typeOfJson(value)
  if (t === "null") return { type: "null" }
  if (t === "string") return { type: "string" }
  if (t === "number") return { type: Number.isInteger(value) ? "integer" : "number" }
  if (t === "boolean") return { type: "boolean" }
  if (t === "array") {
    let items: Json | undefined
    for (const item of (value as Json[]).slice(0, options.maxArrayItems ?? 100)) {
      items = mergeSchemas(items, inferJsonSchema(item, options))
    }
    return { type: "array", items: items ?? {} } as Json
  }
  if (t === "object") {
    const properties: Record<string, Json> = {}
    const keys = Object.keys(value as Record<string, unknown>).slice(0, options.maxObjectKeys ?? 300)
    for (const key of keys) properties[key] = inferJsonSchema((value as Record<string, Json>)[key], options)
    return { type: "object", properties, required: keys } as Json
  }
  return {}
}

export type JsonDiff = {
  kind: "type" | "added" | "removed" | "changed"
  path: string
  pointer: string
  from?: string
  to?: string
  value?: string
}

export function diffJson(a: unknown, b: unknown, options: { maxDiffs?: number } = {}): JsonDiff[] {
  const diffs: JsonDiff[] = []
  const max = options.maxDiffs ?? DEFAULT_LIMITS.maxDiffs
  function walk(x: unknown, y: unknown, p: string, ptr: string) {
    if (diffs.length >= max) return
    const tx = typeOfJson(x)
    const ty = typeOfJson(y)
    if (tx !== ty) {
      diffs.push({ kind: "type", path: p, pointer: ptr || "/", from: tx, to: ty })
      return
    }
    if (tx === "object") {
      const keys = new Set([...Object.keys(x as Record<string, unknown>), ...Object.keys(y as Record<string, unknown>)])
      for (const k of keys) {
        if (!(k in (x as Record<string, unknown>))) diffs.push({ kind: "added", path: pathFor(p, k), pointer: pointerFor(ptr, k), value: previewValue((y as Record<string, unknown>)[k]) })
        else if (!(k in (y as Record<string, unknown>))) diffs.push({ kind: "removed", path: pathFor(p, k), pointer: pointerFor(ptr, k), value: previewValue((x as Record<string, unknown>)[k]) })
        else walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], pathFor(p, k), pointerFor(ptr, k))
        if (diffs.length >= max) return
      }
    } else if (tx === "array") {
      const n = Math.max((x as Json[]).length, (y as Json[]).length)
      for (let i = 0; i < n; i++) {
        if (i >= (x as Json[]).length) diffs.push({ kind: "added", path: `${p}[${i}]`, pointer: pointerFor(ptr, i), value: previewValue((y as Json[])[i]) })
        else if (i >= (y as Json[]).length) diffs.push({ kind: "removed", path: `${p}[${i}]`, pointer: pointerFor(ptr, i), value: previewValue((x as Json[])[i]) })
        else walk((x as Json[])[i], (y as Json[])[i], `${p}[${i}]`, pointerFor(ptr, i))
        if (diffs.length >= max) return
      }
    } else if (!deepEqual(x, y)) {
      diffs.push({ kind: "changed", path: p, pointer: ptr || "/", from: previewValue(x), to: previewValue(y) })
    }
  }
  walk(a, b, "$", "")
  return diffs
}

export function diffToXml(diffs: JsonDiff[]) {
  return [
    `<json-diff changes="${diffs.length}">`,
    ...diffs.map(
      (d, i) =>
        `  <change rank="${i + 1}" kind="${d.kind}" path="${escapeXml(d.path)}" ptr="${escapeXml(d.pointer)}"${d.from ? ` from="${escapeXml(d.from)}"` : ""}${d.to ? ` to="${escapeXml(d.to)}"` : ""}${d.value ? ` value="${escapeXml(d.value)}"` : ""} />`,
    ),
    "</json-diff>",
  ].join("\n")
}

export function hashText(text: string | Uint8Array): string {
  const h = createHash("sha256")
  if (typeof text === "string") h.update(text)
  else h.update(Buffer.from(text))
  return h.digest("hex").slice(0, 16)
}

export function validationXml(parsed: ParseResult, source = ""): string {
  if (parsed.ok) return `<json-validate source="${escapeXml(source)}" ok="true" bytes="${parsed.bytes}" parseMs="${parsed.parseMs.toFixed(3)}" />`
  return [
    `<json-validate source="${escapeXml(source)}" ok="false" bytes="${parsed.bytes}" parseMs="${parsed.parseMs.toFixed(3)}">`,
    `  <error line="${parsed.line}" column="${parsed.column}" position="${parsed.position}">${escapeXml(parsed.error)}</error>`,
    parsed.excerpt ? `  <excerpt>${escapeXml(parsed.excerpt)}</excerpt>` : "",
    "</json-validate>",
  ]
    .filter(Boolean)
    .join("\n")
}
