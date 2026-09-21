import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { ok, readCache, resolveToolPath } from './common.js';

type ExactBatchOp = { oldString: string; newString: string };
type LineBatchOp = { line: number; newText: string; oldText?: string };
type RangeBatchOp = { startLine: number; endLine: number; newText?: string; oldText?: string; delete?: boolean };
export type BatchEditOp = ExactBatchOp | LineBatchOp | RangeBatchOp;

export interface EditInput {
  filePath?: string;
  file_path?: string;
  oldString?: string;
  newString?: string;
  newText?: string;
  replaceAll?: boolean;
  line?: number;
  oldText?: string;
  startLine?: number;
  endLine?: number;
  insertAt?: number;
  insertAfter?: number;
  appendFile?: boolean;
  nearText?: string;
  occurrence?: number;
  delete?: boolean;
  edits?: BatchEditOp[];
}

interface LineInfo {
  start: number;
  end: number;
  eolEnd: number;
  text: string;
  eol: Eol | '';
}

interface Span {
  start: number;
  end: number;
  replacement: string;
  label: string;
}

type Eol = '\r\n' | '\n' | '\r';
interface MatchRange { start: number; end: number; }

function lineTable(text: string): LineInfo[] {
  if (text === '') return [{ start: 0, end: 0, eolEnd: 0, text: '', eol: '' }];
  const out: LineInfo[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    let eol: Eol | null = null;
    let width = 0;
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') {
        eol = '\r\n';
        width = 2;
      } else {
        eol = '\r';
        width = 1;
      }
    } else if (text[i] === '\n') {
      eol = '\n';
      width = 1;
    }
    if (eol === null) continue;
    out.push({ start, end: i, eolEnd: i + width, text: text.slice(start, i), eol });
    i += width - 1;
    start = i + 1;
  }
  out.push({ start, end: text.length, eolEnd: text.length, text: text.slice(start), eol: '' });
  return out;
}

function dominantEol(lines: readonly LineInfo[]): Eol {
  const counts: Record<Eol, number> = { '\r\n': 0, '\n': 0, '\r': 0 };
  let first: Eol | null = null;
  for (const line of lines) {
    if (!line.eol) continue;
    first ??= line.eol;
    counts[line.eol] += 1;
  }
  let winner: Eol = first ?? '\n';
  for (const candidate of ['\r\n', '\n', '\r'] as const) {
    if (counts[candidate] > counts[winner]) winner = candidate;
  }
  return winner;
}

function hasMixedEols(lines: readonly LineInfo[]): boolean {
  let seen: Eol | null = null;
  for (const line of lines) {
    if (!line.eol) continue;
    if (seen === null) seen = line.eol;
    else if (line.eol !== seen) return true;
  }
  return false;
}

function canonicalEols(text: string): string {
  if (!text.includes('\r')) return text;
  return text.replace(/\r\n|\r/g, '\n');
}

function hasLineBreak(text: string): boolean {
  return text.includes('\n') || text.includes('\r');
}

function mapNormalizedRanges(source: string, starts: readonly number[], normalizedLength: number): MatchRange[] {
  const ranges: MatchRange[] = [];
  let original = 0;
  let normalized = 0;
  const advanceTo = (target: number): number => {
    while (normalized < target && original < source.length) {
      if (source[original] === '\r' && source[original + 1] === '\n') original += 2;
      else original += 1;
      normalized += 1;
    }
    if (normalized !== target) throw new Error('internal line-ending offset mapping failure');
    return original;
  };
  // findOccurrences returns sorted, non-overlapping hits, so both boundaries can be mapped in one
  // forward pass with no offset table and no O(h log h) sort for replaceAll.
  for (const start of starts) {
    const mappedStart = advanceTo(start);
    const mappedEnd = advanceTo(start + normalizedLength);
    ranges.push({ start: mappedStart, end: mappedEnd });
  }
  return ranges;
}

function equivalentOccurrences(source: string, needle: string, normalizeExistingMatches: boolean): MatchRange[] {
  if (!needle) return [];
  const raw = findOccurrences(source, needle);
  if (!hasLineBreak(needle) || (raw.length > 0 && !normalizeExistingMatches)) {
    return raw.map((start) => ({ start, end: start + needle.length }));
  }
  const normalizedNeedle = canonicalEols(needle);
  const normalizedSource = canonicalEols(source);
  const starts = findOccurrences(normalizedSource, normalizedNeedle);
  return mapNormalizedRanges(source, starts, normalizedNeedle.length);
}

