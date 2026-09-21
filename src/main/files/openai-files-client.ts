/** Minimal fixed-origin OpenAI Files API client with streaming upload/download bodies. */
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { LocalFileSource } from './local-file-source.js';
import { FileTransferError } from './errors.js';
import { withStreamDeadline } from './stream-deadline.js';

const API_ORIGIN = 'https://api.openai.com';
const API_PREFIX = '/v1';
const JSON_RESPONSE_LIMIT = 2 * 1024 * 1024;
const HEADER_TIMEOUT_MS = 30_000;
const BODY_IDLE_TIMEOUT_MS = 30_000;
const BODY_TOTAL_TIMEOUT_MS = 255_000;
const UPLOAD_SOCKET_TIMEOUT_MS = 30_000;
const UPLOAD_TOTAL_TIMEOUT_MS = 285_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export const OPENAI_FILE_UPLOAD_LIMIT_BYTES = 512 * 1024 * 1024;
export const OPENAI_FILE_PURPOSES = ['assistants', 'batch', 'fine-tune', 'vision', 'user_data', 'evals'] as const;
export type OpenAiFilePurpose = typeof OPENAI_FILE_PURPOSES[number];

export interface OpenAiFileMetadata {
  id: string;
  bytes: number;
  created_at: number;
  filename: string;
  purpose: string;
  expires_at?: number;
}

export interface OpenAiFileList {
  data: OpenAiFileMetadata[];
  first_id?: string;
  last_id?: string;
  has_more: boolean;
}

export interface OpenAiFileContent {
  stream: Readable;
  contentLength?: number;
}

export interface OpenAiUploadOptions {
  /** Test seam only. Production always uses node:https against the fixed api.openai.com request. */
  request?: (options: RequestOptions) => ClientRequest;
  socketTimeoutMs?: number;
}

function validateApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (!key) throw new FileTransferError('FILE_TRANSFER_OPENAI_AUTH_REQUIRED', 'OpenAI Files actions require the configured OpenAI API key.');
  if (/[\r\n]/u.test(key)) throw new FileTransferError('FILE_TRANSFER_OPENAI_AUTH_FAILED', 'Configured OpenAI API key is invalid.');
  return key;
}

export function validateOpenAiFileId(value: unknown): string {
  if (typeof value !== 'string' || !/^file-[A-Za-z0-9_-]{1,500}$/u.test(value)) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'file_id must be a valid OpenAI Files API file-* identifier.');
  }
  return value;
}

function mapStatus(status: number): FileTransferError {
  if (status === 401 || status === 403) return new FileTransferError('FILE_TRANSFER_OPENAI_AUTH_FAILED', 'OpenAI rejected the configured API credential or project access.');
  if (status === 404) return new FileTransferError('FILE_TRANSFER_OPENAI_NOT_FOUND', 'OpenAI file was not found in the configured API project.');
  if (status === 413) return new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'OpenAI rejected the file as too large.');
  if (status === 429) return new FileTransferError('FILE_TRANSFER_OPENAI_RATE_LIMITED', 'OpenAI Files API rate limit was reached; retry later.');
  return new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', `OpenAI Files API returned HTTP ${status}.`);
}

function mapUploadStatus(status: number): FileTransferError {
  if (status === 408 || status >= 500) {
    return new FileTransferError(
      'FILE_TRANSFER_UPLOAD_AMBIGUOUS',
      `OpenAI returned HTTP ${status} after upload transmission. The file may exist; list recent files before retrying.`,
      true,
    );
  }
  return mapStatus(status);
}

function parseRemoteFileId(value: unknown): string {
  if (typeof value !== 'string' || !/^file-[A-Za-z0-9_-]{1,500}$/u.test(value)) {
    throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned a malformed file identifier.');
  }
  return value;
}

function parseMetadata(value: unknown): OpenAiFileMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned malformed file metadata.');
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' || !/^file-[A-Za-z0-9_-]{1,500}$/u.test(row.id) ||
    typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
    typeof row.created_at !== 'number' || !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
    typeof row.filename !== 'string' || row.filename.length > 4096 || CONTROL.test(row.filename) ||
    typeof row.purpose !== 'string' || row.purpose.length > 128 || CONTROL.test(row.purpose)
  ) throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned malformed file metadata.');
  const expires = row.expires_at;
  if (expires !== undefined && expires !== null && (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < 0)) {
    throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned malformed file metadata.');
  }
  return {
    id: row.id,
    bytes: row.bytes,
    created_at: row.created_at,
    filename: row.filename,
    purpose: row.purpose,
    ...(typeof expires === 'number' ? { expires_at: expires } : {}),
  };
}

