import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Root } from '../../../shared/types.js';
import { resolvePath } from '../../../main/sandbox.js';

export const MAX_MODEL_OUTPUT_BYTES = 96 * 1024;

export function ok(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  const projected = structuredContent
    ? (Object.prototype.hasOwnProperty.call(structuredContent, 'output') || Object.prototype.hasOwnProperty.call(structuredContent, 'text')
        ? structuredContent
        : { ...structuredContent, text })
    : undefined;
  return {
    content: [{ type: 'text', text }],
    ...(projected ? { structuredContent: projected } : {})
  };
}

export function fail(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncateUtf8(text: string, maxBytes = MAX_MODEL_OUTPUT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] ?? 0) >> 6 === 0b10) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

export function normalizeRelativeInput(input: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path must be a non-empty string');
  return input.trim();
}

/**
 * No conversation-derived cwd exists in localMCP-chat. Relative paths are accepted only when
 * exactly one root is approved, making the shorthand deterministic. With multiple roots the
 * caller must name /<root>/... explicitly.
 */
export async function resolveToolPath(
  roots: readonly Root[],
  input: string,
  options: { allowMissing?: boolean } = {}
): Promise<{ real: string; virtual: string; root: Root }> {
  const value = normalizeRelativeInput(input);
  const absoluteLike = value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(value);
  if (absoluteLike) return resolvePath(roots, value, options);
  if (roots.length !== 1) {
    throw new Error(`Relative path ${JSON.stringify(value)} is ambiguous because ${roots.length} roots are approved. Use /<root>/... explicitly.`);
  }
  return resolvePath(roots, value, { ...options, base: `/${roots[0]!.name}` });
}

export async function resolveDirectory(roots: readonly Root[], input?: string): Promise<{ real: string; virtual: string; root: Root }> {
  const target = input ?? (roots.length === 1 ? `/${roots[0]!.name}` : '');
  if (!target) throw new Error('workdir is required when more than one root is approved');
  const resolved = await resolveToolPath(roots, target);
  const stat = await fs.stat(resolved.real);
  if (!stat.isDirectory()) throw new Error(`${resolved.virtual} is not a directory`);
  return resolved;
}

export function relativeDisplay(root: string, file: string): string {
  const value = path.relative(root, file).split(path.sep).join('/');
  return value || '.';
}

export class ReadCache {
  private entries = new Map<string, { mtimeMs: number; size: number; readAtMs: number }>();
  constructor(private readonly max = 1024) {}

  record(realPath: string, stat: { mtimeMs: number; size: number }): void {
    const key = this.key(realPath);
    if (!this.entries.has(key) && this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, readAtMs: Date.now() });
  }

  async freshness(realPath: string): Promise<{ stale: boolean; missing: boolean }> {
    const prior = this.entries.get(this.key(realPath));
    if (!prior) return { stale: false, missing: true };
    const current = await fs.stat(realPath);
    return { stale: current.mtimeMs !== prior.mtimeMs || current.size !== prior.size, missing: false };
  }

  private key(realPath: string): string {
    const normalized = path.resolve(realPath);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }
}

export const readCache = new ReadCache();