function lineIndexAtOffset(lines: readonly LineInfo[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const line = lines[mid]!;
    if (offset < line.start) hi = mid - 1;
    else if (line.eol && offset >= line.eolEnd) lo = mid + 1;
    else if (!line.eol && offset > line.eolEnd) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(lines.length - 1, lo));
}

function nearestEolBefore(lines: readonly LineInfo[], index: number): Eol | null {
  for (let cursor = Math.min(index, lines.length) - 1; cursor >= 0; cursor--) {
    const eol = lines[cursor]?.eol;
    if (eol) return eol;
  }
  return null;
}

function nearestEolAfter(lines: readonly LineInfo[], index: number): Eol | null {
  for (let cursor = Math.max(0, index); cursor < lines.length; cursor++) {
    const eol = lines[cursor]?.eol;
    if (eol) return eol;
  }
  return null;
}

function preferredEolForLines(lines: readonly LineInfo[], startIndex: number, endIndex: number, fallback: Eol): Eol {
  const counts: Record<Eol, number> = { '\r\n': 0, '\n': 0, '\r': 0 };
  let first: Eol | null = null;
  for (let index = startIndex; index <= endIndex && index < lines.length; index++) {
    const eol = lines[index]?.eol;
    if (!eol) continue;
    first ??= eol;
    counts[eol] += 1;
  }
  if (first !== null) {
    let winner = first;
    for (const candidate of ['\r\n', '\n', '\r'] as const) {
      if (counts[candidate] > counts[winner]) winner = candidate;
    }
    const max = counts[winner];
    let ties = 0;
    for (const candidate of ['\r\n', '\n', '\r'] as const) if (counts[candidate] === max) ties += 1;
    if (ties === 1) return winner;
  }
  const before = nearestEolBefore(lines, startIndex);
  const after = nearestEolAfter(lines, endIndex + 1);
  if (before !== null && before === after) return before;
  return first ?? before ?? after ?? fallback;
}

function preferredEolForSpan(lines: readonly LineInfo[], start: number, end: number, fallback: Eol): Eol {
  const first = lineIndexAtOffset(lines, start);
  const last = lineIndexAtOffset(lines, end > start ? end - 1 : start);
  return preferredEolForLines(lines, first, Math.max(first, last), fallback);
}

function endingsInside(source: string, start: number, end: number): Eol[] {
  const endings: Eol[] = [];
  for (let index = start; index < end; index++) {
    if (source[index] === '\r') {
      if (index + 1 < end && source[index + 1] === '\n') {
        endings.push('\r\n');
        index += 1;
      } else endings.push('\r');
    } else if (source[index] === '\n') endings.push('\n');
  }
  return endings;
}

function rewriteEols(text: string, inherited: readonly Eol[], fallback: Eol): string {
  if (!hasLineBreak(text)) return text;
  let out = '';
  let segmentStart = 0;
  let endingIndex = 0;
  for (let index = 0; index < text.length; index++) {
    let width = 0;
    if (text[index] === '\r') width = text[index + 1] === '\n' ? 2 : 1;
    else if (text[index] === '\n') width = 1;
    if (width === 0) continue;
    out += text.slice(segmentStart, index) + (inherited[endingIndex++] ?? fallback);
    index += width - 1;
    segmentStart = index + 1;
  }
  return out + text.slice(segmentStart);
}

function rewriteForSpan(text: string, source: string, lines: readonly LineInfo[], start: number, end: number, fallback: Eol): string {
  return rewriteEols(text, endingsInside(source, start, end), preferredEolForSpan(lines, start, end, fallback));
}

function positive(value: number | undefined, name: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) < 1) throw new Error(`${name} must be a positive integer`);
  return value!;
}

function lineAt(lines: LineInfo[], number: number): LineInfo {
  const line = lines[number - 1];
  if (!line) throw new Error(`line ${number} is outside the file (${lines.length} lines)`);
  return line;
}

