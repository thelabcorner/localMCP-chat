import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Root } from '../../../shared/types.js';
import {
  normalizeChatGptFileReference,
  openChatGptFile,
  validateChatGptFileUrl,
} from '../../../main/files/chatgpt-file-reference.js';
import { FileTransferError } from '../../../main/files/errors.js';
import { openLocalFileSource } from '../../../main/files/local-file-source.js';
import { openLocalFileTarget } from '../../../main/files/local-file-target.js';
import { getOpenAiFile, listOpenAiFiles, uploadOpenAiFile } from '../../../main/files/openai-files-client.js';
import { fileTransferTool } from './file-transfer.js';

let dir = '';
let roots: Root[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-file-transfer-'));
  roots = [{ name: 'project', path: await fs.realpath(dir) }];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ChatGPT native file ingress', () => {
  it('accepts only the bounded host-injected file shape', () => {
    const reference = normalizeChatGptFileReference({
      download_url: 'https://files.oaiusercontent.com/a/b?sig=secret',
      file_id: 'file-native-1',
      mime_type: 'application/pdf',
      file_name: 'paper.pdf',
    });
    expect(reference.file_id).toBe('file-native-1');
    expect(() => normalizeChatGptFileReference({ ...reference, arbitrary: 'field' })).toThrow(FileTransferError);
    expect(() => validateChatGptFileUrl('https://127.0.0.1/private')).toThrow(/untrusted host/i);
    expect(() => validateChatGptFileUrl('http://files.oaiusercontent.com/file')).toThrow();
  });

  it('streams without Authorization and revalidates redirects', async () => {
    const fetchFile = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-length': '3' } });
    }) as unknown as typeof fetch;
    const opened = await openChatGptFile({
      download_url: 'https://files.oaiusercontent.com/object?sig=private',
      file_id: 'file-native-2',
    }, { fetch: fetchFile });
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(opened.contentLength).toBe(3);

    const redirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://example.com/not-openai' },
    })) as unknown as typeof fetch;
    await expect(openChatGptFile({
      download_url: 'https://files.oaiusercontent.com/object?sig=private',
      file_id: 'file-native-3',
    }, { fetch: redirect })).rejects.toMatchObject({ code: 'FILE_TRANSFER_CHATGPT_REFERENCE_INVALID' });
  });
});

describe('local transfer endpoints', () => {
  it('publishes a completed download atomically and removes its private partial', async () => {
    const rootReal = await fs.realpath(dir);
    const target = await openLocalFileTarget(rootReal, rootReal, 'received.bin', 1024);
    try {
      await target.writeAll(Buffer.from('hello'), 0);
      await target.syncAndVerify(5);
      await target.publish();
    } finally { await target.close(); }
    expect(await fs.readFile(path.join(dir, 'received.bin'), 'utf8')).toBe('hello');
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.partial'))).toEqual([]);
  });

  it('preserves a destination another actor creates during the transfer', async () => {
    const rootReal = await fs.realpath(dir);
    const target = await openLocalFileTarget(rootReal, rootReal, 'race.bin', 1024);
    try {
      await target.writeAll(Buffer.from('ours'), 0);
      await target.syncAndVerify(4);
      await fs.writeFile(path.join(dir, 'race.bin'), 'external');
      await expect(target.publish()).rejects.toMatchObject({ code: 'FILE_TRANSFER_DESTINATION_EXISTS' });
    } finally { await target.close(); }
    expect(await fs.readFile(path.join(dir, 'race.bin'), 'utf8')).toBe('external');
  });

  it('detects a local upload source changing after it was opened', async () => {
    await fs.writeFile(path.join(dir, 'source.txt'), 'before');
    const source = await openLocalFileSource(roots, '/project/source.txt', 1024);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of source.stream) chunks.push(Buffer.from(chunk as Uint8Array));
      expect(Buffer.concat(chunks).toString('utf8')).toBe('before');
      await new Promise((resolve) => setTimeout(resolve, 12));
      await fs.writeFile(path.join(dir, 'source.txt'), 'changed-after-open');
      await expect(source.verifyStable()).rejects.toMatchObject({ code: 'FILE_TRANSFER_SOURCE_CHANGED' });
    } finally { await source.close(); }
  });

  it('detects pathname replacement even when the originally opened handle is unchanged', async () => {
    const file = path.join(dir, 'identity.txt');
    const old = path.join(dir, 'identity.old.txt');
    await fs.writeFile(file, 'original');
    const source = await openLocalFileSource(roots, '/project/identity.txt', 1024);
    try {
      await fs.rename(file, old);
      await fs.writeFile(file, 'replacement');
      await expect(source.verifyStable()).rejects.toMatchObject({ code: 'FILE_TRANSFER_SOURCE_CHANGED' });
    } finally { await source.close(); }
  });

  it('rejects sources outside approved roots without exposing arbitrary host reads', async () => {
    await expect(openLocalFileSource(roots, path.join(os.tmpdir(), 'outside-localmcp.bin'), 1024))
      .rejects.toMatchObject({ code: 'FILE_TRANSFER_LOCAL_READ_FAILED' });
  });
});

