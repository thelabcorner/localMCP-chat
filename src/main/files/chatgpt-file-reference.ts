/**
 * ChatGPT-native file ingress.
 *
 * FILE_TRANSFER boundary: this module never receives an OpenAI API key. The temporary
 * download_url is already the capability for the current host-provided file value.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { FileTransferError } from './errors.js';
import { withStreamDeadline } from './stream-deadline.js';

const CHATGPT_FILE_HOSTS = new Set([
  'files.oaiusercontent.com',
  // Historical/observed OpenAI image-generation delivery host. Keep exact hosts only.
  'oaidalleapiprodscus.blob.core.windows.net',
]);
const FILE_ID_MAX_LENGTH = 512;
const VALUE_MAX_LENGTH = 16_384;
const OPTIONAL_VALUE_MAX_LENGTH = 1024;
const REDIRECT_LIMIT = 3;
const HEADER_TIMEOUT_MS = 30_000;
const BODY_IDLE_TIMEOUT_MS = 30_000;
const BODY_TOTAL_TIMEOUT_MS = 255_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ALLOWED_KEYS = new Set(['download_url', 'file_id', 'mime_type', 'file_name']);

export interface ChatGptFileReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface ChatGptFileSource {
  stream: Readable;
  contentLength?: number;
  reference: ChatGptFileReference;
}

export interface ChatGptFileOpenOptions {
  fetch?: typeof fetch;
  headerTimeoutMs?: number;
}

export function normalizeChatGptFileReference(value: unknown): ChatGptFileReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidReference();
  }
  const row = value as Record<string, unknown>;
  if (!Object.keys(row).every((key) => ALLOWED_KEYS.has(key))) throw invalidReference();
  const downloadUrl = row['download_url'];
  const fileId = row['file_id'];
  if (
    typeof downloadUrl !== 'string' || downloadUrl.length === 0 || downloadUrl.length > VALUE_MAX_LENGTH ||
    typeof fileId !== 'string' || fileId.length === 0 || fileId.length > FILE_ID_MAX_LENGTH || CONTROL.test(fileId)
  ) throw invalidReference();
  const mimeType = optionalBounded(row['mime_type']);
  const fileName = optionalBounded(row['file_name']);
  if (mimeType === null || fileName === null) throw invalidReference();
  return {
    download_url: downloadUrl,
    file_id: fileId,
    ...(mimeType === undefined ? {} : { mime_type: mimeType }),
    ...(fileName === undefined ? {} : { file_name: fileName }),
  };
}

function optionalBounded(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && value.length <= OPTIONAL_VALUE_MAX_LENGTH && !CONTROL.test(value) ? value : null;
}

function invalidReference(): FileTransferError {
  return new FileTransferError('FILE_TRANSFER_CHATGPT_REFERENCE_INVALID', 'ChatGPT supplied an invalid native file reference.');
}

export function validateChatGptFileUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw invalidReference(); }
  if (
    value.length > VALUE_MAX_LENGTH ||
    url.protocol !== 'https:' ||
    !CHATGPT_FILE_HOSTS.has(url.hostname.toLowerCase()) ||
    (url.port !== '' && url.port !== '443') ||
    url.username !== '' || url.password !== '' || url.hash !== ''
  ) {
    throw new FileTransferError(
      'FILE_TRANSFER_CHATGPT_REFERENCE_INVALID',
      `ChatGPT file download uses an untrusted host (${url.hostname.slice(0, 253) || 'none'}).`,
    );
  }
  return url.toString();
}

function redirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (!raw || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function fetchHeaders(fetchFile: typeof fetch, url: string, timeoutMs: number): Promise<Response> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new FileTransferError('FILE_TRANSFER_INVALID_INPUT', 'File download header timeout must be a positive integer.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchFile(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
  } catch {
    throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'ChatGPT file could not be reached.');
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches one host-injected reference with redirect-by-redirect host validation. */
export async function openChatGptFile(
  value: unknown,
  options: ChatGptFileOpenOptions = {},
): Promise<ChatGptFileSource> {
  const reference = normalizeChatGptFileReference(value);
  const fetchFile = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.headerTimeoutMs ?? HEADER_TIMEOUT_MS;
  let url = validateChatGptFileUrl(reference.download_url);
  let response: Response | undefined;

  for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
    response = await fetchHeaders(fetchFile, url, timeoutMs);
    if (!redirectStatus(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === REDIRECT_LIMIT) {
      throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'ChatGPT file download returned too many or invalid redirects.');
    }
    try { url = validateChatGptFileUrl(new URL(location, url).toString()); }
    catch (error) {
      if (error instanceof FileTransferError) throw error;
      throw invalidReference();
    }
  }

  if (!response?.ok || !response.body) {
    await response?.body?.cancel().catch(() => undefined);
    throw new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', `ChatGPT file download failed with HTTP ${response?.status ?? 'unknown'}.`);
  }
  const source = Readable.fromWeb(response.body as unknown as NodeReadableStream);
  return {
    reference,
    contentLength: contentLength(response),
    stream: withStreamDeadline(source, {
      idleMs: BODY_IDLE_TIMEOUT_MS,
      totalMs: BODY_TOTAL_TIMEOUT_MS,
      timeoutError: () => new FileTransferError('FILE_TRANSFER_REMOTE_FAILED', 'ChatGPT file transfer timed out.'),
    }),
  };
}

export const CHATGPT_FILE_HOST_ALLOWLIST = Object.freeze([...CHATGPT_FILE_HOSTS]);
