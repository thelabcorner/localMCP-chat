import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { childEnv, terminateProcessTree } from '../../../main/exec.js';
import { ok, resolveDirectory, resolveToolPath, truncateUtf8 } from './common.js';
import * as TestScope from './test-scope.js';

const DEFAULT_LIST_PAGE = 500;
const FAILURE_PAGE = 50;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const FULL_RENDER_BYTES = 256 * 1024;
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'out', 'release']);

export interface TestInput {
  action?: 'run' | 'list';
  workdir?: string;
  path?: string;
  testNamePattern?: string;
  runtime?: 'auto' | 'bun' | 'node';
  timeoutMs?: number;
  full?: boolean;
  offset?: number;
  limit?: number;
  failureOffset?: number;
}

function xml(text: unknown): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function humanize(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function tailBytes(raw: string, maxBytes: number): string {
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length <= maxBytes) return raw;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] ?? 0) >> 6 === 0b10) start++;
  return `… output tail (${bytes.length - start} of ${bytes.length} bytes) …\n${bytes.subarray(start).toString('utf8')}`;
}

async function resolveTestFilter(roots: readonly Root[], workdir: string, input?: string): Promise<string | undefined> {
  if (!input) return undefined;
  const absoluteLike = input.startsWith('/') || input.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(input);
  const resolved = absoluteLike
    ? await resolveToolPath(roots, input)
    : await resolveToolPath(roots, path.resolve(workdir, input));
  const rel = path.relative(workdir, resolved.real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Test path is outside workdir: ${input}`);
  return rel.split(path.sep).join('/');
}

async function runChild(command: TestScope.RunCommand, timeoutMs: number): Promise<{ exitCode: number | null; raw: string; timedOut: boolean; truncated: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command.bin, command.args, {
      cwd: command.cwd,
      env: { ...childEnv(), ...command.env },
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const append = (chunk: Buffer) => {
      if (bytes < MAX_CAPTURE_BYTES) {
        const remaining = MAX_CAPTURE_BYTES - bytes;
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.length;
        if (kept.length < chunk.length) truncated = true;
      } else truncated = true;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void terminateProcessTree(child.pid, true);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      append(Buffer.from(`\n${error.message}\n`, 'utf8'));
      resolve({ exitCode: 1, raw: Buffer.concat(chunks).toString('utf8'), timedOut: false, truncated });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, raw: Buffer.concat(chunks).toString('utf8'), timedOut, truncated });
    });
  });
}

function isTestFile(harness: TestScope.Harness, rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/');
  const base = path.basename(normalized);
  if (/\.(test|spec)\.(?:[cm]?[jt]sx?)$/i.test(base)) return true;
  if (/(^|\/)__tests__\//.test(normalized) && /\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (harness === 'node' && (/(^|\/)test-[^/]+\.[cm]?js$/i.test(normalized) || /(^|\/)test\/.*\.[cm]?js$/i.test(normalized))) return true;
  if (harness === 'bun' && /(^|\/)test\/.*\.[cm]?[jt]sx?$/i.test(normalized)) return true;
  return false;
}

async function listTestFiles(root: string, harness: TestScope.Harness, filter?: string): Promise<string[]> {
  const start = filter ? path.join(root, ...filter.split('/')) : root;
  const stat = await fs.stat(start).catch(() => undefined);
  if (!stat) throw new Error(`Test path not found: ${filter}`);
  if (stat.isFile()) return isTestFile(harness, filter ?? path.basename(start)) ? [filter ?? path.basename(start)] : [];
  const out: string[] = [];
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!isTestFile(harness, rel)) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

function renderFailures(failures: TestScope.TestCase[], root: string, offset: number): string[] {
  return failures.slice(offset, offset + FAILURE_PAGE).map((failure) => {
    const file = failure.file
      ? (path.isAbsolute(failure.file) ? path.relative(root, failure.file).split(path.sep).join('/') : failure.file)
      : undefined;
    const attrs = [
      file ? `file="${xml(file)}"` : '',
      failure.line ? `line="${failure.line}"` : '',
      `name="${xml(failure.fullName)}"`,
      failure.assertion ? `detail="${xml(failure.assertion.slice(0, 200))}"` : ''
    ].filter(Boolean).join(' ');
    return `    <failure ${attrs} />`;
  });
}

export async function testTool(roots: readonly Root[], input: TestInput, shellAllowed: boolean) {
  const action = input.action ?? 'run';
  const dir = await resolveDirectory(roots, input.workdir);
  const filter = await resolveTestFilter(roots, dir.real, input.path);
  const detected = await TestScope.detectHarness(dir.real, dir.root.path);
  if (!detected) throw new Error(`No test harness detected in ${dir.virtual} (checked package.json test script, dependencies, config files and node:test usage).`);
  const harness = detected.harness;

  if (action === 'list') {
    const files = await listTestFiles(dir.real, harness, filter);
    const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
    const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? input.limit! : DEFAULT_LIST_PAGE;
    const page = files.slice(offset, offset + limit);
    const nextOffset = offset + page.length < files.length ? offset + page.length : null;
    const output = [
      `<test-list harness="${harness}" files="${files.length}" offset="${offset}" truncated="${nextOffset !== null}">`,
      ...page.map((file) => `  <file path="${xml(file)}" />`),
      nextOffset === null
        ? '  <next>Use action="run" with path and/or testNamePattern to execute a focused subset.</next>'
        : `  <next offset="${nextOffset}">Continue listing from this offset.</next>`,
      '</test-list>'
    ].join('\n');
    return ok(output, { action, harness, files: files.length, shown: page.length, offset, nextOffset, truncated: nextOffset !== null });
  }

  if (!shellAllowed) throw new Error('TOOL_DISABLED: running tests requires shell access in localMCP-chat; action=list remains read-only.');
  const timeoutMs = Math.max(input.timeoutMs ?? 120_000, 1000);
  const command = await TestScope.buildCommand({
    harness,
    dir: dir.real,
    path: filter,
    filter: input.testNamePattern,
    runtime: input.runtime
  });
  const started = Date.now();
  const run = await runChild(command, timeoutMs);
  let parseSource = run.raw;
  if (command.outputFile) {
    const report = await fs.readFile(command.outputFile, 'utf8').catch(() => undefined);
    if (report !== undefined) parseSource = report;
    await fs.rm(command.outputFile, { force: true }).catch(() => undefined);
  }
  const summary = TestScope.parseReporter(parseSource, harness, run.exitCode ?? 1);
  const durationMs = Date.now() - started;
  const status = run.timedOut ? 'timed-out' : summary.failed > 0 || (run.exitCode ?? 1) !== 0 ? 'failed' : 'passed';
  const tail = tailBytes(run.raw, input.full ? FULL_RENDER_BYTES : TAIL_BYTES);
  const failureOffset = Number.isSafeInteger(input.failureOffset) && (input.failureOffset ?? 0) >= 0 ? input.failureOffset! : 0;
  const failures = renderFailures(summary.failures, dir.real, failureOffset);
  const nextFailureOffset = failureOffset + failures.length < summary.failures.length ? failureOffset + failures.length : null;
  const next = status === 'passed'
    ? 'All selected tests passed.'
    : run.timedOut
      ? `Run timed out after ${timeoutMs} ms and the child process tree was terminated. Narrow path/testNamePattern or increase timeoutMs.`
      : `Fix the ${summary.failed || 'reported'} failure(s), then re-run the focused scope.`;
  const output = [
    `<test-run harness="${harness}" runtime="${input.runtime ?? 'auto'}" status="${status}" exit="${run.exitCode ?? 1}" duration="${humanize(durationMs)}" passed="${summary.passed}" failed="${summary.failed}" skipped="${summary.skipped}" parsed="${summary.parsed}" truncated="${run.truncated}">`,
    `  <summary>${summary.passed} passed / ${summary.failed} failed / ${summary.skipped} skipped (${humanize(durationMs)})</summary>`,
    ...(failures.length ? ['  <failures>', ...failures, '  </failures>'] : []),
    ...(nextFailureOffset === null ? [] : [`  <continue-failures offset="${nextFailureOffset}" />`]),
    ...(status !== 'passed' || input.full ? [`  <output>${xml(truncateUtf8(tail, input.full ? FULL_RENDER_BYTES : TAIL_BYTES).text)}</output>`] : []),
    `  <next>${xml(next)}</next>`,
    '</test-run>'
  ].join('\n');
  return ok(output, {
    action,
    harness,
    runtime: input.runtime ?? 'auto',
    status,
    exitCode: run.exitCode,
    durationMs,
    passed: summary.passed,
    failed: summary.failed,
    failureOffset,
    nextFailureOffset,
    skipped: summary.skipped,
    parsed: summary.parsed,
    truncated: run.truncated
  });
}