async function boundedResponseText(response: Response, maxBytes = JSON_RESPONSE_LIMIT): Promise<string> {
  if (!response.body) return '';
  const stream = withStreamDeadline(Readable.fromWeb(response.body as unknown as NodeReadableStream), {
    idleMs: HEADER_TIMEOUT_MS,
    totalMs: HEADER_TIMEOUT_MS,
    timeoutError: () => new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI metadata response timed out.'),
  });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.from(raw as Uint8Array);
      size += chunk.length;
      if (size > maxBytes) throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI metadata response exceeded the safety limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size).toString('utf8');
  } finally { stream.destroy(); }
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw mapStatus(response.status);
  }
  const text = await boundedResponseText(response);
  try { return JSON.parse(text); }
  catch { throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned invalid JSON metadata.'); }
}

async function apiFetch(apiKey: string, path: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(`${API_ORIGIN}${API_PREFIX}${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${validateApiKey(apiKey)}` },
    });
  } catch (error) {
    if (error instanceof FileTransferError) throw error;
    throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI Files API could not be reached.');
  } finally { clearTimeout(timer); }
}

export async function getOpenAiFile(apiKey: string, fileId: string, fetchImpl?: typeof fetch): Promise<OpenAiFileMetadata> {
  const id = validateOpenAiFileId(fileId);
  return parseMetadata(await jsonResponse(await apiFetch(apiKey, `/files/${encodeURIComponent(id)}`, fetchImpl)));
}

export async function listOpenAiFiles(
  apiKey: string,
  options: { limit?: number; after?: string; purpose?: OpenAiFilePurpose } = {},
  fetchImpl?: typeof fetch,
): Promise<OpenAiFileList> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'list limit must be between 1 and 100.');
  }
  if (options.purpose !== undefined && !OPENAI_FILE_PURPOSES.includes(options.purpose)) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Unsupported OpenAI file purpose filter.');
  }
  const query = new URLSearchParams({ limit: String(limit), order: 'desc' });
  if (options.after !== undefined) query.set('after', validateOpenAiFileId(options.after));
  if (options.purpose !== undefined) query.set('purpose', options.purpose);
  const value = await jsonResponse(await apiFetch(apiKey, `/files?${query.toString()}`, fetchImpl));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned a malformed file list.');
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.data) || typeof row.has_more !== 'boolean') throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned a malformed file list.');
  const data = row.data.slice(0, limit).map(parseMetadata);
  const first = row.first_id === undefined || row.first_id === null ? undefined : parseRemoteFileId(row.first_id);
  const last = row.last_id === undefined || row.last_id === null ? undefined : parseRemoteFileId(row.last_id);
  return { data, has_more: row.has_more, ...(first ? { first_id: first } : {}), ...(last ? { last_id: last } : {}) };
}

export async function openOpenAiFileContent(apiKey: string, fileId: string, fetchImpl?: typeof fetch): Promise<OpenAiFileContent> {
  const id = validateOpenAiFileId(fileId);
  const response = await apiFetch(apiKey, `/files/${encodeURIComponent(id)}/content`, fetchImpl);
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw mapStatus(response.status);
  }
  const rawLength = response.headers.get('content-length');
  const parsedLength = rawLength && /^\d+$/u.test(rawLength) ? Number(rawLength) : undefined;
  return {
    stream: withStreamDeadline(Readable.fromWeb(response.body as unknown as NodeReadableStream), {
      idleMs: BODY_IDLE_TIMEOUT_MS,
      totalMs: BODY_TOTAL_TIMEOUT_MS,
      timeoutError: () => new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI file download timed out.'),
    }),
    ...(parsedLength !== undefined && Number.isSafeInteger(parsedLength) ? { contentLength: parsedLength } : {}),
  };
}

function quotedFilename(filename: string): string {
  const printable = filename.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\\r\n]/gu, '_').slice(0, 180) || 'file';
  return printable;
}

function multipartParts(filename: string, purpose: OpenAiFilePurpose, boundary: string): { prefix: Buffer; suffix: Buffer } {
  let encoded: string;
  try { encoded = encodeURIComponent(filename); }
  catch { encoded = encodeURIComponent(quotedFilename(filename)); }
  encoded = encoded.replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quotedFilename(filename)}"; filename*=UTF-8''${encoded}\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { prefix, suffix };
}

