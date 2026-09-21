/**
 * The Activity log: a byte-bounded in-memory ring for the diagnostics panel, mirrored to one
 * bounded file so a run can still be read after the app has quit.
 *
 * Callers are responsible for not passing secrets; as a backstop, anything that looks like
 * an OpenAI key or a tunnel token is masked before it is stored, so a mistake upstream
 * cannot leak a credential into the UI or the file.
 *
 * The file mirror exists because diagnostics must survive a process exit. It is intentionally
 * small and already-redacted; localMCP-chat does not maintain browser/chat/session history.
 */

import { appendFileSync, renameSync, statSync } from 'node:fs';
import type { LogEntry } from '../shared/types.js';

const MAX_MEMORY_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
/** One rotation keeps the previous file, so the last two of these are always on disk. */
const MAX_LOG_FILE_BYTES = 4 * 1024 * 1024;

const entries: LogEntry[] = [];
let entriesBytes = 0;
const listeners = new Set<(entry: LogEntry) => void>();

let logFile: string | null = null;
let logFileBytes = 0;
/** Kept separate from `logFile`, which is cleared when the mirror is disabled by a write failure. */
let logFilePath: string | null = null;

/**
 * Mirrors every line from here on to `file`, rotating it once to `file.1` when it fills.
 *
 * Synchronous and unconditional: the lines worth having are the ones written during a
 * crash or teardown, when nothing asynchronous is guaranteed to run. A write failure is
 * swallowed — the log is the reporting channel — and disables the mirror for this process.
 */
export function initLogFile(file: string): void {
  logFile = file;
  logFilePath = file;
  try {
    logFileBytes = statSync(file).size;
  } catch {
    logFileBytes = 0;
  }
}

function mirrorToFile(entry: LogEntry): void {
  if (!logFile) return;
  const line = `${new Date(entry.time).toISOString()}  ${entry.level.padEnd(5)}  ${entry.message}\n`;
  try {
    if (logFileBytes >= MAX_LOG_FILE_BYTES) {
      renameSync(logFile, `${logFile}.1`);
      logFileBytes = 0;
    }
    appendFileSync(logFile, line, 'utf8');
    logFileBytes += Buffer.byteLength(line, 'utf8');
  } catch {
    logFile = null;
  }
}

/** Masks anything shaped like a credential, wherever it appears in a message. */
export function redact(message: string): string {
  return message
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g, '***jwt***')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, (match) =>
      // Long opaque strings are tokens far more often than they are prose.
      /^[A-Za-z0-9_-]+$/.test(match) ? '***' : match
    );
}

/**
 * Opt-in console echo for troubleshooting a start-up that never reaches the UI.
 * Off unless CLF_DEBUG=1, so logs are not exposed by default, and it prints the
 * redacted text so enabling it can never surface a credential.
 */
const ECHO_TO_CONSOLE = process.env['CLF_DEBUG'] === '1';

let sequence = 0;

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '\n… log entry truncated by byte budget';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  const bytes = Buffer.from(value, 'utf8').subarray(0, Math.max(0, maxBytes - suffixBytes));
  // Source text is valid UTF-8, so only the final code point can be incomplete. Back up at most
  // four bytes until Node no longer reports a replacement glyph at the end.
  let end = bytes.length;
  while (end > 0) {
    const decoded = bytes.subarray(0, end).toString('utf8');
    if (!decoded.endsWith('\uFFFD')) return decoded + suffix;
    end--;
  }
  return suffix;
}

function entryBytes(entry: LogEntry): number {
  // Conservative accounting includes fixed scalar/object overhead in addition to the message.
  return 128 + Buffer.byteLength(entry.message, 'utf8');
}

export function log(level: LogEntry['level'], message: string): void {
  const entry: LogEntry = {
    seq: ++sequence,
    time: Date.now(),
    level,
    message: boundedUtf8(redact(message), MAX_ENTRY_BYTES)
  };
  entries.push(entry);
  entriesBytes += entryBytes(entry);
  while (entriesBytes > MAX_MEMORY_BYTES && entries.length > 1) {
    const removed = entries.shift();
    if (removed) entriesBytes -= entryBytes(removed);
  }
  mirrorToFile(entry);
  if (ECHO_TO_CONSOLE) process.stderr.write(`[${level}] ${entry.message}\n`);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // Writing a log line must never be able to break the code that wrote it. Listeners run
      // synchronously on the caller's stack, and the one that matters here reaches the
      // renderer — which can already be gone while teardown is still logging its own progress.
      // A throw from there used to propagate into the shutdown step doing the logging and kill
      // it outright; that is how a force-close timer stopped forcing anything and left the app
      // draining a half-closed socket forever. There is nowhere useful to report this: the log
      // is the reporting channel.
    }
  }
}

export const logInfo = (message: string): void => log('info', message);
export const logWarn = (message: string): void => log('warn', message);
export const logError = (message: string): void => log('error', message);

export function getLog(): LogEntry[] {
  return [...entries];
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatLogForClipboard(): string {
  return entries
    .map((e) => `${new Date(e.time).toISOString()}  ${e.level.padEnd(5)}  ${e.message}`)
    .join('\n');
}

/** Machine-readable diagnostics export. Messages are already redacted on insertion. */
export function formatLogAsJson(): string {
  return JSON.stringify(
    entries.map((e) => ({
      time: new Date(e.time).toISOString(),
      level: e.level,
      message: e.message
    })),
    null,
    2
  );
}

/** Absolute path of the on-disk mirror, for "reveal in folder" and "open log file". */
export function getLogFilePath(): string | null {
  return logFilePath;
}

/**
 * Empties the in-memory ring the Activity view reads. The file mirror is deliberately left
 * alone: it is the record that outlives the process, and clearing a crowded panel should not
 * destroy the evidence someone is about to be asked for.
 */
export function clearLog(): void {
  entries.length = 0;
  entriesBytes = 0;
}
