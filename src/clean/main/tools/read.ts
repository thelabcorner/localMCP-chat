import { createReadStream, promises as fs } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { MAX_MODEL_OUTPUT_BYTES, ok, readCache, resolveToolPath, truncateUtf8 } from './common.js';

const DEFAULT_LIMIT = 2000;
const DEFAULT_TAIL = 80;
const MAX_LINE_CHARS = 2000;
const MAX_READ_BYTES = 50 * 1024;
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache']);

export type ReadAction = 'read' | 'tail' | 'grep' | 'around' | 'outline';

export interface ReadTarget {
  filePath: string;
  offset?: number;
  limit?: number;
  /** 1-based UTF-16 code-unit offset for continuing one unusually long line. */
  column?: number;
}

export interface ReadInput {
  filePath?: string;
  file_path?: string;
  filePaths?: string[] | string;
  reads?: ReadTarget[];
  offset?: number;
  limit?: number;
  column?: number;
  action?: ReadAction;
  pattern?: string;
  symbol?: string;
}

function lineText(value: string): string {
  return value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS)}... (line truncated)` : value;
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('offset/limit must be positive integers');
  return value;
}

async function textStat(real: string): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error('target is not a regular file');
  const handle = await fs.open(real, 'r');
  try {
    const probe = Buffer.alloc(Math.min(8192, stat.size));
    if (probe.length) await handle.read(probe, 0, probe.length, 0);
    if (probe.includes(0)) throw new Error('binary file cannot be read as text');
  } finally {
    await handle.close();
  }
  return stat;
}

async function eachLine(real: string, visit: (line: string, lineNo: number) => boolean | void): Promise<number> {
  const input = createReadStream(real, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo++;
      if (visit(line, lineNo) === false) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return lineNo;
}

function appendBounded(rows: string[], row: string, bytes: { value: number }, maxBytes = MAX_READ_BYTES): boolean {
  const size = Buffer.byteLength(row, 'utf8') + (rows.length ? 1 : 0);
  if (bytes.value + size > maxBytes) return false;
  rows.push(row);
  bytes.value += size;
  return true;
}

async function streamWindow(real: string, virtual: string, offset: number, limit: number, tail = false, column = 1): Promise<string> {
  const requested = offset;
  const rows: Array<{ n: number; text: string }> = [];
  const bytes = { value: 0 };
  let truncated = false;
  let total = 0;
  let continuation: { line: number; column: number } | null = null;
  if (tail) {
    // Keep only a response-sized rolling tail. A caller can request an enormous line count
    // without making the connector retain an enormous file in memory.
    await eachLine(real, (line, lineNo) => {
      total = lineNo;
      const rendered = `${lineNo}: ${lineText(line)}`;
      const size = Buffer.byteLength(rendered, 'utf8') + 1;
      rows.push({ n: lineNo, text: rendered });
      bytes.value += size;
      while (rows.length > limit || bytes.value > MAX_READ_BYTES) {
        const removed = rows.shift();
        if (!removed) break;
        bytes.value -= Buffer.byteLength(removed.text, 'utf8') + 1;
        truncated = true;
      }
    });
  } else {
    await eachLine(real, (line, lineNo) => {
      total = lineNo;
      if (lineNo < offset) return;
      if (rows.length >= limit) { truncated = true; return false; }
      const lineColumn = lineNo === offset ? column : 1;
      const source = line.slice(lineColumn - 1);
      const prefix = `${lineNo}: `;
      const separatorBytes = rows.length ? 1 : 0;
      const available = Math.max(0, MAX_READ_BYTES - bytes.value - separatorBytes - Buffer.byteLength(prefix, 'utf8'));
      const bounded = truncateUtf8(source, available);
      const rendered = `${prefix}${bounded.text}`;
      const size = Buffer.byteLength(rendered, 'utf8') + separatorBytes;
      if (size > MAX_READ_BYTES - bytes.value) { truncated = true; return false; }
      rows.push({ n: lineNo, text: rendered });
      bytes.value += size;
      if (bounded.truncated) {
        continuation = { line: lineNo, column: lineColumn + bounded.text.length };
        truncated = true;
        return false;
      }
      return undefined;
    });
  }
  if (!total && !rows.length) return `<file path="${virtual}" lines="0">\n<content>\n(End of file - empty)\n</content>\n</file>`;
  const start = rows[0]?.n ?? requested;
  const end = rows.at(-1)?.n ?? Math.max(0, total);
  const body = rows.map((row) => row.text).join('\n');
  // TypeScript cannot see assignments performed inside the async line-visitor callback.
  const lineContinuation = continuation as { line: number; column: number } | null;
  const note = tail
    ? rows.length
      ? `showing tail lines ${start}-${end} of ${total}; use action=read with an earlier offset for preceding content`
      : `end of file; ${total} lines`
    : rows.length === 0 && requested > total
      ? `offset ${requested} is past EOF; file has ${total} lines`
      : lineContinuation
        ? `line ${lineContinuation.line} continues; use offset=${lineContinuation.line}, column=${lineContinuation.column}, limit=1`
      : truncated
        ? `showing lines ${start}-${end}; output is bounded, continue from offset ${end + 1}`
        : `end of file; ${total} lines`;
  return `<file path="${virtual}" lines="${truncated ? `>=${total}` : total}">\n<content>\n${body}\n\n(${note})\n</content>\n</file>`;
}

async function outline(real: string, virtual: string, offset: number, limit: number): Promise<string> {
  const patterns = [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
    /^\s*class\s+([A-Za-z_]\w*)\b/,
    /^\s*(?:public|private|protected|static|final|abstract|async|virtual|override|inline|constexpr|extern|const\s+)*[\w:<>,\[\]?*&]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>)?\s*$/
  ];
  const hits: string[] = [];
  const bytes = { value: 0 };
  let matched = 0;
  let truncated = false;
  await eachLine(real, (line, lineNo) => {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      matched++;
      if (matched < offset) break;
      if (hits.length >= limit || !appendBounded(hits, `${lineNo}: ${match[1]}  ${lineText(line.trim())}`, bytes)) {
        truncated = true;
        return false;
      }
      break;
    }
    return undefined;
  });
  return `<outline path="${virtual}" entries="${hits.length}" offset="${offset}" truncated="${truncated}">\n${hits.join('\n') || '(no declarations recognized)'}\n${truncated ? `Continue with offset=${offset + hits.length}.\n` : ''}</outline>`;
}

async function grepFile(real: string, virtual: string, pattern: string, offset: number, limit: number): Promise<string> {
  if (!pattern) throw new Error('grep requires pattern');
  let re: RegExp;
  try { re = new RegExp(pattern, 'i'); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
  const hits: string[] = [];
  const bytes = { value: 0 };
  let matched = 0;
  let truncated = false;
  await eachLine(real, (line, lineNo) => {
    re.lastIndex = 0;
    if (!re.test(line)) return;
    matched++;
    if (matched < offset) return;
    if (hits.length >= limit || !appendBounded(hits, `${lineNo}: ${lineText(line.trimEnd())}`, bytes)) {
      truncated = true;
      return false;
    }
  });
  return `<grep path="${virtual}" matches="${hits.length}" offset="${offset}" truncated="${truncated}">\n${hits.join('\n') || '(no matches)'}\n${truncated ? `Continue with offset=${offset + hits.length}.\n` : ''}</grep>`;
}

async function around(real: string, virtual: string, symbol: string, limit: number): Promise<string> {
  if (!symbol) throw new Error('around requires symbol');
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`\\b(?:function|class|interface|type|enum|namespace|def|const|let|var)\\s+${escaped}\\b`, 'i');
  let found = 0;
  await eachLine(real, (line, lineNo) => {
    declaration.lastIndex = 0;
    if (!declaration.test(line)) return;
    found = lineNo;
    return false;
  });
  if (!found) {
    await eachLine(real, (line, lineNo) => {
      if (!line.includes(symbol)) return;
      found = lineNo;
      return false;
    });
  }
  if (!found) throw new Error(`symbol ${JSON.stringify(symbol)} was not found in ${virtual}`);
  const window = Math.min(Math.max(limit, 10), 200);
  const offset = Math.max(1, found - Math.floor(window / 3));
  return streamWindow(real, virtual, offset, window);
}

async function renderTarget(roots: readonly Root[], target: ReadTarget, action: ReadAction, pattern?: string, symbol?: string): Promise<string> {
  const resolved = await resolveToolPath(roots, target.filePath);
  const stat = await fs.stat(resolved.real);
  if (stat.isDirectory()) {
    const entries = (await fs.readdir(resolved.real, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    const offset = positive(target.offset, 1);
    const limit = positive(target.limit, DEFAULT_LIMIT);
    const page = entries.slice(offset - 1, offset - 1 + limit);
    const list = page
      .map((entry) => `${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'} ${entry.name}${entry.isDirectory() ? '/' : ''}`);
    const next = offset - 1 + page.length < entries.length ? offset + page.length : null;
    return `<directory path="${resolved.virtual}" entries="${entries.length}" offset="${offset}" truncated="${next !== null}">\n${list.join('\n')}\n${next === null ? '' : `Continue with offset=${next}.\n`}</directory>`;
  }
  const fileStat = await textStat(resolved.real);
  readCache.record(resolved.real, { mtimeMs: Number(fileStat.mtimeMs), size: Number(fileStat.size) });
  const limit = positive(target.limit, action === 'tail' ? DEFAULT_TAIL : DEFAULT_LIMIT);
  const offset = positive(target.offset, 1);
  const column = positive(target.column, 1);
  if (column !== 1 && action !== 'read') throw new Error('column is supported only for action=read');
  if (column !== 1 && limit !== 1) throw new Error('column continuation requires limit=1');
  if (action === 'outline') return outline(resolved.real, resolved.virtual, offset, limit);
  if (action === 'grep') return grepFile(resolved.real, resolved.virtual, pattern ?? symbol ?? '', offset, limit);
  if (action === 'around') return around(resolved.real, resolved.virtual, symbol ?? pattern ?? '', limit);
  if (action === 'tail') return streamWindow(resolved.real, resolved.virtual, 1, limit, true);
  return streamWindow(resolved.real, resolved.virtual, offset, limit, false, column);
}