describe('OpenAI Files API metadata client', () => {
  it('uses only the fixed OpenAI origin with bearer auth and bounded list output', async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.includes('?')) {
        return new Response(JSON.stringify({
          object: 'list',
          data: [{ id: 'file-a', bytes: 7, created_at: 1, filename: 'a.txt', purpose: 'user_data' }],
          first_id: 'file-a',
          last_id: 'file-a',
          has_more: false,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 'file-a', bytes: 7, created_at: 1, filename: 'a.txt', purpose: 'user_data' }), { status: 200 });
    }) as unknown as typeof fetch;

    expect((await getOpenAiFile('sk-test-secret', 'file-a', fetchApi)).filename).toBe('a.txt');
    const listed = await listOpenAiFiles('sk-test-secret', { limit: 1, purpose: 'user_data' }, fetchApi);
    expect(listed.data).toHaveLength(1);
    expect(seen.every((request) => request.url.startsWith('https://api.openai.com/v1/files'))).toBe(true);
    expect(seen.every((request) => request.authorization === 'Bearer sk-test-secret')).toBe(true);
  });

  it('maps auth, not-found and rate-limit statuses without returning response bodies', async () => {
    const cases = [
      [401, 'FILE_TRANSFER_OPENAI_AUTH_FAILED'],
      [404, 'FILE_TRANSFER_OPENAI_NOT_FOUND'],
      [429, 'FILE_TRANSFER_OPENAI_RATE_LIMITED'],
    ] as const;
    for (const [status, code] of cases) {
      const fetchApi = (async () => new Response('sensitive upstream detail', { status })) as typeof fetch;
      await expect(getOpenAiFile('sk-secret', 'file-a', fetchApi)).rejects.toMatchObject({ code });
    }
  });

  it('fails closed on malformed remote metadata and list cursors', async () => {
    const malformedFile = (async () => new Response(JSON.stringify({
      id: 'file-a', bytes: 1, created_at: 1, filename: 'bad\nname.txt', purpose: 'user_data',
    }), { status: 200 })) as typeof fetch;
    await expect(getOpenAiFile('sk-secret', 'file-a', malformedFile))
      .rejects.toMatchObject({ code: 'FILE_TRANSFER_REMOTE_FAILED' });

    const malformedList = (async () => new Response(JSON.stringify({
      object: 'list', data: [], first_id: 'not-a-file-id', last_id: null, has_more: true,
    }), { status: 200 })) as typeof fetch;
    await expect(listOpenAiFiles('sk-secret', { limit: 1 }, malformedList))
      .rejects.toMatchObject({ code: 'FILE_TRANSFER_REMOTE_FAILED' });
  });
});

