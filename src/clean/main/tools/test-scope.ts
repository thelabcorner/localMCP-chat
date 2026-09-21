import path from "path"

// Shared machinery for the `test` tool: harness detection, per-harness command
// construction, and reporter parsing (JSON for vitest/jest, TAP for node:test,
// text for bun). Kept in its own module so the pure parsers can be unit-tested
// without a runtime, mirroring the typecheck tool's typecheck-scope split.

export type Harness = "bun" | "vitest" | "jest" | "node" | "mocha" | "ava" | "playwright" | "none"

export type TestCase = {
  /** "describe > test" style full name */
  fullName: string
  status: "passed" | "failed" | "skipped"
  /** milliseconds when the reporter provides it */
  duration?: number
  /** test file path (absolute), when the reporter provides it */
  file?: string
  /** 1-based line in `file`, when the reporter provides it */
  line?: number
  /** first assertion/failure line, when the reporter provides it */
  assertion?: string
}

export type TestSummary = {
  harness: Harness
  passed: number
  failed: number
  skipped: number
  total: number
  /** total wall-clock duration in ms when the reporter provides it */
  durationMs?: number
  /** individual test cases (may be capped) */
  tests: TestCase[]
  /** failing cases only, ordered as reported */
  failures: TestCase[]
  /** exit code of the runner */
  exitCode: number
  /** combined stdout+stderr, used for the full-output spill */
  raw: string
  /** true when a structured parser matched; false for the raw fallback */
  parsed: boolean
}

export type Detected = {
  harness: Harness
  /** human-readable reason for the detection, e.g. "vitest.config.ts" */
  via: string
  /** package dir the harness was resolved from */
  dir: string
}

// ---------------------------------------------------------------------------
// Harness detection
// ---------------------------------------------------------------------------

// Explicit framework config files win over everything else (strongest signal
// the project is set up for that harness).
const CONFIG_FILES: Record<string, Harness> = {
  "vitest.config.ts": "vitest",
  "vitest.config.mts": "vitest",
  "vitest.config.cts": "vitest",
  "vitest.config.js": "vitest",
  "vitest.config.mjs": "vitest",
  "vitest.config.cjs": "vitest",
  "jest.config.ts": "jest",
  "jest.config.mts": "jest",
  "jest.config.cts": "jest",
  "jest.config.js": "jest",
  "jest.config.mjs": "jest",
  "jest.config.cjs": "jest",
  "jest.config.json": "jest",
  "playwright.config.ts": "playwright",
  "playwright.config.mts": "playwright",
  "playwright.config.cts": "playwright",
  "playwright.config.js": "playwright",
  "playwright.config.mjs": "playwright",
  "playwright.config.cjs": "playwright",
  ".mocharc.json": "mocha",
  ".mocharc.jsonc": "mocha",
  ".mocharc.js": "mocha",
  ".mocharc.cjs": "mocha",
  ".mocharc.yml": "mocha",
  ".mocharc.yaml": "mocha",
  "ava.config.js": "ava",
  "ava.config.mjs": "ava",
  "ava.config.cjs": "ava",
  "ava.config.ts": "ava",
}

// Per-harness detection signals, in design §6.2 priority order: for each
// harness check (a) config file, (b) test script marker, (c) devDependency.
const HARNESS_SIGNALS: Array<{
  harness: Harness
  config?: string[]
  script?: RegExp
  deps?: string[]
}> = [
  { harness: "vitest", script: /\bvitest\b/, deps: ["vitest"] },
  { harness: "jest", script: /\bjest\b/, deps: ["jest"] },
  { harness: "bun", script: /\bbun\s+test\b|\bbunx\b/ },
  { harness: "node", script: /\bnode\s+--test\b/ },
  { harness: "mocha", script: /\bmocha\b/, deps: ["mocha"] },
  { harness: "ava", script: /\bava\b/, deps: ["ava"] },
  { harness: "playwright", script: /\bplaywright\s+test\b/, deps: ["@playwright/test"] },
]

