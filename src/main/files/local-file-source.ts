/** Stable approved-root file source for local -> OpenAI uploads. */
import { Readable } from 'node:stream';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../shared/types.js';
import { rawPromises as fs } from '../rawfs.js';
import { resolvePath } from '../sandbox.js';
import { FileTransferError } from './errors.js';

export interface LocalFileSource {
  readonly real: string;
  readonly virtual: string;
  readonly filename: string;
  readonly size: number;
  readonly stream: Readable;
  verifyStable(): Promise<void>;
  close(): Promise<void>;
}

function sameSnapshot(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>,
): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
}

function sameIdentity(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>,
  right: Awaited<ReturnType<typeof fs.lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Uses the same deterministic relative-path rule as clean tools without importing renderer/tool code. */
async function resolveSource(roots: readonly Root[], input: string): Promise<{ real: string; virtual: string }> {
  if (typeof input !== 'string' || !input.trim()) throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'source must be a non-empty path.');
  const value = input.trim();
  const absoluteLike = value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:[\\/]/u.test(value);
  if (absoluteLike) return resolvePath(roots, value);
  if (roots.length !== 1) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Relative source paths require exactly one approved root.');
  }
  return resolvePath(roots, value, { base: `/${roots[0]!.name}` });
}

export async function openLocalFileSource(
  roots: readonly Root[],
  requestedPath: string,
  maxBytes: number,
): Promise<LocalFileSource> {
  let resolved: Awaited<ReturnType<typeof resolveSource>>;
  try { resolved = await resolveSource(roots, requestedPath); }
  catch (error) {
    if (error instanceof FileTransferError) throw error;
    throw new FileTransferError('FILE_TRANSFER_LOCAL_READ_FAILED', 'Local source is unavailable or outside the approved filesystem boundary.');
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(resolved.real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  }
  catch { throw new FileTransferError('FILE_TRANSFER_LOCAL_READ_FAILED', 'Local source could not be opened.'); }
  const snapshot = await handle.stat();
  const pathSnapshot = await fs.lstat(resolved.real).catch(() => null);
  if (!snapshot.isFile() || !pathSnapshot?.isFile() || pathSnapshot.isSymbolicLink() || !sameIdentity(snapshot, pathSnapshot)) {
    await handle.close();
    throw new FileTransferError('FILE_TRANSFER_LOCAL_READ_FAILED', 'Local source must remain the same regular file while it is opened.');
  }
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size > maxBytes) {
    await handle.close();
    throw new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'Local source exceeds the 512 MiB OpenAI file limit.');
  }
  const stream = snapshot.size === 0
    ? Readable.from([])
    : handle.createReadStream({ autoClose: false, start: 0, end: snapshot.size - 1 });
  let closed = false;
  return {
    real: resolved.real,
    virtual: resolved.virtual,
    filename: path.basename(resolved.real),
    size: snapshot.size,
    stream,
    async verifyStable() {
      if (closed) throw new FileTransferError('FILE_TRANSFER_SOURCE_CHANGED', 'Local source was closed before verification.');
      let current;
      let pathCurrent;
      try {
        [current, pathCurrent] = await Promise.all([handle.stat(), fs.lstat(resolved.real)]);
      }
      catch { throw new FileTransferError('FILE_TRANSFER_SOURCE_CHANGED', 'Local source changed during upload.'); }
      if (
        !sameSnapshot(snapshot, current) ||
        !pathCurrent.isFile() || pathCurrent.isSymbolicLink() || !sameIdentity(snapshot, pathCurrent)
      ) {
        throw new FileTransferError('FILE_TRANSFER_SOURCE_CHANGED', 'Local source changed during upload.');
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      stream.destroy();
      await handle.close().catch(() => undefined);
    },
  };
}