function coercePaths(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  const text = value.trim();
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error('filePaths JSON must be an array of strings');
    return parsed;
  }
  return [value];
}

export async function readTool(roots: readonly Root[], input: ReadInput) {
  const single = input.filePath ?? input.file_path;
  const pathways = Number(single !== undefined) + Number(input.filePaths !== undefined) + Number(input.reads !== undefined);
  if (pathways !== 1) throw new Error('Choose exactly one of filePath, filePaths, or reads');
  const action: ReadAction = input.action ?? (input.pattern ? 'grep' : input.symbol ? 'around' : 'read');
  let targets: ReadTarget[];
  if (input.reads) {
    if (input.offset !== undefined || input.limit !== undefined || input.column !== undefined) throw new Error('reads[] carries its own offset/limit/column; do not combine with top-level values');
    targets = input.reads;
  } else if (input.filePaths !== undefined) {
    targets = coercePaths(input.filePaths).map((filePath) => ({ filePath, offset: input.offset, limit: input.limit, column: input.column }));
  } else {
    targets = [{ filePath: single!, offset: input.offset, limit: input.limit, column: input.column }];
  }
  if (targets.length < 1) throw new Error('read requires at least one target');
  if (targets.length > 1 && action !== 'read') throw new Error('outline/grep/around/tail are single-target operations; batch only plain read windows');
  const blocks: string[] = [];
  for (const target of targets) blocks.push(await renderTarget(roots, target, action, input.pattern, input.symbol));
  const joined = blocks.join('\n\n');
  const bounded = truncateUtf8(joined, 128 * 1024);
  return ok(bounded.text + (bounded.truncated ? '\n\n<note>aggregate read output truncated; narrow the request</note>' : ''), {
    targets: targets.length,
    action,
    truncated: bounded.truncated
  });
}

