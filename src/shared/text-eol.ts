import { diffArrays } from 'diff';

export type TextEol = '\r\n' | '\n' | '\r';

interface PhysicalLine {
  text: string;
  eol: TextEol | null;
}

interface EolProfile {
  preferred: TextEol | null;
  mixed: boolean;
}

// Whole-file rewrites can be arbitrarily large. Myers-style alignment is useful for mixed-EOL
// insert/delete edits, but its worst case is not acceptable as an unbounded write-path cost.
const MAX_EOL_ALIGNMENT_LINES = 50_000;

function splitPhysicalLines(text: string): PhysicalLine[] {
  if (text === '') return [];
  const lines: PhysicalLine[] = [];
  let start = 0;
  for (let cursor = 0; cursor < text.length; cursor++) {
    let eol: TextEol | null = null;
    let width = 0;
    if (text[cursor] === '\r') {
      if (text[cursor + 1] === '\n') {
        eol = '\r\n';
        width = 2;
      } else {
        eol = '\r';
        width = 1;
      }
    } else if (text[cursor] === '\n') {
      eol = '\n';
      width = 1;
    }
    if (eol === null) continue;
    lines.push({ text: text.slice(start, cursor), eol });
    cursor += width - 1;
    start = cursor + 1;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: null });
  return lines;
}

function profileEols(text: string): EolProfile {
  const counts: Record<TextEol, number> = { '\r\n': 0, '\n': 0, '\r': 0 };
  let first: TextEol | null = null;
  let seen: TextEol | null = null;
  let mixed = false;
  for (let cursor = 0; cursor < text.length; cursor++) {
    let eol: TextEol | null = null;
    if (text[cursor] === '\r') {
      if (text[cursor + 1] === '\n') {
        eol = '\r\n';
        cursor += 1;
      } else eol = '\r';
    } else if (text[cursor] === '\n') eol = '\n';
    if (eol === null) continue;
    first ??= eol;
    counts[eol] += 1;
    if (seen === null) seen = eol;
    else if (seen !== eol) mixed = true;
  }
  if (first === null) return { preferred: null, mixed: false };
  let preferred = first;
  for (const candidate of ['\r\n', '\n', '\r'] as const) {
    if (counts[candidate] > counts[preferred]) preferred = candidate;
  }
  return { preferred, mixed };
}

function rewriteAllEols(text: string, eol: TextEol): string {
  if (!text.includes('\r') && eol === '\n') return text;
  return text.replace(/\r\n|\r|\n/g, eol);
}

function nearestEol(lines: readonly PhysicalLine[], index: number, direction: -1 | 1): TextEol | null {
  for (let cursor = index; cursor >= 0 && cursor < lines.length; cursor += direction) {
    const eol = lines[cursor]?.eol;
    if (eol !== null && eol !== undefined) return eol;
  }
  return null;
}

function localEol(lines: readonly PhysicalLine[], oldIndex: number, fallback: TextEol): TextEol {
  const before = nearestEol(lines, oldIndex - 1, -1);
  const after = nearestEol(lines, oldIndex, 1);
  if (before !== null && before === after) return before;
  return before ?? after ?? fallback;
}

function renderPhysicalLines(lines: readonly PhysicalLine[]): string {
  let result = '';
  for (const line of lines) result += line.text + (line.eol ?? '');
  return result;
}

/**
 * Linear fallback for very large mixed-ending rewrites. Equal logical prefixes/suffixes retain
 * exact source terminators; the changed middle inherits positionally where possible and otherwise
 * uses its closest boundary. This deliberately trades perfect interior alignment for a strict O(n)
 * upper bound once a file is too large for safe sequence diffing.
 */
