import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { childEnv } from '../../../main/exec.js';
import { isContained } from '../../../main/sandbox.js';
import { MAX_MODEL_OUTPUT_BYTES, ok, resolveDirectory, truncateUtf8 } from './common.js';

const MAX_MANIFEST_BYTES = 256_000;
const STAT_CONCURRENCY = 32;
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'out', 'release', '__pycache__']);
const ENTRY_NAMES = ['src/index.ts', 'src/index.tsx', 'src/main.ts', 'src/main.tsx', 'src/app.ts', 'src/app.tsx', 'index.ts', 'index.js', 'main.ts', 'main.js', 'app.ts', 'app.js', 'cmd/main.go', 'main.go', 'src/main.rs', 'src/lib.rs', 'manage.py'];

export interface ProjectInput {
  action?: 'snapshot' | 'summary' | 'recent' | 'toolchain';
  tier?: 'summary' | 'structure' | 'full';
  path?: string;
  workdir?: string;
  depth?: number;
  maxEntries?: number;
  recent?: number;
  offset?: number;
}

interface FileRow { rel: string; size: number; mtimeMs: number }

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 ? Math.round(n) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[i]}`;
}

async function run(bin: string, args: string[], cwd: string, timeoutMs = 3000, maxOutputBytes = 512 * 1024): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: childEnv(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      if (bytes >= maxOutputBytes) return;
      const kept = chunk.subarray(0, maxOutputBytes - bytes);
      out.push(kept); bytes += kept.length;
    });
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill(), timeoutMs) : undefined;
    child.once('error', () => { if (timer) clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
    child.once('close', (code) => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8') }); });
  });
}

async function findGitRoot(dir: string, approvedRoot: string): Promise<string | undefined> {
  const result = await run('git', ['rev-parse', '--show-toplevel'], dir);
  if (result.code !== 0 || !result.stdout.trim()) return undefined;
  const root = path.resolve(result.stdout.trim());
  return isContained(approvedRoot, root) ? root : undefined;
}

async function gitFiles(dir: string, gitRoot: string): Promise<string[] | undefined> {
  // Repository inventory is correctness data. Do not truncate it at the generic command-output
  // ceiling or time out a very large worktree; the returned filename array already accounts for
  // the memory needed by downstream project statistics.
  const result = await run('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard'], gitRoot, 0, Number.MAX_SAFE_INTEGER);
  if (result.code !== 0) return undefined;
  const prefix = path.relative(gitRoot, dir).split(path.sep).join('/');
  const start = prefix && prefix !== '.' ? `${prefix}/` : '';
  return result.stdout.split(/\r?\n/).filter(Boolean).filter((file) => !start || file.startsWith(start)).map((file) => start ? file.slice(start.length) : file);
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = (await fs.readdir(current, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[])).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

async function fileRows(dir: string, files: string[]): Promise<FileRow[]> {
  const rows: FileRow[] = [];
  // Stat in bounded parallel batches: result cardinality is unlimited, concurrent filesystem
  // pressure is not. This is materially faster on large repositories without descriptor floods.
  for (let start = 0; start < files.length; start += STAT_CONCURRENCY) {
    const batch = files.slice(start, start + STAT_CONCURRENCY);
    const found = await Promise.all(batch.map(async (rel) => {
      const stat = await fs.stat(path.join(dir, ...rel.split('/'))).catch(() => undefined);
      return stat?.isFile() ? { rel, size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
    }));
    for (const row of found) if (row) rows.push(row);
  }
  return rows;
}

async function manifest(dir: string, name: string): Promise<string | undefined> {
  try {
    const file = path.join(dir, name);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined;
    return fs.readFile(file, 'utf8');
  } catch { return undefined; }
}

interface StackInfo { ecosystem: string; packageManager?: string; frameworks: string[]; scripts: Record<string, string>; dependencies: string[]; notes: string[] }

async function detectStack(dir: string, files: Set<string>): Promise<StackInfo> {
  const info: StackInfo = { ecosystem: 'unknown', frameworks: [], scripts: {}, dependencies: [], notes: [] };
  const pkgText = await manifest(dir, 'package.json');
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { packageManager?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown };
      info.ecosystem = 'node';
      info.packageManager = pkg.packageManager?.split('@')[0] ?? (files.has('bun.lock') || files.has('bun.lockb') ? 'bun' : files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : 'npm');
      info.scripts = pkg.scripts ?? {};
      const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
      const map: Array<[string, string]> = [['react', 'React'], ['next', 'Next.js'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['@angular/core', 'Angular'], ['express', 'Express'], ['fastify', 'Fastify'], ['@nestjs/core', 'NestJS'], ['astro', 'Astro'], ['electron', 'Electron'], ['hono', 'Hono'], ['vite', 'Vite'], ['typescript', 'TypeScript'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['playwright', 'Playwright']];
      for (const [dep, label] of map) if (deps.has(dep) && !info.frameworks.includes(label)) info.frameworks.push(label);
      info.dependencies = [...deps].slice(0, 50);
      if (pkg.workspaces) info.notes.push('workspace/monorepo manifest');
      return info;
    } catch { info.notes.push('package.json is not valid JSON'); }
  }
  const pyproject = await manifest(dir, 'pyproject.toml');
  if (pyproject || files.has('requirements.txt')) {
    info.ecosystem = 'python';
    const text = `${pyproject ?? ''}\n${await manifest(dir, 'requirements.txt') ?? ''}`.toLowerCase();
    for (const [needle, label] of [['fastapi', 'FastAPI'], ['django', 'Django'], ['flask', 'Flask'], ['pytest', 'pytest'], ['pydantic', 'Pydantic']] as Array<[string, string]>) if (text.includes(needle)) info.frameworks.push(label);
    return info;
  }
  if (files.has('Cargo.toml')) { info.ecosystem = 'rust'; return info; }
  if (files.has('go.mod')) { info.ecosystem = 'go'; return info; }
  if (files.has('pom.xml')) { info.ecosystem = 'java/maven'; return info; }
  return info;
}

function renderTree(files: string[], depth: number, maxEntries: number): { lines: string[]; truncated: boolean } {
  const seen = new Set<string>();
  const lines: string[] = [];
  let truncated = false;
  for (const file of files.sort()) {
    const parts = file.split('/');
    if (parts.length > depth) continue;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      if (lines.length >= maxEntries) { truncated = true; return { lines, truncated }; }
      lines.push(`${'  '.repeat(i)}${parts[i]}${i < parts.length - 1 ? '/' : ''}`);
    }
  }
  return { lines, truncated };
}

function extensionStats(rows: FileRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const ext = path.extname(row.rel).toLowerCase() || '(none)';
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, count]) => `${ext}:${count}`).join(', ');
}

async function toolchain(dir: string): Promise<string> {
  const probes: Array<[string, string[]]> = [['node', ['--version']], ['npm', ['--version']], ['pnpm', ['--version']], ['yarn', ['--version']], ['bun', ['--version']], ['python', ['--version']], ['py', ['--version']], ['go', ['version']], ['rustc', ['--version']], ['cargo', ['--version']], ['git', ['--version']]];
  const rows = await Promise.all(probes.map(async ([bin, args]) => {
    const result = await run(bin, args, dir, 2500);
    return result.code === 0 ? `  <runtime name="${bin}" version="${xml(result.stdout.trim().split(/\r?\n/)[0])}" />` : undefined;
  }));
  return `<toolchain>\n${rows.filter(Boolean).join('\n')}\n</toolchain>`;
}

export async function projectTool(roots: readonly Root[], input: ProjectInput, gitAllowed: boolean) {
  const target = input.path ?? input.workdir;
  const dir = await resolveDirectory(roots, target);
  const action = input.action ?? 'snapshot';
  if (action === 'toolchain') return ok(await toolchain(dir.real), { action, path: dir.virtual });

  const gitRoot = gitAllowed ? await findGitRoot(dir.real, dir.root.path) : undefined;
  const names = (gitRoot ? await gitFiles(dir.real, gitRoot) : undefined) ?? await walkFiles(dir.real);
  const rows = await fileRows(dir.real, names);

  if (action === 'recent') {
    const count = Math.max(input.recent ?? 15, 1);
    const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
    const now = Date.now();
    const ordered = [...rows].sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recent = ordered.slice(offset, offset + count);
    const nextOffset = offset + recent.length < ordered.length ? offset + recent.length : null;
    const output = [
      `<project-recent path="${xml(dir.virtual)}" count="${recent.length}" total="${ordered.length}" offset="${offset}">`,
      ...recent.map((row) => {
        const age = Math.max(0, now - row.mtimeMs);
        const label = age < 60_000 ? `${Math.round(age / 1000)}s` : age < 3_600_000 ? `${Math.round(age / 60_000)}m` : age < 86_400_000 ? `${Math.round(age / 3_600_000)}h` : `${Math.round(age / 86_400_000)}d`;
        return `  <file path="${xml(row.rel)}" age="${label}" size="${row.size}" />`;
      }),
      ...(nextOffset === null ? [] : [`  <next offset="${nextOffset}" />`]),
      '</project-recent>'
    ].join('\n');
    const bounded = truncateUtf8(output, MAX_MODEL_OUTPUT_BYTES);
    return ok(bounded.text, { action, path: dir.virtual, recent: recent.length, files: rows.length, offset, nextOffset, truncated: bounded.truncated || nextOffset !== null });
  }

  const tier = action === 'summary' ? 'summary' : input.tier ?? 'summary';
  const stack = await detectStack(dir.real, new Set(names));
  const totalBytes = rows.reduce((sum, row) => sum + row.size, 0);
  const entries = ENTRY_NAMES.filter((name) => names.includes(name));
  const ci = names.filter((name) => name.startsWith('.github/workflows/') || /(^|\/)(azure-pipelines\.yml|\.gitlab-ci\.yml)$/.test(name));
  const configs = names.filter((name) => /(^|\/)(tsconfig[^/]*\.json|vite\.config\.|vitest\.config\.|jest\.config\.|eslint\.config\.|pyproject\.toml|Cargo\.toml|go\.mod)/.test(name));
  const gitStatus = gitRoot ? await run('git', ['status', '--short', '--branch', '--untracked-files=normal'], gitRoot, 3000) : undefined;
  const scripts = Object.entries(stack.scripts).slice(0, tier === 'full' ? 40 : 12);
  const output: string[] = [
    `<project path="${xml(dir.virtual)}" tier="${tier}" files="${rows.length}" bytes="${totalBytes}" git="${Boolean(gitRoot)}">`,
    `  <stack ecosystem="${xml(stack.ecosystem)}" packageManager="${xml(stack.packageManager ?? '')}" frameworks="${xml(stack.frameworks.join(', '))}" />`,
    `  <stats size="${humanSize(totalBytes)}" extensions="${xml(extensionStats(rows))}" />`,
    ...(entries.length ? [`  <entrypoints>${entries.map((entry) => `<file>${xml(entry)}</file>`).join('')}</entrypoints>`] : []),
    ...(scripts.length ? ['  <scripts>', ...scripts.map(([name, command]) => `    <script name="${xml(name)}">${xml(tier === 'full' ? command.slice(0, 200) : command.slice(0, 100))}</script>`), '  </scripts>'] : []),
    ...(ci.length ? [`  <ci>${ci.map((file) => `<file>${xml(file)}</file>`).join('')}</ci>`] : []),
    ...(tier === 'full' && configs.length ? [`  <configs>${configs.map((file) => `<file>${xml(file)}</file>`).join('')}</configs>`] : []),
    ...(stack.notes.length ? stack.notes.map((note) => `  <note>${xml(note)}</note>`) : [])
  ];
  if (gitStatus?.stdout.trim()) output.push(`  <git-status>\n${xml(gitStatus.stdout.trim().split(/\r?\n/).slice(0, 80).join('\n'))}\n  </git-status>`);
  if (tier === 'structure' || tier === 'full') {
    const depth = Math.max(input.depth ?? 3, 1);
    const maxEntries = Math.max(input.maxEntries ?? 200, 1);
    const tree = renderTree(names, depth, maxEntries);
    output.push(`  <tree depth="${depth}" truncated="${tree.truncated}">`, ...tree.lines.map((line) => `    ${xml(line)}`), '  </tree>');
  }
  output.push('</project>');
  const rendered = truncateUtf8(output.join('\n'), MAX_MODEL_OUTPUT_BYTES);
  return ok(rendered.text + (rendered.truncated ? '\n<note>Project rendering truncated by the model-output budget; use find/read for exact detail.</note>' : ''), { action: 'snapshot', tier, path: dir.virtual, files: rows.length, truncated: rendered.truncated });
}