const BUN_LOCKFILES = ["bun.lock", "bun.lockb", ".bunfig.toml"]

function scriptVia(script: string | undefined, marker: RegExp | undefined): string | undefined {
  if (!script || !marker || !marker.test(script)) return undefined
  return `test script: ${script.trim().split(/\s+/).slice(0, 6).join(" ")}…`
}

function depVia(deps: Record<string, string> | undefined, names: string[] | undefined): string | undefined {
  if (!deps || !names) return undefined
  for (const name of names) {
    if (name in deps) return `dependency: ${name}`
  }
  return undefined
}

export type PackageJson = {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
}

// node:test also counts as detected when test files import `node:test`
// (design §6.2 priority 4). Probe a bounded set of default-glob test files.
const NODE_PROBE_FILES = 8
const NODE_PROBE_BYTES = 2048

async function testFilesImportNodeTest(dir: string, entries: string[]): Promise<boolean> {
  const fs = await import("node:fs/promises")
  let checked = 0
  const candidates = entries.filter(
    (name) => /\.test\.(js|mjs|cjs|ts|mts|cts)$/.test(name) || /(^|\/)test\//.test(name),
  )
  if (candidates.length === 0) return false
  for (const rel of candidates) {
    if (checked >= NODE_PROBE_FILES) break
    checked++
    const text = await fs.readFile(path.join(dir, rel), "utf8").catch(() => "")
    if (text.slice(0, NODE_PROBE_BYTES).includes("node:test")) return true
  }
  return false
}

/**
 * Detect the test harness for a directory from config files + package.json
 * (test script + devDeps), walking up from `dir` toward (and including)
 * `stopAt`. Returns the strongest match plus the dir it was resolved from.
 */
export async function detectHarness(dir: string, stopAt: string): Promise<Detected | undefined> {
  let current = path.resolve(dir)
  const root = path.resolve(stopAt)
  while (true) {
    const entries = await fsReadDir(current)
    for (const name of entries) {
      const harness = CONFIG_FILES[name]
      if (harness) return { harness, via: name, dir: current }
    }

    const pkg = await readPackageJson(current)
    const allDeps = pkg ? { ...pkg.devDependencies, ...pkg.dependencies } : undefined
    for (const { harness, script, deps } of HARNESS_SIGNALS) {
      const viaScript = scriptVia(pkg?.scripts?.test, script)
      if (viaScript) return { harness, via: viaScript, dir: current }
      const viaDep = depVia(allDeps, deps)
      if (viaDep) return { harness, via: viaDep, dir: current }
      if (harness === "bun" && BUN_LOCKFILES.some((name) => entries.includes(name))) {
        return {
          harness,
          via: BUN_LOCKFILES.filter((name) => entries.includes(name)).join(" / "),
          dir: current,
        }
      }
      if (harness === "node" && (await testFilesImportNodeTest(current, entries))) {
        return { harness, via: "test files import node:test", dir: current }
      }
    }
    // The nearest package.json is the project boundary: when it carries no
    // harness signal, detection stops (a grandparent's test runner is not this
    // project's).
    if (pkg) return undefined

    if (current === root || current === path.dirname(current)) break
    current = path.dirname(current)
  }
  return undefined
}

async function fsReadDir(dir: string): Promise<string[]> {
  const fs = await import("node:fs/promises")
  return fs.readdir(dir).catch(() => [] as string[])
}