describe('OpenAI streaming upload', () => {
  function response(json: unknown, status = 200): IncomingMessage {
    const message = Readable.from([Buffer.from(JSON.stringify(json))]) as unknown as IncomingMessage;
    message.statusCode = status;
    return message;
  }

  function fakeRequest(
    onOptions: (options: RequestOptions) => void,
    onChunk: (chunk: Buffer, request: PassThrough) => void,
    reply: IncomingMessage,
  ): (options: RequestOptions) => ClientRequest {
    return (options) => {
      onOptions(options);
      const request = new PassThrough();
      (request as unknown as { setTimeout: (ms: number, callback: () => void) => PassThrough }).setTimeout = () => request;
      request.on('data', (chunk: Buffer) => onChunk(Buffer.from(chunk), request));
      request.once('finish', () => queueMicrotask(() => request.emit('response', reply)));
      return request as unknown as ClientRequest;
    };
  }

  it('streams multipart chunks with fixed OpenAI request authority and exact Content-Length', async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    await fs.writeFile(path.join(dir, 'large.bin'), payload);
    const source = await openLocalFileSource(roots, '/project/large.bin', 8 * 1024 * 1024);
    const chunks: number[] = [];
    let options: RequestOptions | undefined;
    try {
      const uploaded = await uploadOpenAiFile('sk-stream-test', source, 'user_data', {
        request: fakeRequest(
          (value) => { options = value; },
          (chunk) => chunks.push(chunk.length),
          response({ id: 'file-streamed', bytes: payload.length, created_at: 10, filename: 'large.bin', purpose: 'user_data' }),
        ),
      });
      expect(uploaded.id).toBe('file-streamed');
      expect(options?.hostname).toBe('api.openai.com');
      expect(options?.path).toBe('/v1/files');
      expect(options?.method).toBe('POST');
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-stream-test');
      expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(Number(headers['Content-Length']));
      // The source body is consumed as stream chunks; a 4 MiB fixture is never materialized as
      // one multipart Buffer. Prefix/suffix are tiny compared with this ceiling.
      expect(Math.max(...chunks)).toBeLessThan(1024 * 1024);
      expect(chunks.length).toBeGreaterThan(4);
    } finally { await source.close(); }
  });

  it('does not retry and reports ambiguity after request-body transmission begins', async () => {
    await fs.writeFile(path.join(dir, 'ambiguous.bin'), Buffer.alloc(256 * 1024, 0x33));
    const source = await openLocalFileSource(roots, '/project/ambiguous.bin', 1024 * 1024);
    let requests = 0;
    let failed = false;
    try {
      await expect(uploadOpenAiFile('sk-ambiguous', source, 'user_data', {
        request: fakeRequest(
          () => { requests += 1; },
          (_chunk, request) => {
            if (failed) return;
            failed = true;
            queueMicrotask(() => request.emit('error', new Error('simulated connection loss')));
          },
          response({ id: 'file-should-not-be-seen', bytes: 0, created_at: 0, filename: 'x', purpose: 'user_data' }),
        ),
      })).rejects.toMatchObject({ code: 'FILE_TRANSFER_UPLOAD_AMBIGUOUS', ambiguous: true });
      expect(requests).toBe(1);
    } finally { await source.close(); }
  });

  it('maps an explicit early authorization rejection without treating it as an unknown network failure', async () => {
    await fs.writeFile(path.join(dir, 'auth.bin'), Buffer.alloc(256 * 1024, 0x44));
    const source = await openLocalFileSource(roots, '/project/auth.bin', 1024 * 1024);
    const reply = response({ error: 'not exposed' }, 401);
    let emitted = false;
    try {
      await expect(uploadOpenAiFile('sk-auth', source, 'user_data', {
        request: fakeRequest(
          () => undefined,
          (_chunk, request) => {
            if (emitted) return;
            emitted = true;
            request.emit('response', reply);
          },
          reply,
        ),
      })).rejects.toMatchObject({ code: 'FILE_TRANSFER_OPENAI_AUTH_FAILED', ambiguous: false });
    } finally { await source.close(); }
  });

  it('treats a server error after body transmission as ambiguous external mutation state', async () => {
    await fs.writeFile(path.join(dir, 'server-error.bin'), Buffer.alloc(32 * 1024, 0x55));
    const source = await openLocalFileSource(roots, '/project/server-error.bin', 1024 * 1024);
    try {
      await expect(uploadOpenAiFile('sk-server-error', source, 'user_data', {
        request: fakeRequest(
          () => undefined,
          () => undefined,
          response({ error: 'not exposed' }, 500),
        ),
      })).rejects.toMatchObject({ code: 'FILE_TRANSFER_UPLOAD_AMBIGUOUS', ambiguous: true });
    } finally { await source.close(); }
  });

  it('classifies request construction failure as clean pre-body failure', async () => {
    await fs.writeFile(path.join(dir, 'prebody.bin'), 'x');
    const source = await openLocalFileSource(roots, '/project/prebody.bin', 1024);
    try {
      await expect(uploadOpenAiFile('sk-prebody', source, 'user_data', {
        request: () => { throw new Error('no socket'); },
      })).rejects.toMatchObject({ code: 'FILE_TRANSFER_REMOTE_FAILED', ambiguous: false });
    } finally { await source.close(); }
  });
});