async function writeRequestChunk(request: ReturnType<typeof https.request>, chunk: Buffer): Promise<void> {
  if (request.destroyed) throw new Error('request closed');
  if (!request.write(chunk)) await once(request, 'drain');
}

async function boundedIncomingJson(response: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of response) {
    const chunk = Buffer.from(raw as Uint8Array);
    size += chunk.length;
    if (size > JSON_RESPONSE_LIMIT) {
      response.destroy();
      throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI upload response exceeded the safety limit.');
    }
    chunks.push(chunk);
  }
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) throw mapUploadStatus(status);
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned invalid upload metadata.'); }
}

/** Streams multipart bytes directly from the open local file handle; no Blob/FormData buffering. */
export async function uploadOpenAiFile(
  apiKey: string,
  source: LocalFileSource,
  purpose: OpenAiFilePurpose = 'user_data',
  options: OpenAiUploadOptions = {},
): Promise<OpenAiFileMetadata> {
  validateApiKey(apiKey);
  if (!OPENAI_FILE_PURPOSES.includes(purpose)) throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'Unsupported OpenAI file purpose.');
  if (source.size > OPENAI_FILE_UPLOAD_LIMIT_BYTES) throw new FileTransferError('FILE_TRANSFER_TOO_LARGE', 'Local source exceeds the 512 MiB OpenAI file limit.');
  const boundary = `----localmcp-${randomBytes(18).toString('hex')}`;
  const { prefix, suffix } = multipartParts(source.filename, purpose, boundary);
  const contentLength = prefix.length + source.size + suffix.length;
  let bodyStarted = false;

  const requestOptions: RequestOptions = {
    protocol: 'https:', hostname: 'api.openai.com', port: 443, method: 'POST', path: '/v1/files',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(contentLength),
      Accept: 'application/json',
    },
  };
  let request: ClientRequest;
  try { request = (options.request ?? https.request)(requestOptions); }
  catch { throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI upload could not be started.'); }
  request.setTimeout(options.socketTimeoutMs ?? UPLOAD_SOCKET_TIMEOUT_MS, () => request.destroy(new Error('timeout')));
  const totalTimer = setTimeout(() => request.destroy(new Error('total timeout')), UPLOAD_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();
  let earlyResponse: IncomingMessage | undefined;
  const responsePromise = new Promise<IncomingMessage>((resolve, reject) => {
    request.once('response', (response) => { earlyResponse = response; resolve(response); });
    request.once('error', reject);
  });
  // Observe immediately so a socket error that races the streaming writer never becomes an
  // unhandled rejection before the code below reaches the response await.
  void responsePromise.catch(() => undefined);

  const rejectEarlyResponse = async (): Promise<void> => {
    if (!earlyResponse) return;
    const status = earlyResponse.statusCode ?? 0;
    earlyResponse.destroy();
    request.destroy();
    if (status >= 200 && status < 300) {
      throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI returned a success response before the upload body completed.');
    }
    throw mapUploadStatus(status);
  };

  try {
    bodyStarted = true;
    await writeRequestChunk(request, prefix);
    await rejectEarlyResponse();
    for await (const raw of source.stream) {
      await writeRequestChunk(request, Buffer.from(raw as Uint8Array));
      await rejectEarlyResponse();
    }
    await writeRequestChunk(request, suffix);
    await rejectEarlyResponse();
    request.end();
    const metadata = parseMetadata(await boundedIncomingJson(await responsePromise));
    try { await source.verifyStable(); }
    catch {
      throw new FileTransferError(
        'FILE_TRANSFER_SOURCE_CHANGED',
        `Local source changed while uploading. OpenAI returned ${metadata.id}; inspect that file before retrying.`,
        true,
      );
    }
    return metadata;
  } catch (error) {
    request.destroy();
    if (error instanceof FileTransferError) throw error;
    if (bodyStarted) {
      throw new FileTransferError(
        'FILE_TRANSFER_UPLOAD_AMBIGUOUS',
        'Upload connection failed after request-body transmission began. The file may exist in OpenAI; list recent files before retrying.',
        true,
      );
    }
    throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'OpenAI upload could not be started.');
  } finally { clearTimeout(totalTimer); }
}

export const OPENAI_FILES_API_ORIGIN = API_ORIGIN;
