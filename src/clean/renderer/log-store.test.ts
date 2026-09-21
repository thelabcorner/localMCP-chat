import { describe, expect, it } from 'vitest';
import { countLevels, filterLog, mergeLog, splitHighlight } from './log-store.js';
import type { LogEntry } from './types.js';

function entry(seq: number, level: LogEntry['level'] = 'info', message = `line ${seq}`): LogEntry {
  // A fixed timestamp on purpose: ordering must come from the sequence, never the clock.
  return { seq, time: 1_700_000_000_000, level, message };
}

describe('mergeLog', () => {
  it('folds an overlapping bootstrap and push into one ordered list', () => {
    // The exact race the sequence numbers exist for: the pushed batch repeats lines 3 and 4,
    // which the bootstrap reply also carried.
    const bootstrap = [entry(1), entry(2), entry(3), entry(4)];
    const pushed = [entry(3), entry(4), entry(5)];
    expect(mergeLog(bootstrap, pushed).map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('orders by sequence even when batches arrive out of order', () => {
    expect(mergeLog([entry(5), entry(1)], [entry(3)]).map((item) => item.seq)).toEqual([1, 3, 5]);
  });

  it('keeps the newest entries when over capacity', () => {
    const many = Array.from({ length: 10 }, (_, index) => entry(index + 1));
    expect(mergeLog([], many, 4).map((item) => item.seq)).toEqual([7, 8, 9, 10]);
  });

  it('trims an over-capacity base even when nothing new arrived', () => {
    const many = Array.from({ length: 6 }, (_, index) => entry(index + 1));
    expect(mergeLog(many, [], 2).map((item) => item.seq)).toEqual([5, 6]);
  });

  it('does not mutate its inputs', () => {
    const base = [entry(1)];
    const incoming = [entry(2)];
    mergeLog(base, incoming);
    expect(base).toHaveLength(1);
    expect(incoming).toHaveLength(1);
  });

  it('prefers the later copy of a repeated sequence', () => {
    const merged = mergeLog([entry(1, 'info', 'first')], [entry(1, 'error', 'corrected')]);
    expect(merged).toEqual([entry(1, 'error', 'corrected')]);
  });
});

describe('filterLog', () => {
  const entries = [entry(1, 'info', 'tunnel handshake ok'), entry(2, 'warn', 'plugin needs auth'), entry(3, 'error', 'connect failed')];

  it('matches a level exactly rather than as a threshold', () => {
    expect(filterLog(entries, 'warn', '').map((item) => item.seq)).toEqual([2]);
  });

  it('searches case-insensitively', () => {
    expect(filterLog(entries, 'all', 'HANDSHAKE').map((item) => item.seq)).toEqual([1]);
  });

  it('applies level and query together', () => {
    expect(filterLog(entries, 'error', 'handshake')).toEqual([]);
  });

  it('ignores surrounding whitespace in the query', () => {
    expect(filterLog(entries, 'all', '  plugin  ').map((item) => item.seq)).toEqual([2]);
  });

  it('returns everything for the default filter', () => {
    expect(filterLog(entries, 'all', '')).toHaveLength(3);
  });
});

describe('countLevels', () => {
  it('tallies each level and the total', () => {
    expect(countLevels([entry(1, 'info'), entry(2, 'warn'), entry(3, 'warn')])).toEqual({ all: 3, info: 1, warn: 2, error: 0 });
  });
});

describe('splitHighlight', () => {
  it('returns one unmatched segment without a query', () => {
    expect(splitHighlight('hello', '')).toEqual([{ text: 'hello', match: false }]);
  });

  it('marks every occurrence and preserves the original casing', () => {
    expect(splitHighlight('Tunnel tunnel', 'TUNNEL')).toEqual([
      { text: 'Tunnel', match: true },
      { text: ' ', match: false },
      { text: 'tunnel', match: true }
    ]);
  });

  it('reassembles into the original message', () => {
    const message = 'connect failed: connect refused';
    expect(splitHighlight(message, 'connect').map((segment) => segment.text).join('')).toBe(message);
  });

  it('handles a match at the very start and end', () => {
    expect(splitHighlight('abcab', 'ab')).toEqual([
      { text: 'ab', match: true },
      { text: 'c', match: false },
      { text: 'ab', match: true }
    ]);
  });
});
