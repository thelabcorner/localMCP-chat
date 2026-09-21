/** Race-resistant, same-directory temporary target used by both remote -> local transfer lanes. */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { rawPromises as fs, rawRealpathNative } from '../rawfs.js';
import { FileTransferError } from './errors.js';

const PARTIAL_PREFIX = '.localmcp-transfer-';
const PARTIAL_SUFFIX = '.partial';
type FileStat = Awaited<ReturnType<typeof fs.lstat>>;

export interface LocalFileTarget {
  readonly size: number;
  writeAll(chunk: Buffer, position: number): Promise<void>;
  syncAndVerify(expectedSize: number): Promise<void>;
  publish(): Promise<void>;
  close(): Promise<void>;
}

function normalized(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function samePath(left: string, right: string): boolean { return normalized(left) === normalized(right); }
function sameFile(left: FileStat, right: FileStat): boolean { return left.dev === right.dev && left.ino === right.ino; }

export async function openLocalFileTarget(
  parentReal: string,
  rootReal: string,
  name: string,
  maxBytes: number,
): Promise<LocalFileTarget> {
  if (!name || name === '.' || name === '..' || /[/\\:\u0000-\u001f]/u.test(name)) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Destination must name a normal file.');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Transfer size limit is invalid.');
  }
  const relative = path.relative(normalized(rootReal), normalized(parentReal));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination escapes its approved folder.');
  }

  let parent: FileStat;
  try { parent = await fs.lstat(parentReal); }
  catch { throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination parent does not exist. Create the folder first.'); }
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination parent must be a real directory.');
  }

  const verifyParent = async (): Promise<void> => {
    try {
      const [current, canonicalParent, canonicalRoot] = await Promise.all([
        fs.lstat(parentReal), rawRealpathNative(parentReal), rawRealpathNative(rootReal),
      ]);
      if (
        !current.isDirectory() || current.isSymbolicLink() || !sameFile(current, parent) ||
        !samePath(canonicalParent, parentReal) || !samePath(canonicalRoot, rootReal)
      ) throw new Error('changed');
    } catch {
      throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination parent changed during transfer.');
    }
  };
  await verifyParent();

  const candidatePath = path.join(parentReal, name);
  const partialPath = path.join(parentReal, `${PARTIAL_PREFIX}${randomUUID()}${PARTIAL_SUFFIX}`);
  try {
    await fs.lstat(candidatePath);
    throw new FileTransferError('FILE_TRANSFER_DESTINATION_EXISTS', 'Destination already exists; file transfer never overwrites existing files.');
  } catch (error) {
    if (error instanceof FileTransferError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination could not be checked safely.');
    }
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      partialPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch {
    throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Could not create an exclusive temporary destination.');
  }
  const original = await handle.stat();
  let written = 0;
  let verified = false;
  let published = false;
  let closed = false;

  const ownedFile = async (file: string): Promise<boolean> => {
    const current = await fs.lstat(file).catch(() => null);
    return !!current && current.isFile() && !current.isSymbolicLink() && sameFile(current, original);
  };
  const verifyPartial = async (): Promise<void> => {
    await verifyParent();
    const [fdStat, pathStat] = await Promise.all([handle.stat(), fs.lstat(partialPath)]);
    if (
      !fdStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
      !sameFile(fdStat, original) || !sameFile(pathStat, original) ||
      fdStat.size !== written || pathStat.size !== written
    ) throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Temporary destination changed before publication.');
  };
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await verifyParent();
      if (await ownedFile(partialPath)) await fs.unlink(partialPath);
    } catch { /* Never remove a path we can no longer prove is ours. */ }
    await handle.close().catch(() => undefined);
  };

  try { await verifyPartial(); }
  catch (error) { await close(); throw error; }

  return {
    get size() { return written; },
    async writeAll(chunk, position) {
      if (closed || verified || position !== written) {
        throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination is no longer writable at the expected position.');
      }
      if (written + chunk.length > maxBytes) {
        throw new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'Remote file exceeds the 512 MiB transfer limit.');
      }
      await verifyParent();
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset, position + offset);
        if (!result.bytesWritten) throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination write was interrupted.');
        offset += result.bytesWritten;
      }
      written += chunk.length;
    },
    async syncAndVerify(expectedSize) {
      if (closed || expectedSize !== written) {
        throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'Downloaded byte count did not match the expected file size.');
      }
      await handle.sync();
      await verifyPartial();
      verified = true;
    },
    async publish() {
      if (closed || !verified) throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination was not verified before publication.');
      if (published) return;
      await verifyPartial();
      try { await fs.link(partialPath, candidatePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new FileTransferError('FILE_TRANSFER_DESTINATION_EXISTS', 'Destination was created by another process during transfer; it was preserved.');
        }
        throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Atomic destination publication failed.');
      }
      await verifyParent();
      if (!await ownedFile(candidatePath)) {
        throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination changed during publication.');
      }
      published = true;
    },
    close,
  };
}