async function readPackageJson(dir: string): Promise<PackageJson | undefined> {
  const fs = await import("node:fs/promises")
  const text = await fs.readFile(path.join(dir, "package.json"), "utf8").catch(() => undefined)
  if (!text) return undefined
  try {
    return JSON.parse(text) as PackageJson
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

export type Runtime = "auto" | "bun" | "node"

export type RunCommand = {
  /** executable (bun, node, or the resolved JS bin for a node-based harness) */
  bin: string
  args: string[]
  /** directory the runner should execute in */
  cwd: string
  /** extra env vars to pass (e.g. CI=1 for playwright) */
  env?: Record<string, string>
  /**
   * Reporter output file to read after the run (vitest 2+/3 writes JSON to a
   * file instead of stdout when `--outputFile` is set; probe: if the file
   * appears after the run, parse it, else fall back to stdout text).
   */
  outputFile?: string
}

const NODE_BIN_PKGS: Record<string, string> = {
  vitest: "vitest",
  jest: "jest",
  mocha: "mocha",
  ava: "ava",
  playwright: "@playwright/test",
}

/**
 * Resolve a node-based harness's CLI entry as an absolute JS file so it can be
 * spawned via `node <bin>` on any platform (no .cmd/shell needed). Reads the
 * package's `bin` field; falls back to known entry points.
 */
export async function resolveNodeBin(dir: string, harness: Harness): Promise<string | undefined> {
  const pkg = NODE_BIN_PKGS[harness]
  if (!pkg) return undefined
  const pkgDir = path.join(dir, "node_modules", ...pkg.split("/"))
  const fs = await import("node:fs/promises")
  const manifest = await fs
    .readFile(path.join(pkgDir, "package.json"), "utf8")
    .then((text: string) => JSON.parse(text) as { bin?: string | Record<string, string> })
    .catch(() => undefined)
  if (manifest?.bin) {
    const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin[harness] ?? Object.values(manifest.bin)[0]
    if (typeof bin === "string") {
      const candidate = path.join(pkgDir, ...bin.split("/"))
      if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate
    }
  }
  return undefined
}

/**
 * Build the runner command for a harness (design §6.3-6.5). Path + name
 * filters are mapped per harness; parseable reporters are attached per
 * harness. Throws on runtime/harness mismatches (bun:test files cannot run
 * under `node --test` and vice versa).
 */
export async function buildCommand(input: {
  harness: Harness
  dir: string
  path?: string
  filter?: string
  runtime?: Runtime
  parseable?: boolean
}): Promise<RunCommand> {
  const { harness, dir } = input
  const filterArgs = input.filter ? nameFilterArgs(harness, input.filter) : []
  const pathArgs = input.path ? [input.path] : []
  const parseable = input.parseable ?? true
  const runtime = input.runtime ?? "auto"

  if (harness === "bun") {
    if (runtime === "node") {
      throw new Error(
        "harness is bun test (bun:test files); runtime=node cannot run them. Use runtime=auto or bun.",
      )
    }
    return { bin: "bun", args: ["test", ...pathArgs, ...filterArgs], cwd: dir }
  }
  if (harness === "node") {
    if (runtime === "bun") {
      throw new Error(
        "harness is node:test; forcing runtime=bun is not supported (bun test is for bun:test API files). Use runtime=auto or node.",
      )
    }
    const args = ["--test", ...pathArgs]
    if (filterArgs.length) args.push(...filterArgs)
    if (parseable) args.push("--test-reporter=tap")
    return { bin: "node", args, cwd: dir }
  }

  const bin = await resolveNodeBin(dir, harness)
  if (!bin) {
    throw new Error(
      `Harness "${harness}" is not installed locally (no node_modules/${NODE_BIN_PKGS[harness]} bin found). Install it or run the repo's tests via the shell tool (e.g. \`npm test\`).`,
    )
  }
  const args: string[] = []
  if (harness === "vitest") args.push("run", ...pathArgs)
  else if (harness === "playwright") args.push("test", ...pathArgs)
  else args.push(...pathArgs)
  args.push(...filterArgs)
  let outputFile: string | undefined
  if (parseable) {
    if (harness === "jest") args.push("--json")
    else if (harness === "vitest") {
      args.push("--reporter=json")
      outputFile = path.join(dir, `.opencode-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.json`)
      args.push(`--outputFile=${outputFile}`)
    } else if (harness === "mocha") args.push("--reporter", "json")
    else if (harness === "playwright") {
      args.push("--reporter=json")
      outputFile = path.join(dir, `.opencode-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.json`)
      args.push(`--outputFile=${outputFile}`)
    }
    // ava outputs TAP by default; nothing to add.
  }
  return { bin: "node", args: [bin, ...args], cwd: dir, env: harness === "playwright" ? { CI: "1" } : undefined, outputFile }
}

function nameFilterArgs(harness: Harness, filter: string): string[] {
  if (harness === "bun" || harness === "jest" || harness === "vitest") return ["-t", filter]
  if (harness === "node") return [`--test-name-pattern=${filter}`]
  if (harness === "mocha") return ["--grep", filter]
  if (harness === "playwright") return ["-g", filter]
  if (harness === "ava") return [`--match=*${filter}*`]
  return []
}

// ---------------------------------------------------------------------------
// Reporter parsing
// ---------------------------------------------------------------------------

/** Extract the first "file:line" pair from a stack/failure line if present. */
function fileLineFromStack(line: string): { file?: string; line?: number } {
  const match = /\((.+?):(\d+):\d+\)/.exec(line)
  if (!match) return {}
  const file = path.normalize(match[1]!)
  return { file, line: Number.parseInt(match[2]!, 10) }
}

function firstAssertionLine(failureMessages: string[]): string | undefined {
  const joined = failureMessages.join("\n")
  const lines = joined.split(/\r?\n/).filter((l) => l.trim())
  const first = lines[0]?.trim()
  if (!first) return undefined
  // Prefer the descriptive assertion line over a bare stack frame when both
  // are present (jest failureMessages start with the assertion text).
  return first.length > 200 ? first.slice(0, 200) : first
}

type JestCompatible = {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  numTodoTests?: number
  success?: boolean
  testResults?: Array<{
    name?: string
    status?: string
    message?: string
    testResults?: Array<JestCase>
    assertionResults?: Array<JestCase>
  }>
}

type JestCase = {
  ancestorTitles?: string[]
  fullName?: string
  title?: string
  status?: string
  duration?: number
  failureMessages?: string[]
}

function parseJsonReporter(raw: string): TestSummary | undefined {
  let data: JestCompatible
  try {
    data = JSON.parse(raw) as JestCompatible
  } catch {
    return undefined
  }
  if (typeof data !== "object" || data === null) return undefined
  if (typeof data.numTotalTests !== "number" && !Array.isArray(data.testResults)) return undefined

  const tests: TestCase[] = []
  for (const suite of data.testResults ?? []) {
    const file = suite.name ? path.normalize(suite.name) : undefined
    const cases = suite.assertionResults ?? suite.testResults ?? []
    for (const c of cases) {
      const status = normalizeStatus(c.status)
      if (!status) continue
      const fullName = c.fullName ?? [...(c.ancestorTitles ?? []), c.title ?? ""].join(" > ")
      let line: number | undefined
      let assertion: string | undefined
      if (status === "failed" && c.failureMessages?.length) {
        assertion = firstAssertionLine(c.failureMessages)
        const loc = fileLineFromStack(c.failureMessages[0]!)
        if (loc.line !== undefined) line = loc.line
        if (loc.file) {
          tests.push({ fullName, status, duration: c.duration, file: loc.file, line: loc.line, assertion })
          continue
        }
      }
      tests.push({ fullName, status, duration: c.duration, file, line, assertion })
    }
  }

  const passed = data.numPassedTests ?? tests.filter((t) => t.status === "passed").length
  const failed = data.numFailedTests ?? tests.filter((t) => t.status === "failed").length
  const skipped = (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0)
  const total = data.numTotalTests ?? passed + failed + skipped
  return {
    harness: "vitest",
    passed,
    failed,
    skipped,
    total,
    tests,
    failures: tests.filter((t) => t.status === "failed"),
    exitCode: data.success === false ? 1 : 0,
    raw,
    parsed: true,
  }
}

function normalizeStatus(status: string | undefined): TestCase["status"] | undefined {
  if (status === "passed") return "passed"
  if (status === "failed") return "failed"
  if (status === "skipped" || status === "pending" || status === "todo" || status === "disabled") return "skipped"
  return undefined
}

// --- TAP (node:test) ---

type TapEntry = {
  fullName: string
  ok: boolean
  skipped: boolean
  type?: string
  file?: string
  line?: number
  error?: string
}

function parseTap(raw: string): TestSummary | undefined {
  const lines = raw.split(/\r?\n/)
  if (!lines.some((l) => l.startsWith("TAP version 13")) && !lines.some((l) => /^ok \d|^not ok \d/.test(l))) {
    return undefined
  }
  const entries: TapEntry[] = []
  // node:test emits `# Subtest: <name>` before EVERY subtest (suite or leaf)
  // and closes a suite block with a `1..N` plan line. Leaf entries always name
  // the top of this stack, so we can rebuild "suite > test" full names by
  // popping the matching context and popping again on plan lines. Suite
  // closing entries (type 'suite') arrive AFTER their children and carry no
  // naming value.
  const contexts: string[] = []
  let current: TapEntry | undefined
  let yaml: Record<string, string> | undefined
  let footer = { tests: 0, pass: 0, fail: 0, skipped: 0, durationMs: undefined as number | undefined }

  const flush = () => {
    if (!current) return
    current.fullName = current.fullName || ""
    entries.push(current)
    current = undefined
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "...") {
      flush()
      yaml = undefined
      continue
    }
    const subtest = /^# Subtest: (.+)$/.exec(trimmed)
    if (subtest) {
      flush()
      contexts.push(subtest[1]!.trim())
      continue
    }
    const ok = /^(ok|not ok)\s+\d+(?:\s*-\s*(.*))?$/.exec(trimmed)
    if (ok) {
      const name = (ok[2] ?? "").replace(/\s*#\s*(SKIP|TODO).*$/, "").trim()
      const skipped = /#\s*SKIP/.test(ok[2] ?? "")
      if (contexts.length > 0 && contexts[contexts.length - 1] === name) {
        contexts.pop()
      }
      const fullName = name ? [...contexts, name].join(" > ") : [...contexts].join(" > ")
      current = { fullName, ok: ok[1] === "ok", skipped }
      yaml = undefined
      continue
    }
    const plan = /^1\.\.\d+$/.exec(trimmed)
    if (plan) {
      flush()
      if (contexts.length > 0) contexts.pop()
      continue
    }
    const testLine = /^# (tests|pass|fail|skipped|cancelled|todo|duration_ms)\s+(\d+(?:\.\d+)?)/.exec(trimmed)
    if (testLine) {
      const key = testLine[1]!
      const value = Number(testLine[2])
      if (key === "tests") footer.tests = value
      else if (key === "pass") footer.pass = value
      else if (key === "fail") footer.fail = value
      else if (key === "skipped") footer.skipped = value
      else if (key === "duration_ms") footer.durationMs = value
      continue
    }
    // YAML detail block (2-space indented key: value lines following an ok
    // line) — apply fields to the current entry live so type/location/error
    // are available when the entry is flushed.
    const field = /^([a-z_]+):\s*(.*)$/.exec(trimmed)
    if (field && line.startsWith(" ") && current) {
      yaml = yaml ?? {}
      yaml[field[1]!] = field[2]!.replace(/^'|'$/g, "").trim()
      const value = yaml[field[1]!]
      if (field[1] === "type") current.type = value
      else if (field[1] === "location") {
        const loc = fileLineFromLocation(value!)
        if (loc.file) current.file = loc.file
        if (loc.line !== undefined) current.line = loc.line
      } else if (field[1] === "error") current.error = value
    }
  }
  flush()

  const tests: TestCase[] = []
  const failures: TestCase[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  for (const entry of entries) {
    if (entry.type === "suite") continue
    if (entry.skipped) skipped++
    else if (entry.ok) passed++
    else failed++
    const status: TestCase["status"] = entry.skipped ? "skipped" : entry.ok ? "passed" : "failed"
    const test: TestCase = {
      fullName: entry.fullName || "(unnamed)",
      status,
      file: entry.file,
      line: entry.line,
      ...(entry.error ? { assertion: entry.error } : {}),
    }
    tests.push(test)
    if (status === "failed") failures.push(test)
  }

  const hasFooter = footer.tests > 0 || footer.pass > 0
  return {
    harness: "node",
    passed: hasFooter ? footer.pass : passed,
    failed: hasFooter ? footer.fail : failed,
    skipped: hasFooter ? footer.skipped : skipped,
    total: hasFooter ? footer.tests : tests.length,
    durationMs: footer.durationMs,
    tests,
    failures,
    exitCode: (hasFooter ? footer.fail : failed) > 0 ? 1 : 0,
    raw,
    parsed: true,
  }
}

function fileLineFromLocation(value: string): { file?: string; line?: number } {
  const loc = /^(.+):(\d+):(\d+)$/.exec(value)
  if (!loc) return {}
  return { file: path.normalize(loc[1]!), line: Number.parseInt(loc[2]!, 10) }
}

// --- bun text output ---

const BUN_PASS = /^\(pass\) (.+?)(?: \[[\d.]+ms\])?$/
const BUN_SKIP = /^\(skip\) (.+?)$/
const BUN_FAIL = /^\(fail\) (.+?)(?: \[[\d.]+ms\])?$/
const BUN_RAN = /^Ran (\d+) tests across (\d+) file.* \[([\d.]+)ms\]$/
const BUN_SUMMARY = /^ *(\d+) (pass|skip|fail)$/

function parseBunText(raw: string): TestSummary | undefined {
  const lines = raw.split(/\r?\n/)
  if (!lines.some((l) => BUN_PASS.test(l) || BUN_FAIL.test(l))) return undefined
  const tests: TestCase[] = []
  let currentFile: string | undefined
  let summary = { pass: 0, skip: 0, fail: 0 }
  let durationMs: number | undefined
  let total = 0
  // bun prints the failure detail (Expected/Received, `at file:line:col`)
  // BEFORE the `(fail)` marker line — keep a short context ring to look back.
  const context: string[] = []
  const CONTEXT_BUDGET_BYTES = 64 * 1024
  let contextBytes = 0
  const clearContext = () => { context.length = 0; contextBytes = 0 }

  for (const line of lines) {
    const fileHeader = /^([^ (]+\.test\.[a-z]+):\s*$/.exec(line)
    if (fileHeader) {
      currentFile = fileHeader[1]!
      clearContext()
      continue
    }
    const pass = BUN_PASS.exec(line)
    if (pass) {
      tests.push({ fullName: pass[1]!.trim(), status: "passed", file: currentFile })
      summary.pass++
      total++
      clearContext()
      continue
    }
    const skip = BUN_SKIP.exec(line)
    if (skip) {
      tests.push({ fullName: skip[1]!.trim(), status: "skipped", file: currentFile })
      summary.skip++
      total++
      clearContext()
      continue
    }
    const fail = BUN_FAIL.exec(line)
    if (fail) {
      const test: TestCase = { fullName: fail[1]!.trim(), status: "failed", file: currentFile }
      // bun prints the failure detail BEFORE the `(fail)` marker. Prefer the
      // Expected/Received lines as the assertion; fall back to the error: line.
      for (const prev of context) {
        const expect = /^(Expected|Received): /.exec(prev.trim())
        if (expect) {
          test.assertion = prev.trim().slice(0, 200)
          break
        }
      }
      if (test.assertion === undefined) {
        for (const prev of context) {
          const error = /^error: (.+)$/.exec(prev.trim())
          if (error) {
            test.assertion = error[1]!.slice(0, 200)
            break
          }
        }
      }
      for (const prev of context) {
        const at = /^ *at .*\((.+):(\d+):\d+\)$/.exec(prev)
        if (at) {
          test.file = path.normalize(at[1]!)
          test.line = Number.parseInt(at[2]!, 10)
          break
        }
      }
      tests.push(test)
      summary.fail++
      total++
      clearContext()
      continue
    }
    const ran = BUN_RAN.exec(line)
    if (ran) {
      durationMs = Number.parseFloat(ran[3]!)
      clearContext()
      continue
    }
    const sum = BUN_SUMMARY.exec(line)
    if (sum) {
      summary[sum[2] as "pass" | "skip" | "fail"] = Number.parseInt(sum[1]!, 10)
      clearContext()
      continue
    }
    context.push(line)
    contextBytes += Buffer.byteLength(line, 'utf8') + 1
    while (contextBytes > CONTEXT_BUDGET_BYTES && context.length > 1) {
      const removed = context.shift()
      if (removed !== undefined) contextBytes -= Buffer.byteLength(removed, 'utf8') + 1
    }
  }

  return {
    harness: "bun",
    passed: summary.pass,
    failed: summary.fail,
    skipped: summary.skip,
    total: total || summary.pass + summary.skip + summary.fail,
    durationMs,
    tests,
    failures: tests.filter((t) => t.status === "failed"),
    exitCode: summary.fail > 0 ? 1 : 0,
    raw,
    parsed: true,
  }
}

/**
 * Universal text fallback (design §6.3): count explicit PASS/FAIL/✓/✗ /
 * ok N / not ok N lines when present; otherwise the exit code is the only
 * signal. Always returns a summary with `parsed: false`.
 */
const GENERIC_PASS = /(?:^|\s)(?:PASS|✓|✔|ok \d+)(?:\s|$|:)/i
const GENERIC_FAIL = /(?:^|\s)(?:FAIL|✗|✘|not ok \d+)(?:\s|$|:)/i

export function parseGeneric(raw: string, harness: Harness, exitCode: number): TestSummary {
  const lines = raw.split(/\r?\n/)
  let passed = 0
  let failed = 0
  for (const line of lines) {
    if (GENERIC_FAIL.test(line) && !GENERIC_PASS.test(line)) failed++
    else if (GENERIC_PASS.test(line)) passed++
  }
  const recognized = passed > 0 || failed > 0
  return {
    harness,
    passed,
    failed,
    skipped: 0,
    total: recognized ? passed + failed : 0,
    tests: [],
    failures: [],
    exitCode,
    raw,
    parsed: false,
  }
}

/**
 * Parse reporter output into a summary (design §6.3). Tries the harness's
 * structured parser (jest/vitest JSON, node TAP, bun text), then the generic
 * text fallback. Never returns undefined — the fallback always yields a
 * summary so the caller can render counts + `parsed=false` + exit code.
 */
export function parseReporter(raw: string, harness: Harness, exitCode: number): TestSummary {
  const trimmed = raw.trimStart()
  if (harness === "vitest" || harness === "jest") {
    const parsed = parseJsonReporter(trimmed)
    if (parsed) return { ...parsed, harness, exitCode }
  }
  if (harness === "node") {
    const parsed = parseTap(trimmed)
    if (parsed) return { ...parsed, exitCode }
  }
  if (harness === "bun") {
    const parsed = parseBunText(trimmed)
    if (parsed) return { ...parsed, exitCode }
  }
  if (harness === "mocha" || harness === "playwright" || harness === "ava" || harness === "none") {
    const parsed = parseJsonReporter(trimmed) ?? parseTap(trimmed) ?? parseBunText(trimmed)
    if (parsed) return { ...parsed, harness, exitCode }
  }
  return parseGeneric(trimmed, harness, exitCode)
}

export * as TestScope from "./test-scope"