describe('file_transfer handler', () => {
  const receivePermissions = {
    read: true,
    write: true,
    shell: false,
    git: false,
    plugins: false,
    filesReceive: true,
    filesSend: false,
  };

  it('saves a host-bound ChatGPT file end-to-end without an API credential', async () => {
    const bytes = Buffer.from('native-chatgpt-file\n');
    const fetchFile = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchFile);

    const result = await fileTransferTool(roots, {
      action: 'save_chatgpt_file',
      source_file: {
        download_url: 'https://files.oaiusercontent.com/native?sig=do-not-return-me',
        file_id: 'file-native-e2e',
        mime_type: 'text/plain',
        file_name: 'native.txt',
      },
      destination: '/project/native.txt',
    }, receivePermissions);

    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(path.join(dir, 'native.txt'))).toEqual(bytes);
    const text = result.content.find((block) => block.type === 'text')?.text ?? '';
    expect(text).toContain('/project/native.txt');
    expect(text).not.toContain('sig=');
  });

  it('downloads a public OpenAI file to an approved path with strict metadata size verification', async () => {
    const previous = process.env['LOCALMCP_OPENAI_API_KEY'];
    process.env['LOCALMCP_OPENAI_API_KEY'] = 'sk-file-transfer-test';
    const bytes = Buffer.from([0, 1, 2, 3, 4, 255]);
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk-file-transfer-test');
      const url = String(input);
      if (url.endsWith('/content')) return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
      return new Response(JSON.stringify({
        id: 'file-download-e2e', bytes: bytes.length, created_at: 1, filename: 'remote.bin', purpose: 'user_data',
      }), { status: 200 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchApi);
    try {
      const result = await fileTransferTool(roots, {
        action: 'download_openai_file',
        file_id: 'file-download-e2e',
        destination: '/project/downloaded.bin',
      }, receivePermissions);
      expect(result.isError).not.toBe(true);
      expect(await fs.readFile(path.join(dir, 'downloaded.bin'))).toEqual(bytes);
      expect(fetchApi).toHaveBeenCalledTimes(2);
    } finally {
      if (previous === undefined) delete process.env['LOCALMCP_OPENAI_API_KEY'];
      else process.env['LOCALMCP_OPENAI_API_KEY'] = previous;
    }
  });

  it('rechecks live transfer permissions at call time', async () => {
    const result = await fileTransferTool(roots, {
      action: 'save_chatgpt_file',
      source_file: { download_url: 'https://files.oaiusercontent.com/x', file_id: 'file-x' },
      destination: '/project/x',
    }, { ...receivePermissions, filesReceive: false });
    expect(result.isError).toBe(true);
    expect(result.content.find((block) => block.type === 'text')?.text).toMatch(/^FILE_TRANSFER_DISABLED:/u);
    expect(result.structuredContent).toMatchObject({ code: 'FILE_TRANSFER_DISABLED', ambiguous: false });
  });
});
