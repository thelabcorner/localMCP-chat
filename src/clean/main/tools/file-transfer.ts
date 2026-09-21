/** First-party file movement between ChatGPT/OpenAI storage and approved local roots. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Root } from '../../../shared/types.js';
import { getOpenAiApiKey } from '../../../main/secrets.js';
import { rawRealpathNative } from '../../../main/rawfs.js';
import { openChatGptFile } from '../../../main/files/chatgpt-file-reference.js';
import { FileTransferError, asFileTransferError } from '../../../main/files/errors.js';
import { openLocalFileSource } from '../../../main/files/local-file-source.js';
import { openLocalFileTarget } from '../../../main/files/local-file-target.js';
import {
  getOpenAiFile,
  listOpenAiFiles,
  openOpenAiFileContent,
  OPENAI_FILE_PURPOSES,
  OPENAI_FILE_UPLOAD_LIMIT_BYTES,
  uploadOpenAiFile,
  type OpenAiFileMetadata,
  type OpenAiFilePurpose,
} from '../../../main/files/openai-files-client.js';
import { resolveToolPath } from './common.js';
import type { ToolPermissions } from '../state.js';

export type FileTransferAction =
  | 'save_chatgpt_file'
  | 'upload_openai_file'
  | 'download_openai_file'
  | 'get_openai_file'
  | 'list_openai_files';

export interface FileTransferInput {
  action?: FileTransferAction;
  source_file?: unknown;
  source?: string;
  destination?: string;
  file_id?: string;
  purpose?: OpenAiFilePurpose;
  limit?: number;
  after?: string;
}

function failure(error: unknown): CallToolResult {
  const safe = asFileTransferError(error);
  const text = `${safe.code}: ${safe.message}`;
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: { code: safe.code, ambiguous: safe.ambiguous, text },
  };
}

function success(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { ...structuredContent, text } };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]!; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}

function compactMetadata(file: OpenAiFileMetadata): Record<string, unknown> {
  return {
    id: file.id,
    filename: file.filename,
    bytes: file.bytes,
    purpose: file.purpose,
    created_at: file.created_at,
    expires_at: file.expires_at ?? null,
  };
}

function requireAction(input: FileTransferInput): FileTransferAction {
  const action = input.action;
  if (!action || !['save_chatgpt_file', 'upload_openai_file', 'download_openai_file', 'get_openai_file', 'list_openai_files'].includes(action)) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Choose a valid file_transfer action.');
  }
  return action;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', `${field} is required.`);
  return value.trim();
}

async function apiKey(): Promise<string> {
  let value: string | null;
  try { value = await getOpenAiApiKey(); }
  catch {
    throw new FileTransferError('FILE_TRANSFER_OPENAI_AUTH_FAILED', 'The configured OpenAI API credential could not be loaded securely.');
  }
  if (!value) throw new FileTransferError('FILE_TRANSFER_OPENAI_AUTH_REQUIRED', 'OpenAI Files actions require an OpenAI API key in protected localMCP credential storage or runtime configuration.');
  return value;
}

async function prepareTarget(roots: readonly Root[], destination: string) {
  if (/[/\\]$/u.test(destination.trim())) throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'destination must name a file, not a folder.');
  try {
    const resolved = await resolveToolPath(roots, destination, { allowMissing: true });
    const rootReal = await rawRealpathNative(resolved.root.path);
    const target = await openLocalFileTarget(path.dirname(resolved.real), rootReal, path.basename(resolved.real), OPENAI_FILE_UPLOAD_LIMIT_BYTES);
    return { resolved, target };
  } catch (error) {
    if (error instanceof FileTransferError) throw error;
    throw new FileTransferError('FILE_TRANSFER_LOCAL_WRITE_FAILED', 'Destination is unavailable or outside the approved filesystem boundary.');
  }
}

async function streamIntoTarget(
  target: Awaited<ReturnType<typeof openLocalFileTarget>>,
  stream: NodeJS.ReadableStream & AsyncIterable<unknown>,
  expectedSize?: number,
): Promise<{ bytes: number; sha256: string }> {
  if (expectedSize !== undefined && expectedSize > OPENAI_FILE_UPLOAD_LIMIT_BYTES) {
    throw new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'Remote file exceeds the 512 MiB transfer limit.');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const raw of stream) {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw as Uint8Array);
    if (bytes + chunk.length > OPENAI_FILE_UPLOAD_LIMIT_BYTES) throw new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'Remote file exceeds the 512 MiB transfer limit.');
    await target.writeAll(chunk, bytes);
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (expectedSize !== undefined && expectedSize !== bytes) throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'Remote file size did not match its metadata.');
  await target.syncAndVerify(bytes);
  await target.publish();
  return { bytes, sha256: hash.digest('hex') };
}

export async function fileTransferTool(
  roots: readonly Root[],
  input: FileTransferInput,
  permissions: ToolPermissions,
): Promise<CallToolResult> {
  try {
    const action = requireAction(input);
    if (action === 'save_chatgpt_file') {
      if (!permissions.filesReceive || !permissions.write) throw new FileTransferError('FILE_TRANSFER_DISABLED', 'Receiving ChatGPT files requires Receive files and Write capabilities.');
      if (input.source_file === undefined) throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'source_file must be supplied by ChatGPT for save_chatgpt_file.');
      const destination = requiredString(input.destination, 'destination');
      const { resolved, target } = await prepareTarget(roots, destination);
      let opened: Awaited<ReturnType<typeof openChatGptFile>> | undefined;
      try {
        opened = await openChatGptFile(input.source_file);
        const saved = await streamIntoTarget(target, opened.stream, opened.contentLength);
        return success(
          `Saved ${resolved.virtual} (${formatBytes(saved.bytes)}, sha256:${saved.sha256}).`,
          { action, path: resolved.virtual, bytes: saved.bytes, sha256: saved.sha256, source_file_id: opened.reference.file_id },
        );
      } finally {
        opened?.stream.destroy();
        await target.close().catch(() => undefined);
      }
    }

    if (action === 'upload_openai_file') {
      if (!permissions.filesSend || !permissions.read) throw new FileTransferError('FILE_TRANSFER_DISABLED', 'Uploading local files requires Send files to OpenAI and Read capabilities.');
      const sourcePath = requiredString(input.source, 'source');
      const purpose = input.purpose ?? 'user_data';
      if (!OPENAI_FILE_PURPOSES.includes(purpose)) throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Unsupported OpenAI file purpose.');
      const source = await openLocalFileSource(roots, sourcePath, OPENAI_FILE_UPLOAD_LIMIT_BYTES);
      try {
        const uploaded = await uploadOpenAiFile(await apiKey(), source, purpose);
        return success(
          `Uploaded ${source.virtual} to OpenAI as ${uploaded.id} (${uploaded.purpose}, ${formatBytes(uploaded.bytes)}).`,
          { action, source: source.virtual, file_id: uploaded.id, filename: uploaded.filename, bytes: uploaded.bytes, purpose: uploaded.purpose, created_at: uploaded.created_at, expires_at: uploaded.expires_at ?? null },
        );
      } finally { await source.close(); }
    }

    if (action === 'download_openai_file') {
      if (!permissions.filesReceive || !permissions.write) throw new FileTransferError('FILE_TRANSFER_DISABLED', 'Downloading OpenAI files requires Receive files and Write capabilities.');
      const fileId = requiredString(input.file_id, 'file_id');
      const destination = requiredString(input.destination, 'destination');
      const key = await apiKey();
      const metadata = await getOpenAiFile(key, fileId);
      if (metadata.bytes > OPENAI_FILE_UPLOAD_LIMIT_BYTES) throw new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'OpenAI file exceeds the 512 MiB transfer limit.');
      const { resolved, target } = await prepareTarget(roots, destination);
      let opened: Awaited<ReturnType<typeof openOpenAiFileContent>> | undefined;
      try {
        opened = await openOpenAiFileContent(key, metadata.id);
        if (opened.contentLength !== undefined && opened.contentLength !== metadata.bytes) throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI content length did not match file metadata.');
        const saved = await streamIntoTarget(target, opened.stream, metadata.bytes);
        return success(
          `Downloaded ${metadata.id} to ${resolved.virtual} (${formatBytes(saved.bytes)}, sha256:${saved.sha256}).`,
          { action, file_id: metadata.id, path: resolved.virtual, bytes: saved.bytes, sha256: saved.sha256, filename: metadata.filename, purpose: metadata.purpose },
        );
      } finally {
        opened?.stream.destroy();
        await target.close().catch(() => undefined);
      }
    }

    if (!permissions.filesReceive && !permissions.filesSend) throw new FileTransferError('FILE_TRANSFER_DISABLED', 'OpenAI file metadata access requires Receive files or Send files capability.');
    const key = await apiKey();
    if (action === 'get_openai_file') {
      const file = await getOpenAiFile(key, requiredString(input.file_id, 'file_id'));
      return success(`OpenAI file ${file.id}: ${file.filename} (${formatBytes(file.bytes)}, ${file.purpose}).`, { action, file: compactMetadata(file) });
    }
    const listed = await listOpenAiFiles(key, { limit: input.limit, after: input.after, purpose: input.purpose });
    return success(
      `Found ${listed.data.length} OpenAI file${listed.data.length === 1 ? '' : 's'}${listed.has_more ? '; more are available' : ''}.`,
      { action, files: listed.data.map(compactMetadata), has_more: listed.has_more, first_id: listed.first_id ?? null, last_id: listed.last_id ?? null },
    );
  } catch (error) {
    return failure(error);
  }
}