function rehydrateLargeRewrite(
  oldLines: readonly PhysicalLine[],
  newLines: readonly PhysicalLine[],
  fallback: TextEol
): string {
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix]!.text === newLines[prefix]!.text) prefix += 1;

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix]!.text === newLines[newLines.length - 1 - suffix]!.text
  ) suffix += 1;

  const out: PhysicalLine[] = [];
  for (let index = 0; index < prefix; index++) {
    const target = newLines[index]!;
    out.push({ text: target.text, eol: target.eol === null ? null : oldLines[index]!.eol ?? fallback });
  }

  const oldMiddleStart = prefix;
  const oldMiddleLength = oldLines.length - prefix - suffix;
  const newMiddleEnd = newLines.length - suffix;
  for (let index = prefix; index < newMiddleEnd; index++) {
    const target = newLines[index]!;
    if (target.eol === null) {
      out.push({ text: target.text, eol: null });
      continue;
    }
    const relative = index - prefix;
    const sourceIndex = oldMiddleStart + Math.min(relative, Math.max(0, oldMiddleLength - 1));
    const inherited = relative < oldMiddleLength ? oldLines[sourceIndex]?.eol : null;
    out.push({ text: target.text, eol: inherited ?? localEol(oldLines, sourceIndex, fallback) });
  }

  for (let offset = suffix - 1; offset >= 0; offset--) {
    const oldIndex = oldLines.length - 1 - offset;
    const newIndex = newLines.length - 1 - offset;
    const target = newLines[newIndex]!;
    out.push({ text: target.text, eol: target.eol === null ? null : oldLines[oldIndex]!.eol ?? fallback });
  }
  return renderPhysicalLines(out);
}

/**
 * Reconstruct a whole-file text rewrite without turning line-ending choice into an unrelated
 * formatting change. Uniform source files take a cheap O(n) terminator conversion path. Mixed
 * files align logical lines only when necessary: unchanged lines keep their exact terminators,
 * replacement lines inherit the corresponding removed line's terminator, and genuinely inserted
 * lines infer from the nearest source neighborhood. The caller's final-newline intent is retained.
 */
export function healTextLineEndings(before: string, after: string): string {
  const profile = profileEols(before);
  if (profile.preferred === null || after === '') return after;
  if (!profile.mixed) return rewriteAllEols(after, profile.preferred);

  const oldLines = splitPhysicalLines(before);
  const newLines = splitPhysicalLines(after);
  if (oldLines.length === newLines.length || oldLines.length + newLines.length > MAX_EOL_ALIGNMENT_LINES) {
    return rehydrateLargeRewrite(oldLines, newLines, profile.preferred);
  }
  const changes = diffArrays(oldLines.map((line) => line.text), newLines.map((line) => line.text));
  const out: PhysicalLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  for (let changeIndex = 0; changeIndex < changes.length; changeIndex++) {
    const change = changes[changeIndex]!;
    if (change.removed) {
      const next = changes[changeIndex + 1];
      if (next?.added) {
        const removedStart = oldIndex;
        const removedCount = change.value.length;
        const addedCount = next.value.length;
        const paired = Math.min(removedCount, addedCount);
        for (let offset = 0; offset < addedCount; offset++) {
          const target = newLines[newIndex++]!;
          if (target.eol === null) {
            out.push({ text: target.text, eol: null });
            continue;
          }
          const inherited = offset < paired ? oldLines[removedStart + offset]?.eol : null;
          out.push({
            text: target.text,
            eol: inherited ?? localEol(oldLines, removedStart + Math.min(offset, removedCount), profile.preferred)
          });
        }
        oldIndex += removedCount;
        changeIndex += 1;
        continue;
      }
      oldIndex += change.value.length;
      continue;
    }

    if (change.added) {
      const inferred = localEol(oldLines, oldIndex, profile.preferred);
      for (let offset = 0; offset < change.value.length; offset++) {
        const target = newLines[newIndex++]!;
        out.push({ text: target.text, eol: target.eol === null ? null : inferred });
      }
      continue;
    }

    for (let offset = 0; offset < change.value.length; offset++) {
      const oldLine = oldLines[oldIndex++]!;
      const target = newLines[newIndex++]!;
      out.push({
        text: target.text,
        eol: target.eol === null ? null : oldLine.eol ?? localEol(oldLines, oldIndex - 1, profile.preferred)
      });
    }
  }

  return renderPhysicalLines(out);
}

/** Normalize only for matching; never write this form directly to disk. */
export function normalizeTextEolsToLf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n|\r/g, '\n') : text;
}

/** jsdiff already auto-converts uniform LF<->CRLF, so only these sources need the fallback path. */
export function needsEolAwarePatchFallback(text: string): boolean {
  const profile = profileEols(text);
  return profile.mixed || profile.preferred === '\r';
}