function findOccurrences(source: string, needle: string): number[] {
  if (!needle) return [];
  const hits: number[] = [];
  let at = 0;
  while ((at = source.indexOf(needle, at)) !== -1) {
    hits.push(at);
    at += Math.max(1, needle.length);
  }
  return hits;
}

function exactSpans(source: string, lines: readonly LineInfo[], oldString: string, newString: string, replaceAll: boolean, fallback: Eol, mixedEols: boolean, label = 'exact'): Span[] {
  if (!oldString) throw new Error('oldString cannot be empty for an existing file');
  if (canonicalEols(oldString) === canonicalEols(newString)) throw new Error('oldString and newString are identical apart from line endings');
  const hits = equivalentOccurrences(source, oldString, mixedEols);
  if (hits.length === 0) throw new Error('oldString was not found');
  if (!replaceAll && hits.length > 1) throw new Error(`oldString is ambiguous (${hits.length} occurrences); make it unique or use replaceAll:true`);
  return (replaceAll ? hits : hits.slice(0, 1)).map(({ start, end }) => ({
    start,
    end,
    replacement: rewriteForSpan(newString, source, lines, start, end, fallback),
    label
  }));
}

function lineSpan(lines: LineInfo[], number: number, newText: string, oldText: string | undefined, fallback: Eol, label = 'line'): Span {
  const line = lineAt(lines, positive(number, 'line'));
  if (!oldText) throw new Error('line edits require oldText to verify the current line');
  if (!line.text.includes(canonicalEols(oldText))) throw new Error(`line ${number} does not contain oldText; re-read the file`);
  const local = preferredEolForLines(lines, number - 1, number - 1, fallback);
  return { start: line.start, end: line.end, replacement: rewriteEols(newText, [], local), label };
}

function rangeSpan(source: string, lines: LineInfo[], startLine: number, endLine: number, input: { newText?: string; oldText?: string; delete?: boolean }, fallback: Eol, label = 'range'): Span {
  const startNo = positive(startLine, 'startLine');
  const endNo = positive(endLine, 'endLine');
  if (endNo < startNo) throw new Error('endLine must be >= startLine');
  const first = lineAt(lines, startNo);
  const last = lineAt(lines, endNo);
  if (endNo - startNo >= 5 && !input.oldText) throw new Error('ranges over 5 lines require oldText verification');
  if (input.oldText) {
    const actual = lines.slice(startNo - 1, endNo).map((line) => line.text).join('\n');
    const expected = canonicalEols(input.oldText);
    if (!actual.includes(expected)) throw new Error(`range ${startNo}-${endNo} does not contain oldText; re-read the file`);
  }
  if (input.delete) {
    if (input.newText !== undefined) throw new Error('delete:true cannot be combined with newText');
    return { start: first.start, end: last.eolEnd, replacement: '', label };
  }
  if (input.newText === undefined) throw new Error('range edit requires newText or delete:true');
  const local = preferredEolForLines(lines, startNo - 1, endNo - 1, fallback);
  return { start: first.start, end: last.end, replacement: rewriteEols(input.newText, endingsInside(source, first.start, last.end), local), label };
}

function insertSpan(lines: LineInfo[], source: string, at: number, newText: string, oldText: string | undefined, fallback: Eol): Span {
  if (!Number.isSafeInteger(at) || at < 0 || at > lines.length) throw new Error(`insertAt must be between 0 and ${lines.length}`);
  const anchorIndex = at === 0 ? 0 : Math.min(lines.length - 1, at - 1);
  const eol = preferredEolForLines(lines, anchorIndex, anchorIndex, fallback);
  const replacement = rewriteEols(newText, [], eol);
  if (at === 0) return { start: 0, end: 0, replacement: replacement + (replacement.endsWith(eol) ? '' : eol), label: 'insertAt' };
  const anchor = lineAt(lines, at);
  if (!oldText || !anchor.text.includes(canonicalEols(oldText))) throw new Error(`insertAt ${at} requires oldText confirming line ${at}`);
  if (anchor.eolEnd > anchor.end) {
    return { start: anchor.eolEnd, end: anchor.eolEnd, replacement: replacement + (replacement.endsWith(eol) ? '' : eol), label: 'insertAt' };
  }
  return { start: source.length, end: source.length, replacement: (source ? eol : '') + replacement, label: 'insertAt' };
}

