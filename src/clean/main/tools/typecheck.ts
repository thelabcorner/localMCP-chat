import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import ts from 'typescript-compiler';
import type { Root } from '../../../shared/types.js';
import { childEnv, terminateProcessTree } from '../../../main/exec.js';
import { isContained } from '../../../main/sandbox.js';
import { ok, resolveDirectory, resolveToolPath } from './common.js';

export interface TypecheckInput {
  mode?: 'file' | 'files' | 'folder' | 'changed' | 'bottomUp' | 'full' | 'explain';
  workdir?: string;
  filePath?: string;
  files?: string[];
  folder?: string;
  tsconfig?: string;
  maxErrors?: number;
  errorOffset?: number;
  maxFiles?: number;
  includeTests?: boolean;
  includeUntracked?: boolean;
  reason?: string;
}

type Severity = 'P0' | 'P1' | 'P2' | 'P3';
interface DiagnosticRow {
  file: string;
  line: number;
  column: number;
  code: number;
  category: string;
  severity: Severity;
  message: string;
  suggestion: string;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', '.git', '__pycache__', '.cache', 'out', 'release']);
const CATEGORY: Record<number, string> = {
  2307: 'import-resolution', 6142: 'import-resolution', 1259: 'import-resolution',
  2322: 'type-mismatch', 2345: 'type-mismatch', 2769: 'type-mismatch',
  2305: 'missing-export', 2448: 'missing-export', 2304: 'undeclared', 2552: 'undeclared',
  2531: 'null-undefined', 2532: 'null-undefined', 18047: 'null-undefined',
  17004: 'jsx-config', 6133: 'unused', 6196: 'unused', 1005: 'syntax', 1109: 'syntax'
};
const SEVERITY: Record<string, Severity> = {
  'import-resolution': 'P2', 'type-mismatch': 'P1', 'missing-export': 'P1', undeclared: 'P0',
  'null-undefined': 'P1', 'jsx-config': 'P2', unused: 'P3', syntax: 'P0'
};
const SUGGESTION: Record<number, string> = {
  2307: "Cannot find module. Check the import path, dependency installation, and tsconfig path aliases.",
  6142: 'Module resolved but type declarations are missing. Install the matching types package or add a declaration file.',
  1259: "Check CommonJS/default-import interop settings such as esModuleInterop or allowSyntheticDefaultImports.",
  2322: "Type is not assignable. Compare the expected declaration type with the value's inferred type.",
  2345: "Argument is not assignable to the parameter. Compare the parameter and argument types.",
  2769: 'No overload matches this call. Check the arguments against each overload signature.',
  2305: 'Module has no exported member. Confirm the export exists and its exact spelling.',
  2448: 'Block-scoped variable is used before declaration. Move the use after its declaration.',
  2304: 'Cannot find name. Declare it or import it.',
  2552: 'Cannot find name. Check the compiler suggestion and imports.',
  2531: 'Object is possibly null. Narrow with a guard or optional chaining.',
  2532: 'Object is possibly undefined. Narrow with a guard or optional chaining.',
  18047: 'Value may be undefined under strict checking. Guard the access or assert non-null.',
  17004: "JSX is used but compilerOptions.jsx is not configured.",
  6133: 'Declared but never used. Remove it or use the value.',
  6196: 'Declared but never used. Remove it or use the declaration.',
  1005: 'Syntax error. Check the surrounding statement structure.',
  1109: 'Expression expected. Check expression placement and punctuation.'
};
const GENERIC_SUGGESTION = 'Review the flagged location and surrounding declaration to resolve the diagnostic.';
const PACKAGED_COMPILER_LIB_DIR = 'typescript-compiler-lib';
const COMPILER_LIB_SENTINELS = ['lib.d.ts', 'lib.es5.d.ts', 'lib.dom.d.ts', 'lib.esnext.full.d.ts'] as const;

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function explain(code: number): { category: string; severity: Severity; suggestion: string } {
  const category = CATEGORY[code] ?? 'other';
  return { category, severity: SEVERITY[category] ?? 'P3', suggestion: SUGGESTION[code] ?? GENERIC_SUGGESTION };
}

function isTsFile(file: string): boolean {
  const lower = file.toLowerCase();
  return lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts') || lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs');
}

