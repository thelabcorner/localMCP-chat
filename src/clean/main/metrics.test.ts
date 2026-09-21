import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  metricsSnapshot,
  onMetricsChanged,
  recordRequest,
  recordRequestOutcome,
  recordToolCall,
  resetMetrics
} from './metrics.js';

function call(name: string, ok = true, durationMs = 10, known = true, error?: string): void {
  recordToolCall({ name, ok, durationMs, known, ...(error === undefined ? {} : { error }) });
}

beforeEach(() => {
  resetMetrics();
});

describe('totals', () => {
  it('separates successes from in-band failures', () => {
    call('read');
    call('read');
    call('edit', false, 5, true, 'STALE_READ: reread first');
    const metrics = metricsSnapshot();
    expect(metrics.calls).toBe(3);
    expect(metrics.failures).toBe(1);
    expect(metrics.unknownTools).toBe(0);
  });

  it('counts a call for a tool that is not in the projection', () => {
    // What a client replaying a tools/list it cached before a capability was turned off looks like.
    call('shell', false, 2, false, 'TOOL_DISABLED');
    const metrics = metricsSnapshot();
    expect(metrics.unknownTools).toBe(1);
    expect(metrics.failures).toBe(1);
  });

  it('tracks total and slowest duration with the tool responsible', () => {
    call('read', true, 10);
    call('test', true, 4200);
    call('edit', true, 30);
    const metrics = metricsSnapshot();
    expect(metrics.totalDurationMs).toBe(4240);
    expect(metrics.slowestMs).toBe(4200);
    expect(metrics.slowestTool).toBe('test');
  });

  it('counts endpoint requests and only rejects 400 and worse', () => {
    recordRequest();
    recordRequest();
    recordRequestOutcome(200);
    recordRequestOutcome(404);
    recordRequestOutcome(500);
    const metrics = metricsSnapshot();
    expect(metrics.requests).toBe(2);
    expect(metrics.requestErrors).toBe(2);
  });
});

describe('per-tool breakdown', () => {
  it('orders by call count, breaking ties by name', () => {
    call('edit');
    call('read');
    call('read');
    call('archive');
    expect(metricsSnapshot().tools.map((tool) => tool.name)).toEqual(['read', 'archive', 'edit']);
  });

  it('keeps the most recent failure message per tool', () => {
    call('edit', false, 5, true, 'first failure');
    call('edit', true, 5);
    call('edit', false, 5, true, 'second failure');
    const edit = metricsSnapshot().tools.find((tool) => tool.name === 'edit');
    expect(edit).toMatchObject({ calls: 3, failures: 2, lastError: 'second failure' });
  });

  it('redacts anything credential-shaped out of a failure message', () => {
    call('git', false, 5, true, 'remote rejected token sk-abcdefghijklmnop');
    expect(metricsSnapshot().tools[0]?.lastError).toBe('remote rejected token sk-***');
  });

  it('truncates a long failure message', () => {
    // Prose, not one long opaque run: the redactor masks the latter as a probable token, which
    // would leave nothing to truncate.
    call('patch', false, 5, true, 'preflight refused the hunk at line 12. '.repeat(20));
    expect(metricsSnapshot().tools[0]?.lastError).toHaveLength(200);
  });

  it('accumulates duration so an average can be derived', () => {
    call('read', true, 10);
    call('read', true, 30);
    const read = metricsSnapshot().tools[0]!;
    expect(read.totalDurationMs / read.calls).toBe(20);
    expect(read.lastDurationMs).toBe(30);
  });

  it('does not collapse small tools merely because there are more than 256 of them', () => {
    for (let index = 0; index < 300; index++) call(`tool_${index}`);
    const metrics = metricsSnapshot();
    expect(metrics.tools).toHaveLength(300);
    expect(metrics.tools.some((tool) => tool.name === '(other tools)')).toBe(false);
    expect(metrics.calls).toBe(300);
  });

  it('folds new names only when the metrics memory budget is exhausted', () => {
    const suffix = 'x'.repeat(4096);
    for (let index = 0; index < 1200; index++) call(`tool_${index}_${suffix}`);
    const metrics = metricsSnapshot();
    expect(metrics.tools.some((tool) => tool.name === '(other tools)')).toBe(true);
    expect(metrics.tools.length).toBeGreaterThan(256);
    expect(metrics.calls).toBe(1200);
  });
});

describe('reset', () => {
  it('clears every counter and moves the since marker forward', () => {
    const before = metricsSnapshot().since;
    call('read');
    recordRequest();
    vi.setSystemTime(new Date(Date.now() + 1000));
    resetMetrics();
    const metrics = metricsSnapshot();
    expect(metrics).toMatchObject({ calls: 0, failures: 0, requests: 0, tools: [] });
    expect(metrics.since).toBeGreaterThanOrEqual(before);
    vi.useRealTimers();
  });
});

describe('change notification', () => {
  it('announces each recorded call and stops after unsubscribe', () => {
    let count = 0;
    const stop = onMetricsChanged(() => { count++; });
    call('read');
    call('read');
    stop();
    call('read');
    expect(count).toBe(2);
  });

  it('survives a listener that throws, because recording must not break the caller', () => {
    const stop = onMetricsChanged(() => { throw new Error('observer exploded'); });
    expect(() => call('read')).not.toThrow();
    expect(metricsSnapshot().calls).toBe(1);
    stop();
  });
});