function nearSpan(source: string, lines: LineInfo[], nearText: string, occurrence: number, oldText: string, newText: string, fallback: Eol, mixedEols: boolean): Span {
  const anchors = equivalentOccurrences(source, nearText, mixedEols);
  if (anchors.length === 0) throw new Error('nearText anchor was not found');
  if (occurrence < 1 || occurrence > anchors.length) throw new Error(`nearText occurrence ${occurrence} is outside 1-${anchors.length}`);
  const anchor = anchors[occurrence - 1]!.start;
  const anchorLine = Math.max(0, lines.findIndex((line) => anchor >= line.start && anchor <= line.eolEnd));
  const lo = lines[Math.max(0, anchorLine - 5)]?.start ?? 0;
  const hi = lines[Math.min(lines.length - 1, anchorLine + 5)]?.eolEnd ?? source.length;
  const region = source.slice(lo, hi);
  const hits = equivalentOccurrences(region, oldText, true);
  if (hits.length !== 1) throw new Error(`oldText near the selected anchor matched ${hits.length} times; provide a more precise anchor`);
  const start = lo + hits[0]!.start;
  const end = lo + hits[0]!.end;
  return { start, end, replacement: rewriteForSpan(newText, source, lines, start, end, fallback), label: 'nearText' };
}

function assertNonOverlapping(spans: Span[]): void {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      throw new Error(`edit operations overlap (${sorted[i - 1]!.label} and ${sorted[i]!.label}); submit non-overlapping operations`);
    }
  }
}

function applySpans(source: string, spans: Span[]): string {
  let next = source;
  for (const span of [...spans].sort((a, b) => b.start - a.start || b.end - a.end)) {
    next = next.slice(0, span.start) + span.replacement + next.slice(span.end);
  }
  return next;
}

function countDelta(before: string, after: string): { additions: number; deletions: number } {
  const a = before.split(/\r\n|\r|\n/);
  const b = after.split(/\r\n|\r|\n/);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { deletions: Math.max(0, a.length - prefix - suffix), additions: Math.max(0, b.length - prefix - suffix) };
}