function scriptKindFor(file: string): ts.ScriptKind {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (['.js', '.mjs', '.cjs'].includes(ext)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function ensureUnder(base: string, file: string, label: string): void {
  if (!isContained(base, file)) throw new Error(`${label} is outside the selected workdir: ${file}`);
}

async function walkSourceFiles(dir: string, max: number, includeTests: boolean): Promise<string[]> {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < max) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [] as import('node:fs').Dirent[]);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !isTsFile(entry.name)) continue;
      if (!includeTests && /(?:^|\.)(?:test|spec)\.[^.]+$/i.test(entry.name)) continue;
      out.push(full);
      if (out.length >= max) break;
    }
  }
  return out;
}

async function runGit(args: string[], cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('git', ['--no-pager', '--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
      cwd, env: { ...childEnv(), GIT_TERMINAL_PROMPT: '0' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore']
    });
    const out: Buffer[] = [];
    const timer = setTimeout(() => { if (child.pid) void terminateProcessTree(child.pid, true); }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.once('error', () => { clearTimeout(timer); resolve([]); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve([]); return; }
      resolve(Buffer.concat(out).toString('utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function findGitRoot(dir: string): Promise<string | undefined> {
  const lines = await runGit(['rev-parse', '--show-toplevel'], dir);
  return lines[0] ? path.resolve(lines[0]) : undefined;
}

async function findNearestTsconfig(from: string, stop: string): Promise<string | undefined> {
  let current = path.resolve(from);
  const boundary = path.resolve(stop);
  while (isContained(boundary, current)) {
    const names = await fs.readdir(current).catch(() => [] as string[]);
    const preferred = names.find((name) => name === 'tsconfig.json') ?? names.find((name) => /^tsconfig.*\.json$/i.test(name));
    if (preferred) return path.join(current, preferred);
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function defaultCompilerLibCandidates(): string[] {
  const candidates = [path.dirname(ts.getDefaultLibFilePath({}))];
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, PACKAGED_COMPILER_LIB_DIR));
  return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

function hasCompleteCompilerLib(dir: string): boolean {
  try {
    return COMPILER_LIB_SENTINELS.every((name) => fsSync.statSync(path.join(dir, name)).isFile());
  } catch {
    return false;
  }
}

export function resolveCompilerLibDir(candidates: readonly string[] = defaultCompilerLibCandidates()): string {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (hasCompleteCompilerLib(resolved)) return resolved;
  }
  const searched = candidates.map((candidate) => path.resolve(candidate)).join(', ') || '(none)';
  throw new Error(
    `TypeScript standard library is unavailable. Searched: ${searched}. ` +
    `The packaged localMCP-chat runtime must include ${PACKAGED_COMPILER_LIB_DIR}/lib*.d.ts.`
  );
}

export function remapCompilerLibPath(file: string, runtimeCompilerLib: string, compilerLib: string): string {
  const resolvedFile = path.resolve(file);
  const runtimeDir = normalizeForCompare(runtimeCompilerLib);
  if (normalizeForCompare(path.dirname(resolvedFile)) !== runtimeDir) return file;
  const name = path.basename(resolvedFile);
  if (!/^lib(?:\..+)?\.d\.ts$/i.test(name)) return file;
  return path.join(compilerLib, name);
}

function safeCompilerContext(roots: readonly Root[], compilerLib: string) {
  const allowedRoots = roots.map((root) => normalizeForCompare(root.path));
  const lib = normalizeForCompare(compilerLib);
  const lexicalAllowed = (value: string) => {
    const normalized = normalizeForCompare(value);
    return normalized === lib || normalized.startsWith(`${lib}${path.sep}`) || allowedRoots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
  };
  const realAllowed = (value: string) => {
    if (!lexicalAllowed(value)) return false;
    try {
      const real = normalizeForCompare(fsSync.realpathSync.native(value));
      return real === lib || real.startsWith(`${lib}${path.sep}`) || allowedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
    } catch {
      return lexicalAllowed(value);
    }
  };
  const readFile = (file: string): string | undefined => realAllowed(file) ? ts.sys.readFile(file) : undefined;
  const fileExists = (file: string): boolean => realAllowed(file) && ts.sys.fileExists(file);
  const directoryExists = (dir: string): boolean => realAllowed(dir) && Boolean(ts.sys.directoryExists?.(dir));
  const realpath = (value: string): string => realAllowed(value) ? (ts.sys.realpath?.(value) ?? value) : value;
  const getFileSystemEntries = (dir: string): { files: string[]; directories: string[] } => {
    if (!realAllowed(dir)) return { files: [], directories: [] };
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (!realAllowed(full)) continue;
      if (entry.isDirectory()) directories.push(entry.name);
      else if (entry.isFile()) files.push(entry.name);
    }
    return { files, directories };
  };
  const readDirectory = (rootDir: string, extensions?: readonly string[], excludes?: readonly string[], includes?: readonly string[], depth?: number): string[] => {
    if (!realAllowed(rootDir)) return [];
    const matchFiles = (ts as unknown as { matchFiles: (...args: unknown[]) => string[] }).matchFiles;
    return matchFiles(rootDir, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, rootDir, depth, getFileSystemEntries, realpath).filter(realAllowed);
  };
  return { realAllowed, readFile, fileExists, directoryExists, realpath, readDirectory, getFileSystemEntries };
}

function configOptions(configPath: string, safe: ReturnType<typeof safeCompilerContext>): { options: ts.CompilerOptions; files: string[]; errors: readonly ts.Diagnostic[] } {
  const text = safe.readFile(configPath);
  if (text === undefined) throw new Error(`Cannot read tsconfig inside approved roots: ${configPath}`);
  const parsedText = ts.parseConfigFileTextToJson(configPath, text);
  if (parsedText.error) return { options: {}, files: [], errors: [parsedText.error] };
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: safe.fileExists,
    readDirectory: safe.readDirectory,
    readFile: safe.readFile
  };
  const parsed = ts.parseJsonConfigFileContent(parsedText.config, host, path.dirname(configPath), undefined, configPath);
  return { options: parsed.options, files: parsed.fileNames.filter(safe.realAllowed), errors: parsed.errors };
}

function compilerHost(options: ts.CompilerOptions, safe: ReturnType<typeof safeCompilerContext>, compilerLib: string): { host: ts.CompilerHost; accessed: Set<string> } {
  const base = ts.createCompilerHost(options, true);
  const accessed = new Set<string>();
  const runtimeCompilerLib = path.dirname(ts.getDefaultLibFilePath(options));
  const mapCompilerPath = (file: string) => remapCompilerLibPath(file, runtimeCompilerLib, compilerLib);
  const mapCompilerDirectory = (dir: string) => normalizeForCompare(dir) === normalizeForCompare(runtimeCompilerLib) ? compilerLib : dir;
  const allowSource = (file: string) => {
    const mapped = mapCompilerPath(file);
    if (!safe.realAllowed(mapped)) return false;
    const normalized = normalizeForCompare(mapped);
    accessed.add(normalized);
    return true;
  };
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (file) => safe.fileExists(mapCompilerPath(file)),
    readFile: (file) => safe.readFile(mapCompilerPath(file)),
    directoryExists: (dir) => safe.directoryExists(mapCompilerDirectory(dir)),
    getDirectories: (dir) => {
      const mapped = mapCompilerDirectory(dir);
      return safe.getFileSystemEntries(mapped).directories.map((name) => path.join(mapped, name));
    },
    realpath: (file) => safe.realpath(mapCompilerPath(file)),
    // TypeScript resolves an explicit compilerOptions.lib (for example ["ES2023", "DOM"])
    // relative to getDefaultLibLocation(), not getDefaultLibFileName(). In a packaged Electron
    // build the compiler JS remains inside app.asar while electron-builder deliberately prunes
    // its .d.ts files, so both hooks must point at the complete extraResources stdlib copy.
    getDefaultLibLocation: () => compilerLib,
    getDefaultLibFileName: (compilerOptions) => path.join(compilerLib, ts.getDefaultLibFileName(compilerOptions)),
    getSourceFile: (fileName, languageVersion, _onError, _shouldCreateNewSourceFile) => {
      if (!allowSource(fileName)) return undefined;
      const text = safe.readFile(mapCompilerPath(fileName));
      if (text === undefined) return undefined;
      return ts.createSourceFile(fileName, text, languageVersion, true, scriptKindFor(fileName));
    },
    writeFile: () => undefined
  };
  return { host, accessed };
}

function formatDiagnostic(diag: ts.Diagnostic, workdir: string): DiagnosticRow | undefined {
  if (diag.category !== ts.DiagnosticCategory.Error && diag.category !== ts.DiagnosticCategory.Warning) return undefined;
  const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
  const info = explain(diag.code);
  let file = '';
  let line = 0;
  let column = 0;
  if (diag.file && diag.start !== undefined) {
    const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
    file = path.relative(workdir, diag.file.fileName).split(path.sep).join('/');
    line = pos.line + 1;
    column = pos.character + 1;
  }
  return { file, line, column, code: diag.code, category: info.category, severity: info.severity, message, suggestion: info.suggestion };
}

function clusters(rows: DiagnosticRow[]) {
  const order: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const map = new Map<string, { code: number; severity: Severity; category: string; files: Set<string>; count: number }>();
  for (const row of rows) {
    const key = `${row.code}:${row.message.replace(/\s+/g, ' ').trim()}`;
    const current = map.get(key);
    if (current) { current.count++; current.files.add(row.file); }
    else map.set(key, { code: row.code, severity: row.severity, category: row.category, files: new Set([row.file]), count: 1 });
  }
  return [...map.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

async function resolveScope(roots: readonly Root[], workdir: string, mode: NonNullable<TypecheckInput['mode']>, input: TypecheckInput, maxFiles: number): Promise<string[]> {
  const resolveFile = async (value: string) => {
    const absoluteLike = value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
    const resolved = absoluteLike ? await resolveToolPath(roots, value) : await resolveToolPath(roots, path.resolve(workdir, value));
    ensureUnder(workdir, resolved.real, 'Typecheck file');
    return resolved.real;
  };
  if (mode === 'file') {
    if (!input.filePath) throw new Error('typecheck file mode requires filePath');
    return [await resolveFile(input.filePath)];
  }
  if (mode === 'files') {
    if (!input.files?.length) throw new Error('typecheck files mode requires files[]');
    if (input.files.length > maxFiles) throw new Error(`files[] exceeds maxFiles (${input.files.length} > ${maxFiles})`);
    return Promise.all(input.files.map(resolveFile));
  }
  if (mode === 'folder') {
    if (!input.folder) throw new Error('typecheck folder mode requires folder');
    const absoluteLike = input.folder.startsWith('/') || input.folder.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(input.folder);
    const resolved = absoluteLike ? await resolveToolPath(roots, input.folder) : await resolveToolPath(roots, path.resolve(workdir, input.folder));
    ensureUnder(workdir, resolved.real, 'Typecheck folder');
    return walkSourceFiles(resolved.real, maxFiles, input.includeTests ?? false);
  }
  if (mode === 'changed') {
    const gitRoot = await findGitRoot(workdir);
    if (!gitRoot || !isContained(workdir, gitRoot) && !isContained(gitRoot, workdir)) throw new Error('No git worktree found for changed mode');
    const staged = await runGit(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], gitRoot);
    const unstaged = await runGit(['diff', '--name-only', '--diff-filter=ACMR'], gitRoot);
    const untracked = input.includeUntracked ? await runGit(['ls-files', '--others', '--exclude-standard'], gitRoot) : [];
    const unique = [...new Set([...staged, ...unstaged, ...untracked])]
      .map((rel) => path.join(gitRoot, ...rel.split('/')))
      .filter((file) => isContained(workdir, file) && isTsFile(file));
    return unique.slice(0, maxFiles);
  }
  if (mode === 'bottomUp') {
    const seeds = input.files?.length ? input.files : input.filePath ? [input.filePath] : [];
    if (!seeds.length) throw new Error('typecheck bottomUp mode requires filePath or files[]');
    return Promise.all(seeds.slice(0, maxFiles).map(resolveFile));
  }
  if (mode === 'full') return walkSourceFiles(workdir, maxFiles, true);
  throw new Error(`Unsupported typecheck scope mode: ${mode}`);
}

export async function typecheckTool(roots: readonly Root[], input: TypecheckInput) {
  let mode = input.mode;
  if (!mode) mode = input.filePath ? 'file' : input.files?.length ? 'files' : input.folder ? 'folder' : 'changed';
  if (mode === 'explain') {
    const codeText = input.filePath?.replace(/\D/g, '');
    const code = codeText ? Number.parseInt(codeText, 10) : NaN;
    if (!Number.isFinite(code) || code <= 0) throw new Error("typecheck explain requires a TS error code in filePath, e.g. 'TS2307'");
    const info = explain(code);
    return ok(`<typecheck-explain code="TS${code}" category="${info.category}" severity="${info.severity}">\n  <suggestion>${xml(info.suggestion)}</suggestion>\n</typecheck-explain>`, { mode, status: 'passed', errors: 0 });
  }
  const dir = await resolveDirectory(roots, input.workdir);
  const maxErrors = Math.min(Math.max(input.maxErrors ?? 80, 1), 500);
  const errorOffset = Number.isSafeInteger(input.errorOffset) && (input.errorOffset ?? 0) >= 0 ? input.errorOffset! : 0;
  const maxFiles = input.maxFiles === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.max(1, Math.floor(input.maxFiles));
  const scope = await resolveScope(roots, dir.real, mode, input, maxFiles);
  if (!scope.length) throw new Error('No files selected to typecheck');

  const explicitConfig = input.tsconfig ? await resolveToolPath(roots, input.tsconfig) : undefined;
  if (explicitConfig) ensureUnder(dir.root.path, explicitConfig.real, 'tsconfig');
  const configPath = explicitConfig?.real ?? await findNearestTsconfig(path.dirname(scope[0]!), dir.real) ?? await findNearestTsconfig(dir.real, dir.real);
  if (!configPath) throw new Error(`No tsconfig found under ${dir.virtual}`);

  const compilerLib = resolveCompilerLibDir();
  const safe = safeCompilerContext(roots, compilerLib);
  const config = configOptions(configPath, safe);
  const options: ts.CompilerOptions = { ...config.options, noEmit: true, incremental: false, composite: false };
  const rootsForProgram = mode === 'full' && config.files.length
    ? config.files.slice(0, maxFiles)
    : scope;
  const built = compilerHost(options, safe, compilerLib);
  const program = ts.createProgram({ rootNames: rootsForProgram, options, host: built.host });
  const rawDiagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  const seen = new Set<string>();
  const diagnostics: DiagnosticRow[] = [];
  for (const diagnostic of rawDiagnostics) {
    const row = formatDiagnostic(diagnostic, dir.real);
    if (!row) continue;
    const key = `${row.file}:${row.line}:${row.column}:${row.code}:${row.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push(row);
  }
  const status = diagnostics.some((row) => row.severity !== 'P3') ? 'failed' : 'passed';
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const row of diagnostics) counts[row.severity]++;
  const grouped = clusters(diagnostics);
  const shownDiagnostics = diagnostics.slice(errorOffset, errorOffset + maxErrors);
  const nextErrorOffset = errorOffset + shownDiagnostics.length < diagnostics.length ? errorOffset + shownDiagnostics.length : null;
  const relScope = rootsForProgram.slice(0, 100).map((file) => path.relative(dir.real, file).split(path.sep).join('/'));
  const output = [
    `<typecheck mode="${mode}" status="${status}" errors="${diagnostics.length}" errorOffset="${errorOffset}" truncated="${nextErrorOffset !== null}" programFiles="${built.accessed.size}">`,
    `  <scope files="${rootsForProgram.length}">`,
    ...relScope.map((file) => `    <file>${xml(file)}</file>`),
    ...(rootsForProgram.length > relScope.length ? [`    <next>${rootsForProgram.length - relScope.length} additional root files omitted</next>`] : []),
    '  </scope>',
    `  <tsconfig>${xml(path.relative(dir.real, configPath).split(path.sep).join('/'))}</tsconfig>`,
    `  <triage p0="${counts.P0}" p1="${counts.P1}" p2="${counts.P2}" p3="${counts.P3}" />`,
    '  <clusters>',
    ...grouped.slice(0, 50).map((row) => `    <cluster code="TS${row.code}" severity="${row.severity}" category="${row.category}" occurrences="${row.count}" files="${row.files.size}" />`),
    '  </clusters>',
    ...(shownDiagnostics.length ? ['  <diagnostics>', ...shownDiagnostics.map((row) => `    <diagnostic file="${xml(row.file)}" line="${row.line}" column="${row.column}" code="TS${row.code}" severity="${row.severity}" category="${row.category}">\n      <message>${xml(row.message)}</message>\n      <suggestion>${xml(row.suggestion)}</suggestion>\n    </diagnostic>`), '  </diagnostics>'] : []),
    ...(nextErrorOffset === null ? [] : [`  <continue errorOffset="${nextErrorOffset}" />`]),
    `  <next>${diagnostics.length ? `Fix P0/P1 diagnostics first (${counts.P0} P0, ${counts.P1} P1).` : 'No diagnostics detected in the selected scope.'}</next>`,
    '</typecheck>'
  ].join('\n');
  return ok(output, {
    mode,
    status,
    files: rootsForProgram.length,
    programFiles: built.accessed.size,
    errors: diagnostics.length,
    shownErrors: shownDiagnostics.length,
    errorOffset,
    nextErrorOffset,
    truncated: nextErrorOffset !== null,
    tsconfig: path.relative(dir.real, configPath).split(path.sep).join('/')
  });
}