export interface FindInput {
  query: string;
  path?: string;
  mode?: 'name' | 'text' | 'both';
  regex?: boolean;
  caseSensitive?: boolean;
  include?: string;
  maxResults?: number;
  offset?: number;
}

function globRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export async function findTool(roots: readonly Root[], input: FindInput) {
  if (!input.query || input.query.length > 2048) throw new Error('query must be 1-2048 characters');
  const mode = input.mode ?? 'both';
  const maxResults = Math.max(input.maxResults ?? 80, 1);
  const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
  const base = await resolveToolPath(roots, input.path ?? (roots.length === 1 ? `/${roots[0]!.name}` : ''));
  const rootStat = await fs.stat(base.real);
  if (!rootStat.isDirectory()) throw new Error('find path must be a directory');
  let matcher: (text: string) => number;
  if (input.regex) {
    const regex = new RegExp(input.query, input.caseSensitive ? '' : 'i');
    matcher = (text) => { regex.lastIndex = 0; const match = regex.exec(text); return match?.index ?? -1; };
  } else {
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    matcher = (text) => (input.caseSensitive ? text : text.toLocaleLowerCase()).indexOf(needle);
  }
  const include = input.include ? globRegex(input.include) : null;
  const stack = [base.real];
  const results: string[] = [];
  let files = 0;
  let dirs = 0;
  let truncated = false;
  let outputBytes = 0;
  let seenMatches = 0;
  const addMatch = (row: string): boolean => {
    const matchIndex = seenMatches++;
    if (matchIndex < offset) return true;
    const size = Buffer.byteLength(row, 'utf8') + (results.length ? 1 : 0);
    if (results.length >= maxResults || outputBytes + size > MAX_MODEL_OUTPUT_BYTES) {
      truncated = true;
      return false;
    }
    results.push(row);
    outputBytes += size;
    return true;
  };
  outer: while (stack.length) {
    const dir = stack.pop()!;
    dirs++;
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const candidate = path.join(dir, entry.name);
      let resolved;
      try { resolved = await resolveToolPath(roots, candidate); } catch { continue; }
      if (entry.isDirectory()) {
        stack.push(resolved.real);
        if ((mode === 'name' || mode === 'both') && matcher(entry.name) >= 0) {
          const row = `${resolved.virtual}/`;
          if (!addMatch(row)) break outer;
        }
        continue;
      }
      if (!entry.isFile() || (include && !include.test(entry.name))) continue;
      files++;
      if ((mode === 'name' || mode === 'both') && matcher(entry.name) >= 0) {
        if (!addMatch(resolved.virtual)) break outer;
      }
      if (mode === 'name') continue;
      try { await textStat(resolved.real); } catch { continue; }
      await eachLine(resolved.real, (line, lineNo) => {
        const column = matcher(line);
        if (column < 0) return;
        const row = `${resolved.virtual}:${lineNo}:${column + 1}: ${lineText(line.trim())}`;
        if (!addMatch(row)) return false;
      });
      if (truncated) break outer;
    }
  }
  const nextOffset = truncated ? offset + results.length : null;
  return ok(
    `${results.join('\n') || '(no matches)'}${nextOffset === null ? '' : `\n<next offset="${nextOffset}" />`}`,
    { results: results.length, offset, nextOffset, filesScanned: files, directoriesScanned: dirs, truncated }
  );
}