export async function editTool(roots: readonly Root[], input: EditInput) {
  if (input.filePath !== undefined && input.file_path !== undefined && input.filePath !== input.file_path) throw new Error('filePath and file_path disagree');
  const filePath = input.filePath ?? input.file_path;
  if (!filePath) throw new Error('filePath is required');
  const resolved = await resolveToolPath(roots, filePath, { allowMissing: input.oldString === '' });

  let exists = true;
  let source = '';
  let beforeStat: Awaited<ReturnType<typeof fs.stat>> | undefined;
  try {
    beforeStat = await fs.stat(resolved.real);
    if (!beforeStat.isFile()) throw new Error(`${resolved.virtual} is not a regular file`);
    source = await fs.readFile(resolved.real, 'utf8');
    if (source.slice(0, 1024).includes('\0')) throw new Error('binary files cannot be edited as text');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }

  if (!exists) {
    if (input.oldString !== '' || input.newString === undefined) throw new Error('creating a missing file requires oldString:"" and newString');
    await fs.mkdir(path.dirname(resolved.real), { recursive: true });
    await fs.writeFile(resolved.real, input.newString, 'utf8');
    const stat = await fs.stat(resolved.real);
    readCache.record(resolved.real, stat);
    return ok(`Created ${resolved.virtual} (${Buffer.byteLength(input.newString, 'utf8')} bytes).`, { path: resolved.virtual, strategy: 'create', applied: 1 });
  }

  const freshness = await readCache.freshness(resolved.real);
  if (freshness.stale) throw new Error('This file changed on disk after it was last read. Re-read it before editing.');
  const warnings: string[] = [];
  const lineTargeted = input.line !== undefined || input.startLine !== undefined || input.insertAt !== undefined || input.insertAfter !== undefined || input.edits !== undefined;
  if (freshness.missing && lineTargeted) warnings.push('No prior read record exists for this file; line-targeted edits were validated against current contents, but reading first is safer.');

  const lines = lineTable(source);
  const eol = dominantEol(lines);
  const mixedEols = hasMixedEols(lines);
  const groups = [
    input.oldString !== undefined,
    input.line !== undefined,
    input.startLine !== undefined || input.endLine !== undefined,
    input.insertAt !== undefined || input.insertAfter !== undefined,
    input.appendFile === true,
    input.nearText !== undefined,
    input.edits !== undefined
  ].filter(Boolean).length;
  if (groups !== 1) throw new Error('Choose exactly one edit strategy: exact, line, range, insertAt, appendFile, nearText, or edits[]');

  const spans: Span[] = [];
  let strategy = 'unknown';
  if (input.oldString !== undefined) {
    if (input.newString === undefined) throw new Error('newString is required with oldString');
    strategy = input.replaceAll ? 'replaceAll' : 'exact';
    spans.push(...exactSpans(source, lines, input.oldString, input.newString, Boolean(input.replaceAll), eol, mixedEols));
  } else if (input.line !== undefined) {
    if (input.newText === undefined) throw new Error('line edit requires newText');
    strategy = 'line';
    spans.push(lineSpan(lines, input.line, input.newText, input.oldText, eol));
  } else if (input.startLine !== undefined || input.endLine !== undefined) {
    if (input.startLine === undefined || input.endLine === undefined) throw new Error('range edit requires both startLine and endLine');
    strategy = input.delete ? 'delete' : 'range';
    spans.push(rangeSpan(source, lines, input.startLine, input.endLine, input, eol));
  } else if (input.insertAt !== undefined || input.insertAfter !== undefined) {
    if (input.insertAt !== undefined && input.insertAfter !== undefined && input.insertAt !== input.insertAfter) throw new Error('insertAt and insertAfter disagree');
    if (input.newText === undefined) throw new Error('insertAt requires newText');
    strategy = 'insertAt';
    spans.push(insertSpan(lines, source, input.insertAt ?? input.insertAfter!, input.newText, input.oldText, eol));
  } else if (input.appendFile) {
    if (input.newText === undefined) throw new Error('appendFile requires newText');
    strategy = 'appendFile';
    const sourceHasTerminator = source.endsWith('\n') || source.endsWith('\r');
    const anchorIndex = Math.max(0, lines.length - 1 - (sourceHasTerminator ? 1 : 0));
    const local = preferredEolForLines(lines, anchorIndex, anchorIndex, eol);
    const addition = rewriteEols(input.newText, [], local);
    spans.push({ start: source.length, end: source.length, replacement: (source && !sourceHasTerminator ? local : '') + addition, label: 'appendFile' });
  } else if (input.nearText !== undefined) {
    if (!input.oldText || input.newText === undefined) throw new Error('nearText requires oldText and newText');
    strategy = 'nearText';
    spans.push(nearSpan(source, lines, input.nearText, input.occurrence ?? 1, input.oldText, input.newText, eol, mixedEols));
  } else if (input.edits) {
    if (input.edits.length < 1) throw new Error('edits[] requires at least one operation');
    strategy = 'batch';
    for (const [index, op] of input.edits.entries()) {
      if ('oldString' in op) spans.push(...exactSpans(source, lines, op.oldString, op.newString, false, eol, mixedEols, `edits[${index}]`));
      else if ('line' in op) spans.push(lineSpan(lines, op.line, op.newText, op.oldText, eol, `edits[${index}]`));
      else spans.push(rangeSpan(source, lines, op.startLine, op.endLine, op, eol, `edits[${index}]`));
    }
  }

  assertNonOverlapping(spans);
  const next = applySpans(source, spans);
  if (next === source) throw new Error('No changes to apply');

  const latest = await fs.stat(resolved.real);
  if (!beforeStat || latest.mtimeMs !== beforeStat.mtimeMs || latest.size !== beforeStat.size) {
    throw new Error('The file changed while this edit was being prepared. Nothing was written; re-read and retry.');
  }
  await fs.writeFile(resolved.real, next, 'utf8');
  const afterStat = await fs.stat(resolved.real);
  readCache.record(resolved.real, afterStat);
  const delta = countDelta(source, next);
  const output = [
    `Edited ${resolved.virtual} using ${strategy}; ${spans.length} operation${spans.length === 1 ? '' : 's'}, +${delta.additions}/-${delta.deletions} lines.`,
    ...warnings.map((warning) => `Warning: ${warning}`)
  ].join('\n');
  return ok(output, { path: resolved.virtual, strategy, applied: spans.length, ...delta, warnings });
}
