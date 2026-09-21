/**
 * Port of `codex-rs/apply-patch/src/text_file.rs`.
 *
 * The line scanner walks byte offsets in Rust and UTF-16 offsets here. Both are exact for this
 * purpose: CR and LF are single units in either encoding and can never appear inside a
 * multi-unit character, so the two cursors split at the same places.
 */

/** `(start_index, old_len, new_lines)`. */
export type Replacement = [number, number, string[]];

type LineEnding = 'lf' | 'crlf' | 'cr';

const LINE_ENDING_TEXT: Record<LineEnding, string> = { lf: '\n', crlf: '\r\n', cr: '\r' };

interface SourceLine {
  text: string;
  ending: LineEnding | null;
}

const CARRIAGE_RETURN = 13;
const LINE_FEED = 10;

export class SourceFile {
  private lines: SourceLine[];
  private readonly preferredEnding: LineEnding;
  private readonly originalTrailingNewline: boolean | null;

  private constructor(lines: SourceLine[], preferredEnding: LineEnding, originalTrailingNewline: boolean | null) {
    this.lines = lines;
    this.preferredEnding = preferredEnding;
    this.originalTrailingNewline = originalTrailingNewline;
  }

  /**
   * Splits contents into logical lines while retaining each line ending.
   *
   * The dominant existing ending becomes the file-wide fallback; ties prefer the first observed
   * style and files without an ending default to LF. Actual insertions use narrower local context
   * when available.
   */
  static parse(contents: string): SourceFile {
    const lines: SourceLine[] = [];
    const endingCounts: Record<LineEnding, number> = { lf: 0, crlf: 0, cr: 0 };
    let firstEnding: LineEnding | null = null;
    let lineStart = 0;
    let cursor = 0;

    while (cursor < contents.length) {
      let ending: LineEnding;
      let endingLength: number;
      const unit = contents.charCodeAt(cursor);
      if (unit === CARRIAGE_RETURN && contents.charCodeAt(cursor + 1) === LINE_FEED) {
        ending = 'crlf';
        endingLength = 2;
      } else if (unit === CARRIAGE_RETURN) {
        ending = 'cr';
        endingLength = 1;
      } else if (unit === LINE_FEED) {
        ending = 'lf';
        endingLength = 1;
      } else {
        cursor += 1;
        continue;
      }
      firstEnding ??= ending;
      endingCounts[ending] += 1;
      lines.push({ text: contents.slice(lineStart, cursor), ending });
      cursor += endingLength;
      lineStart = cursor;
    }

    if (lineStart < contents.length) {
      lines.push({ text: contents.slice(lineStart), ending: null });
    }

    let preferredEnding = firstEnding ?? 'lf';
    for (const candidate of ['lf', 'crlf', 'cr'] as const) {
      if (endingCounts[candidate] > endingCounts[preferredEnding]) preferredEnding = candidate;
    }
    const originalTrailingNewline = contents === '' ? null : lineStart === contents.length;
    return new SourceFile(lines, preferredEnding, originalTrailingNewline);
  }

  lineTexts(): string[] {
    return this.lines.map((line) => line.text);
  }

  /**
   * Rebuilds the file from source-ordered, non-overlapping replacements.
   *
   * Unchanged lines retain their original endings, inserted lines use the preferred ending, and
   * every resulting line receives an ending to match apply-patch's historical trailing-newline
   * behavior.
   */
  applyReplacements(replacements: readonly Replacement[]): void {
    const sourceLines = this.lines;
    const newLines: SourceLine[] = [];
    let cursor = 0;

    for (const [startIndex, oldLength, newSegment] of replacements) {
      while (cursor < startIndex && cursor < sourceLines.length) newLines.push(sourceLines[cursor++] as SourceLine);

      const removedStart = cursor;
      const removedLength = Math.min(oldLength, Math.max(0, sourceLines.length - cursor));
      const localEnding = this.inferReplacementEnding(startIndex, oldLength);
      cursor += removedLength;
      for (let index = 0; index < newSegment.length; index++) {
        // When replacement cardinality lines up, keep each replaced physical line's exact
        // terminator. Extra inserted lines use the local neighborhood inference below.
        const inherited = index < removedLength ? sourceLines[removedStart + index]?.ending : undefined;
        newLines.push({ text: newSegment[index] as string, ending: inherited ?? localEnding });
      }
    }
    while (cursor < sourceLines.length) newLines.push(sourceLines[cursor++] as SourceLine);
    this.lines = newLines;

    // A null terminator is valid only on the final physical line. Preserve the source file's EOF
    // newline state instead of manufacturing an unrelated one as a side effect of an earlier edit.
    for (let index = 0; index + 1 < this.lines.length; index++) {
      if (this.lines[index]!.ending !== null) continue;
      const before = this.nearestEndingBefore(index);
      const after = this.nearestEndingAtOrAfter(index + 1);
      this.lines[index]!.ending = before !== null && before === after
        ? before
        : before ?? after ?? this.preferredEnding;
    }
    const last = this.lines.at(-1);
    if (last !== undefined) {
      if (this.originalTrailingNewline === false) last.ending = null;
      else last.ending ??= this.preferredEnding;
    }
  }

  /**
   * Infer a terminator for newly inserted physical lines from the smallest useful neighborhood.
   * Replaced lines win, then agreeing boundaries, then the preceding/following line, and only
   * then the file-wide dominant style. Replacements are non-overlapping, so the total region scan
   * over a patch remains linear in the amount of source text actually replaced.
   */
  private inferReplacementEnding(startIndex: number, oldLength: number): LineEnding {
    const counts: Record<LineEnding, number> = { lf: 0, crlf: 0, cr: 0 };
    let firstLocal: LineEnding | null = null;
    const end = Math.min(this.lines.length, startIndex + oldLength);
    for (let index = startIndex; index < end; index++) {
      const ending = this.lines[index]?.ending;
      if (ending === null || ending === undefined) continue;
      firstLocal ??= ending;
      counts[ending] += 1;
    }

    if (firstLocal !== null) {
      let winner = firstLocal;
      for (const candidate of ['lf', 'crlf', 'cr'] as const) {
        if (counts[candidate] > counts[winner]) winner = candidate;
      }
      const max = counts[winner];
      let ties = 0;
      for (const candidate of ['lf', 'crlf', 'cr'] as const) if (counts[candidate] === max) ties += 1;
      if (ties === 1) return winner;
    }

    const before = this.nearestEndingBefore(startIndex);
    const after = this.nearestEndingAtOrAfter(startIndex + oldLength);
    if (before !== null && before === after) return before;
    if (firstLocal !== null) return firstLocal;
    return before ?? after ?? this.preferredEnding;
  }

  private nearestEndingBefore(index: number): LineEnding | null {
    for (let cursor = Math.min(index, this.lines.length) - 1; cursor >= 0; cursor--) {
      const ending = this.lines[cursor]?.ending;
      if (ending !== null && ending !== undefined) return ending;
    }
    return null;
  }

  private nearestEndingAtOrAfter(index: number): LineEnding | null {
    for (let cursor = Math.max(0, index); cursor < this.lines.length; cursor++) {
      const ending = this.lines[cursor]?.ending;
      if (ending !== null && ending !== undefined) return ending;
    }
    return null;
  }

  intoContents(): string {
    let contents = '';
    for (const line of this.lines) {
      contents += line.text;
      if (line.ending !== null) contents += LINE_ENDING_TEXT[line.ending];
    }
    return contents;
  }
}
