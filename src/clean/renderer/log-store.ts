/**
 * Pure log-buffer logic, kept apart from the DOM so it can be tested directly.
 *
 * The renderer receives the log twice over: once as the whole ring when it starts, and then as
 * pushed batches. Those two sources overlap, because lines can be emitted between subscribing
 * and the bootstrap reply arriving. `mergeLog` is what makes that safe — it de-duplicates on
 * the sequence number the main process stamps, which timestamps cannot do, since several lines
 * routinely share a millisecond.
 */

import type { LogEntry } from './types.js';

export type LevelFilter = 'all' | 'info' | 'warn' | 'error';

/** Matches MAX_ENTRIES in the main-process ring; holding more here would show lines the export cannot. */
export const LOG_CAPACITY = 500;

/**
 * Folds `incoming` into `base`, keeping one entry per sequence number, ordered oldest first and
 * trimmed to the newest `cap`. Neither input is mutated.
 */
export function mergeLog(base: readonly LogEntry[], incoming: readonly LogEntry[], cap = LOG_CAPACITY): LogEntry[] {
  if (incoming.length === 0) return base.length > cap ? base.slice(base.length - cap) : [...base];
  const bySeq = new Map<number, LogEntry>();
  for (const entry of base) bySeq.set(entry.seq, entry);
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  const merged = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function countLevels(entries: readonly LogEntry[]): Record<LevelFilter, number> {
  const counts: Record<LevelFilter, number> = { all: entries.length, info: 0, warn: 0, error: 0 };
  for (const entry of entries) counts[entry.level]++;
  return counts;
}

/** Level is an exact match, not a threshold; the tallies beside each control say how many that is. */
export function filterLog(entries: readonly LogEntry[], level: LevelFilter, query: string): LogEntry[] {
  const needle = query.trim().toLowerCase();
  if (level === 'all' && needle === '') return [...entries];
  return entries.filter(
    (entry) =>
      (level === 'all' || entry.level === level) &&
      (needle === '' || entry.message.toLowerCase().includes(needle))
  );
}

export interface Segment { text: string; match: boolean }

/**
 * Splits a message around every case-insensitive occurrence of `query`, so the view can mark the
 * matches without building markup from user-supplied text.
 */
export function splitHighlight(message: string, query: string): Segment[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [{ text: message, match: false }];
  const haystack = message.toLowerCase();
  const segments: Segment[] = [];
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) break;
    if (at > cursor) segments.push({ text: message.slice(cursor, at), match: false });
    segments.push({ text: message.slice(at, at + needle.length), match: true });
    cursor = at + needle.length;
  }
  if (cursor < message.length) segments.push({ text: message.slice(cursor), match: false });
  return segments.length === 0 ? [{ text: message, match: false }] : segments;
}

/**
 * `Date`'s plain getters (as opposed to the `getUTC*` family) read the field in the runtime's
 * own timezone, which for this app is always the machine it's running on — there is no server
 * rendering a log for a different timezone's reader.
 */
export function formatLogTimestamp(time: number): string {
  const at = new Date(time);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`;
  return `${date} ${clock}`;
}
