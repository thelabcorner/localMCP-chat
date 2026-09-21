/**
 * Tool-call accounting for the control window.
 *
 * Counters run for the lifetime of the app process, not the MCP server. The server is restarted
 * whenever the published tool surface changes — toggling a capability is enough — and resetting
 * the numbers under the user every time they flipped a switch would make them useless for
 * answering "is this thing working". `since` says exactly which window they cover, and clearing
 * them is an explicit action.
 *
 * Everything here is resource-bounded. Tool names for plugin tools come from external servers,
 * so the per-tool table is admitted against an approximate memory budget and overflow is folded
 * into one bucket rather than imposing an arbitrary number-of-tools ceiling. Error text is truncated and stays local: it is
 * shown in this window and is never returned over IPC to a model or written to the MCP boundary.
 */

import { redact } from '../../main/logger.js';

/**
 * Approximate heap budget for distinct per-tool rows. Count is intentionally not a boundary:
 * 300 tiny tools are cheaper than 300 giant attacker-controlled names. A conservative fixed
 * overhead covers the ToolStat object/map entry while UTF-8 bytes account for the external name.
 */
const TOOL_METRICS_BUDGET_BYTES = 4 * 1024 * 1024;
const TOOL_STAT_OVERHEAD_BYTES = 512;
const OVERFLOW_BUCKET = '(other tools)';
const MAX_ERROR_CHARS = 200;

export interface ToolStat {
  name: string;
  calls: number;
  failures: number;
  lastAt: number | null;
  lastDurationMs: number | null;
  totalDurationMs: number;
  /** Redacted and truncated message from the most recent failure, if any. */
  lastError: string | null;
}

export interface McpMetrics {
  /** Epoch ms these counters started covering: app start, or the last explicit reset. */
  since: number;
  /** Authenticated requests that reached the MCP endpoint. */
  requests: number;
  /** Endpoint responses of 400 or worse, excluding the optional GET/DELETE 405s. */
  requestErrors: number;
  calls: number;
  failures: number;
  /** Calls for a name absent from the projection — usually a client reusing a stale tools/list. */
  unknownTools: number;
  totalDurationMs: number;
  slowestMs: number;
  slowestTool: string | null;
  tools: ToolStat[];
}

let since = Date.now();
let requests = 0;
let requestErrors = 0;
let calls = 0;
let failures = 0;
let unknownTools = 0;
let totalDurationMs = 0;
let slowestMs = 0;
let slowestTool: string | null = null;
const tools = new Map<string, ToolStat>();
let toolTableBytes = 0;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Recording a call must never be able to break the call. There is nowhere useful to
      // report a failure from a metrics observer.
    }
  }
}

export function onMetricsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recordRequest(): void {
  requests++;
}

export function recordRequestOutcome(statusCode: number): void {
  if (statusCode >= 400) requestErrors++;
}

function bucketFor(name: string): ToolStat {
  const existing = tools.get(name);
  if (existing) return existing;
  const rowBytes = TOOL_STAT_OVERHEAD_BYTES + Buffer.byteLength(name, 'utf8');
  // Resource pressure, not cardinality, decides when new names are aggregated.
  const key = toolTableBytes + rowBytes > TOOL_METRICS_BUDGET_BYTES ? OVERFLOW_BUCKET : name;
  const found = tools.get(key);
  if (found) return found;
  const created: ToolStat = {
    name: key,
    calls: 0,
    failures: 0,
    lastAt: null,
    lastDurationMs: null,
    totalDurationMs: 0,
    lastError: null
  };
  tools.set(key, created);
  toolTableBytes += TOOL_STAT_OVERHEAD_BYTES + Buffer.byteLength(key, 'utf8');
  return created;
}

export function recordToolCall(entry: {
  name: string;
  ok: boolean;
  durationMs: number;
  known: boolean;
  error?: string | null;
}): void {
  calls++;
  if (!entry.ok) failures++;
  if (!entry.known) unknownTools++;
  totalDurationMs += entry.durationMs;
  if (entry.durationMs > slowestMs) {
    slowestMs = entry.durationMs;
    slowestTool = entry.name;
  }

  const stat = bucketFor(entry.name);
  stat.calls++;
  if (!entry.ok) stat.failures++;
  stat.lastAt = Date.now();
  stat.lastDurationMs = entry.durationMs;
  stat.totalDurationMs += entry.durationMs;
  if (!entry.ok && entry.error) {
    stat.lastError = redact(entry.error).slice(0, MAX_ERROR_CHARS);
  }
  announce();
}

export function metricsSnapshot(): McpMetrics {
  return {
    since,
    requests,
    requestErrors,
    calls,
    failures,
    unknownTools,
    totalDurationMs,
    slowestMs,
    slowestTool,
    tools: [...tools.values()]
      .map((stat) => ({ ...stat }))
      .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name))
  };
}

export function resetMetrics(): void {
  since = Date.now();
  requests = 0;
  requestErrors = 0;
  calls = 0;
  failures = 0;
  unknownTools = 0;
  totalDurationMs = 0;
  slowestMs = 0;
  slowestTool = null;
  tools.clear();
  toolTableBytes = 0;
  announce();
}
