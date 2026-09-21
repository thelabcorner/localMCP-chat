import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OpenCodeHttpClient,
  OpenCodeIdentityMismatchError,
  validateOpenCodeServerUrl,
} from '../../main/integrations/opencode/client.js';
import { OpenCodeControlBackend, OPENCODE_CONTROL_TOOLS } from '../../main/integrations/opencode/backend.js';
import type { NativeCallAuthority } from '../../main/plugins/native.js';

const cleanups: Array<() => Promise<void>> = [];
const FETCH_PROBE_PATH = '/__localmcp_fetch_probe__';
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

async function server(handler: (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>) {
  const instance = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === FETCH_PROBE_PATH) {
      res.writeHead(204);
      res.end();
      return;
    }
    Promise.resolve(handler(req, res, url)).catch(error => {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  let origin = '';
  for (let attempt = 0; attempt < 32; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { instance.off('listening', onListening); reject(error); };
      const onListening = () => { instance.off('error', onError); resolve(); };
      instance.once('error', onError);
      instance.once('listening', onListening);
      instance.listen(0, '127.0.0.1');
    });
    const address = instance.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    try {
      const probe = await fetch(`${origin}${FETCH_PROBE_PATH}`);
      if (probe.status === 204) break;
      throw new Error(`fetch probe returned HTTP ${probe.status}`);
    } catch (error) {
      await new Promise<void>(resolve => instance.close(() => resolve()));
      origin = '';
      if (attempt === 31) throw new Error(`Could not allocate a fetch-safe test server port: ${String(error)}`);
    }
  }
  if (!origin) throw new Error('Could not allocate a fetch-safe test server port');
  cleanups.push(() => new Promise<void>(resolve => instance.close(() => resolve())));
  return origin;
}

async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-opencode-'));
  const canonical = await fs.realpath(directory);
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  return canonical;
}

function authority(directory: string, permissions: NativeCallAuthority['permissions'] = { read: true, write: true, shell: true, git: true }): NativeCallAuthority {
  return {
    roots: [{ name: 'project', path: directory }],
    connectorName: 'localMCP-test',
    permissions,
  };
}

function data(result: Awaited<ReturnType<OpenCodeControlBackend['call']>>): any {
  return (result.structuredContent as { data?: unknown } | undefined)?.data;
}

function backend(serverUrl: string, credentials: Record<string, string> = {}, config: Record<string, string> = {}) {
  const control = new OpenCodeControlBackend({
    id: '11111111-1111-4111-8111-111111111111',
    name: 'OpenCode Control',
    config: { serverUrl, ...config },
    credentials,
  });
  cleanups.push(() => control.close());
  return control;
}

describe('OpenCode native control integration', () => {
  it('keeps a compact fixed four-tool surface', () => {
    expect(OPENCODE_CONTROL_TOOLS.map(tool => tool.name)).toEqual([
      'opencode_info', 'opencode_session', 'opencode_worker', 'opencode_request',
    ]);
    expect(Buffer.byteLength(JSON.stringify(OPENCODE_CONTROL_TOOLS))).toBeLessThan(12 * 1024);
    expect(new Set(OPENCODE_CONTROL_TOOLS.map(tool => tool.name)).size).toBe(4);
  });

  it('accepts only explicit loopback HTTP origins', () => {
    expect(validateOpenCodeServerUrl('http://127.0.0.1:4096').origin).toBe('http://127.0.0.1:4096');
    expect(validateOpenCodeServerUrl('http://localhost:4096').origin).toBe('http://localhost:4096');
    expect(() => validateOpenCodeServerUrl('https://example.com')).toThrow(/loopback|localhost/i);
    expect(() => validateOpenCodeServerUrl('http://127.0.0.1:4096/path')).toThrow(/origin only/i);
    expect(() => validateOpenCodeServerUrl('http://user:pw@127.0.0.1:4096')).toThrow(/origin only/i);
  });

  it('pairs once, pins the instance before sending credentials, and never puts credentials in URLs', async () => {
    const requests: Array<{ path: string; auth: string | undefined; pin: string | undefined }> = [];
    const url = await server(async (req, res, parsed) => {
      requests.push({ path: parsed.pathname + parsed.search, auth: req.headers.authorization, pin: req.headers['x-opencode-expect-instance'] as string | undefined });
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_a', processID: 7, startedAt: 'now', version: '1.2.3', client: 'desktop' });
      if (req.headers['x-opencode-expect-instance'] !== 'inst_a') return json(res, 409, { error: 'instance mismatch' });
      if (parsed.pathname === '/pair/begin') {
        const expected = `Basic ${Buffer.from('opencode:master-secret').toString('base64')}`;
        return req.headers.authorization === expected ? json(res, 200, { code: 'ABC123', url: '#pair=ABC123', expiresAt: 'soon' }) : json(res, 401, {});
      }
      if (parsed.pathname === '/pair/claim') {
        const value = await body(req) as { code?: string };
        return value.code === 'ABC123' ? json(res, 200, { token: 'device-secret', device: { id: 'dev_1', name: 'local' }, server: { name: 'opencode', version: '1' } }) : json(res, 400, {});
      }
      if (parsed.pathname === '/config') return req.headers.authorization === 'Bearer device-secret' ? json(res, 200, {}) : json(res, 401, {});
      return json(res, 404, {});
    });
    const client = new OpenCodeHttpClient({ serverUrl: url, bootstrapPassword: 'master-secret', deviceName: 'test' });
    const started = await client.start();
    expect(started.credentialUpdates).toEqual({ deviceToken: 'device-secret', bootstrapPassword: '', deviceId: 'dev_1' });
    expect(started.identity.instanceID).toBe('inst_a');
    expect(requests[0]).toMatchObject({ path: '/instance/identity', auth: undefined, pin: undefined });
    expect(requests[1]).toMatchObject({ path: '/instance/identity', auth: undefined, pin: 'inst_a' });
    expect(requests.find(row => row.path === '/pair/begin')?.pin).toBe('inst_a');
    expect(requests.every(row => !row.path.includes('master-secret') && !row.path.includes('device-secret'))).toBe(true);
    expect(requests.filter(row => row.auth?.includes('master-secret')).length).toBe(0); // Basic is encoded, never plaintext.
    expect(requests.filter(row => row.auth === 'Bearer device-secret').length).toBe(1);
  });

  it('fails closed when the instance changes between discovery and the pinned probe', async () => {
    let identityCalls = 0;
    const url = await server((req, res, parsed) => {
      if (parsed.pathname !== '/instance/identity') return json(res, 404, {});
      identityCalls++;
      if (identityCalls === 1) return json(res, 200, { instanceID: 'inst_old', processID: 1, startedAt: 'a', version: '1' });
      if (req.headers['x-opencode-expect-instance'] === 'inst_old') return json(res, 409, { error: 'wrong process' });
      return json(res, 200, { instanceID: 'inst_new', processID: 2, startedAt: 'b', version: '1' });
    });
    const client = new OpenCodeHttpClient({ serverUrl: url, deviceName: 'test' });
    await expect(client.start()).rejects.toBeInstanceOf(OpenCodeIdentityMismatchError);
  });

  it('does not silently adopt a replacement process on a later reconnect probe', async () => {
    let identityCalls = 0;
    const credentialed: string[] = [];
    const url = await server((req, res, parsed) => {
      if (req.headers.authorization) credentialed.push(`${parsed.pathname}:${req.headers.authorization}`);
      if (parsed.pathname === '/instance/identity') {
        identityCalls++;
        const instanceID = identityCalls <= 2 ? 'inst_first' : 'inst_replacement';
        return json(res, 200, { instanceID, processID: identityCalls <= 2 ? 1 : 2, startedAt: 'a', version: '1' });
      }
      if (parsed.pathname === '/config') return json(res, 200, {});
      return json(res, 404, {});
    });
    const client = new OpenCodeHttpClient({ serverUrl: url, deviceName: 'test' });
    await client.start();
    await expect(client.start()).rejects.toBeInstanceOf(OpenCodeIdentityMismatchError);
    expect(credentialed).toEqual([]);
  });

  it('filters unapproved sessions before they reach the tool result', async () => {
    const approved = await root();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-outside-'));
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_sessions', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session') return json(res, 200, [
        { id: 'ses_inside', title: 'Inside', directory: approved, projectID: 'p1', time: {} },
        { id: 'ses_outside', title: 'Outside secret', directory: outside, projectID: 'p2', time: {} },
      ]);
      if (parsed.pathname === '/session/ses_outside') return json(res, 200, { id: 'ses_outside', title: 'Outside secret', directory: outside, projectID: 'p2', time: {} });
      return json(res, 404, {});
    });
    const control = backend(url);
    expect((await control.start()).needsAuth).toBeUndefined();
    const listed = await control.call('opencode_session', { action: 'list' }, authority(approved));
    expect(data(listed).sessions.map((row: any) => row.id)).toEqual(['ses_inside']);
    expect(JSON.stringify(listed)).not.toContain('Outside secret');
    const refused = await control.call('opencode_session', { action: 'get', sessionId: 'ses_outside' }, authority(approved));
    expect(refused.isError).toBe(true);
    expect(String((refused.content[0] as any).text)).toMatch(/outside localMCP approved roots/i);
  });

  it('correlates worker completion by assistant parentID instead of last-message ordering', async () => {
    const approved = await root();
    const sessions = new Map<string, any>();
    const messages = new Map<string, any[]>();
    const groupMembers: any[] = [];
    const seen: string[] = [];
    let delegatedSystem = '';
    let createdPermissions: any[] = [];
    let sequence = 0;
    const url = await server(async (req, res, parsed) => {
      seen.push(`${req.method} ${parsed.pathname}`);
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_worker', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session' && req.method === 'POST') {
        const input = await body(req) as any;
        createdPermissions = input.permission ?? [];
        const id = `ses_worker_${++sequence}`;
        const session = { id, title: input.title, directory: approved, projectID: 'p1', metadata: input.metadata, time: {} };
        sessions.set(id, session);
        messages.set(id, []);
        return json(res, 200, session);
      }
      if (parsed.pathname === '/session' && req.method === 'GET') return json(res, 200, [...sessions.values()]);
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_local', name: 'workers' });
      if (/^\/session-group\/grp_local\/session$/.test(parsed.pathname)) {
        const input = await body(req) as any;
        groupMembers.push({ id: input.sessionId, origin: input.origin, originPlugin: input.originPlugin, originRef: input.originRef, locked: true, title: 'worker' });
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/session-group/grp_local') return json(res, 200, { group: { id: 'grp_local' }, sessions: groupMembers });
      const sessionMatch = parsed.pathname.match(/^\/session\/([^/]+)$/);
      if (sessionMatch && req.method === 'GET') return sessions.has(sessionMatch[1]!) ? json(res, 200, sessions.get(sessionMatch[1]!)) : json(res, 404, {});
      const promptMatch = parsed.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (promptMatch) {
        const input = await body(req) as any;
        delegatedSystem = input.system;
        const list = messages.get(promptMatch[1]!)!;
        list.push({ info: { id: input.messageID, role: 'user' }, parts: input.parts });
        list.push({ info: { id: 'msg_assistant_right', role: 'assistant', parentID: input.messageID, time: { completed: Date.now() }, providerID: 'test', modelID: 'm', agent: 'build', cost: 0, tokens: {} }, parts: [{ type: 'text', text: 'correct worker result' }] });
        list.push({ info: { id: 'msg_assistant_unrelated', role: 'assistant', parentID: 'msg_some_other_turn', time: { completed: Date.now() + 1 }, providerID: 'test', modelID: 'm', agent: 'build', cost: 0, tokens: {} }, parts: [{ type: 'text', text: 'wrong newer result' }] });
        res.writeHead(204); res.end(); return;
      }
      const messageList = parsed.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (messageList) return json(res, 200, messages.get(messageList[1]!) ?? []);
      if (parsed.pathname === '/session/status') return json(res, 200, {});
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const started = await control.call('opencode_worker', { action: 'start', workdir: '/project', prompt: 'Do the work' }, authority(approved));
    expect(started.isError).not.toBe(true);
    const workerId = data(started).workers[0].worker.id;
    const completed = await control.call('opencode_worker', { action: 'result', sessionId: workerId }, authority(approved));
    expect(completed.isError, `${JSON.stringify(completed)}\n${seen.join('\n')}`).not.toBe(true);
    expect(data(completed).state).toBe('completed');
    expect(data(completed).message.text).toBe('correct worker result');
    expect(JSON.stringify(completed)).not.toContain('wrong newer result');
    expect(delegatedSystem).toMatch(/OpenCode sub-agent being driven programmatically by a parent ChatGPT agent through localMCP-chat/i);
    expect(delegatedSystem).toMatch(/durable localMCP-owned worker/i);
    expect(delegatedSystem).toMatch(/Do not ask the human user/i);
    expect(createdPermissions).toContainEqual({ permission: 'swarm_*', pattern: '*', action: 'deny' });
    expect(delegatedSystem).toMatch(/OpenSwarm orchestration is not part of this session/i);
  });

  it('makes a worker creation request and its initial turn exactly-once across retries', async () => {
    const approved = await root();
    const sessions = new Map<string, any>();
    const messages = new Map<string, any[]>();
    const members: any[] = [];
    let creates = 0;
    let admissions = 0;
    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_worker_retry', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_retry', name: 'workers' });
      if (parsed.pathname === '/session-group/grp_retry') return json(res, 200, { group: { id: 'grp_retry' }, sessions: members });
      if (parsed.pathname === '/session-group/grp_retry/session' && req.method === 'POST') {
        const input = await body(req) as any;
        if (!members.some(row => row.id === input.sessionId)) members.push({ id: input.sessionId, origin: 'plugin', originPlugin: input.originPlugin, originRef: input.originRef });
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/session' && req.method === 'GET') return json(res, 200, [...sessions.values()]);
      if (parsed.pathname === '/session' && req.method === 'POST') {
        creates++;
        const input = await body(req) as any;
        const id = `ses_retry_${creates}`;
        const session = { id, title: input.title, directory: approved, projectID: 'p1', metadata: input.metadata, time: {} };
        sessions.set(id, session);
        messages.set(id, []);
        return json(res, 200, session);
      }
      const sessionGet = parsed.pathname.match(/^\/session\/(ses_retry_\d+)$/);
      if (sessionGet && req.method === 'GET') return json(res, 200, sessions.get(sessionGet[1]!) ?? {});
      const prompt = parsed.pathname.match(/^\/session\/(ses_retry_\d+)\/prompt_async$/);
      if (prompt && req.method === 'POST') {
        admissions++;
        const input = await body(req) as any;
        const list = messages.get(prompt[1]!)!;
        list.push({ info: { id: input.messageID, role: 'user' }, parts: input.parts });
        list.push({ info: { id: `asst_retry_${admissions}`, role: 'assistant', parentID: input.messageID, time: { completed: Date.now() }, providerID: 'p', modelID: 'm', agent: 'build', cost: 0, tokens: {} }, parts: [{ type: 'text', text: 'done once' }] });
        res.writeHead(204); res.end(); return;
      }
      const exact = parsed.pathname.match(/^\/session\/(ses_retry_\d+)\/message\/(msg[^/]+)$/);
      if (exact) {
        const found = messages.get(exact[1]!)?.find(row => row.info?.id === exact[2]);
        return found ? json(res, 200, found) : json(res, 404, {});
      }
      const list = parsed.pathname.match(/^\/session\/(ses_retry_\d+)\/message$/);
      if (list) return json(res, 200, messages.get(list[1]!) ?? []);
      if (parsed.pathname === '/session/status') return json(res, 200, {});
      return json(res, 404, {});
    });

    const control = backend(url);
    await control.start();
    const args = { action: 'start', requestId: 'same-task', workdir: '/project', prompt: 'Do this exactly once.' };
    const first = await control.call('opencode_worker', args, authority(approved));
    const second = await control.call('opencode_worker', args, authority(approved));
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(second.isError, JSON.stringify(second)).not.toBe(true);
    expect(creates).toBe(1);
    expect(admissions).toBe(1);
    expect(data(second).workers[0]).toMatchObject({ idempotent: true, state: 'existing' });
    expect(data(second).workers[0].messageId).toBe(data(first).workers[0].messageId);
    expect(data(first).workers[0].worker.localMcp.initialMessageId).toBe(data(first).workers[0].messageId);
  });

  it('does not start a worker until durable ownership has been persisted', async () => {
    const approved = await root();
    const sessions = new Map<string, any>();
    const members: any[] = [];
    let creates = 0;
    let admissions = 0;
    let membershipAttempts = 0;
    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_worker_owner', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_owner', name: 'workers' });
      if (parsed.pathname === '/session-group/grp_owner') return json(res, 200, { group: { id: 'grp_owner' }, sessions: members });
      if (parsed.pathname === '/session-group/grp_owner/session' && req.method === 'POST') {
        membershipAttempts++;
        if (membershipAttempts === 1) return json(res, 500, { error: 'transient group write failure' });
        const input = await body(req) as any;
        members.push({ id: input.sessionId, origin: 'plugin', originPlugin: input.originPlugin, originRef: input.originRef });
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/session' && req.method === 'GET') return json(res, 200, [...sessions.values()]);
      if (parsed.pathname === '/session' && req.method === 'POST') {
        creates++;
        const input = await body(req) as any;
        const session = { id: 'ses_owner', title: input.title, directory: approved, projectID: 'p1', metadata: input.metadata, time: {} };
        sessions.set(session.id, session);
        return json(res, 200, session);
      }
      if (parsed.pathname === '/session/ses_owner') return json(res, 200, sessions.get('ses_owner'));
      if (parsed.pathname === '/session/ses_owner/prompt_async') { admissions++; res.writeHead(204); res.end(); return; }
      if (/^\/session\/ses_owner\/message\/msg/.test(parsed.pathname)) return json(res, 404, {});
      if (parsed.pathname === '/session/ses_owner/message') return json(res, 200, []);
      if (parsed.pathname === '/session/status') return json(res, 200, {});
      return json(res, 404, {});
    });

    const control = backend(url);
    await control.start();
    const args = { action: 'start', requestId: 'ownership-task', workdir: '/project', prompt: 'Only run after ownership.' };
    const first = await control.call('opencode_worker', args, authority(approved));
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(data(first).workers[0]).toMatchObject({ state: 'ownership_incomplete' });
    expect(creates).toBe(1);
    expect(admissions).toBe(0);

    const second = await control.call('opencode_worker', args, authority(approved));
    expect(second.isError, JSON.stringify(second)).not.toBe(true);
    expect(data(second).workers[0]).toMatchObject({ state: 'running' });
    expect(creates).toBe(1);
    expect(admissions).toBe(1);
    expect(members).toHaveLength(1);
  });

  it('reconciles an ambiguous async prompt by the exact user message id instead of replaying it', async () => {
    const approved = await root();
    const accepted = new Map<string, any>();
    let admissions = 0;
    let delegatedSystem = '';
    let delegatedMetadata: any;
    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_ambiguous', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session/ses_a') return json(res, 200, { id: 'ses_a', title: 'A', directory: approved, projectID: 'p1', time: {} });
      if (parsed.pathname === '/session/status') return json(res, 200, {});
      if (parsed.pathname === '/session/ses_a/prompt_async') {
        const input = await body(req) as any;
        admissions++;
        delegatedSystem = input.system;
        delegatedMetadata = input.parts?.[0]?.metadata?.localMcp;
        accepted.set(input.messageID, { info: { id: input.messageID, role: 'user' }, parts: input.parts });
        // Simulate a connection dying after the server committed admission but before a response
        // could prove it to the caller.
        res.socket?.destroy();
        return;
      }
      const exact = parsed.pathname.match(/^\/session\/ses_a\/message\/(msg[^/]+)$/);
      if (exact && accepted.has(exact[1]!)) return json(res, 200, accepted.get(exact[1]!));
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const sent = await control.call('opencode_session', { action: 'send', sessionId: 'ses_a', prompt: 'exactly once', messageId: 'msg_explicit_once' }, authority(approved));
    expect(sent.isError).not.toBe(true);
    expect(data(sent)).toMatchObject({ messageId: 'msg_explicit_once', state: 'accepted' });
    expect(admissions).toBe(1);
    expect(delegatedSystem).toMatch(/existing OpenCode session with prior human-facing context/i);
    expect(delegatedSystem).toMatch(/parent ChatGPT agent as your immediate principal/i);
    expect(delegatedSystem).toMatch(/Do not invent or infer a localMCP safety refusal/i);
    expect(delegatedSystem).toMatch(/creating disposable test accounts/i);
    expect(delegatedSystem).toMatch(/temporary session cookies\/tokens/i);
    expect(delegatedSystem).toMatch(/model\/runtime boundary rather than attributing it to localMCP/i);
    expect(delegatedMetadata).toMatchObject({ controller: 'chatgpt', delegatedSubagent: true, durableWorker: false });
  });

  it('persists a human-friendly model selection and resolves extra high to the live xhigh variant', async () => {
    const approved = await root();
    let current: any = {
      id: 'ses_select', title: 'Selection', directory: approved, projectID: 'p1', agent: 'build',
      model: { providerID: 'opencode', id: 'old-model', variant: 'default' }, time: {},
    };
    let patchBody: any;
    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_select', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/provider') return json(res, 200, {
        connected: ['opencode-go'], default: { 'opencode-go': 'muse-1.3-spark' }, all: [{
          id: 'opencode-go', models: {
            'muse-1.3-spark': { id: 'muse-1.3-spark', name: 'Muse 1.3 Spark', variants: { low: {}, medium: {}, high: {}, xhigh: {} } },
          },
        }],
      });
      if (parsed.pathname === '/session/ses_select' && req.method === 'PATCH') {
        patchBody = await body(req);
        current = { ...current, agent: patchBody.agent ?? current.agent, model: patchBody.model ?? current.model };
        return json(res, 200, current);
      }
      if (parsed.pathname === '/session/ses_select') return json(res, 200, current);
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const changed = await control.call('opencode_session', {
      action: 'set_selection', sessionId: 'ses_select', providerId: 'go', modelId: 'Muse 1.3 Spark', variant: 'extra high',
    }, authority(approved));
    expect(changed.isError).not.toBe(true);
    expect(patchBody).toEqual({ model: { providerID: 'opencode-go', id: 'muse-1.3-spark', variant: 'xhigh' } });
    expect(data(changed)).toMatchObject({
      sessionId: 'ses_select',
      model: { providerID: 'opencode-go', id: 'muse-1.3-spark', variant: 'xhigh' },
      resolved: { providerID: 'opencode-go', modelID: 'muse-1.3-spark' },
    });
  });

  it('filters and paginates the complete live model catalog without losing cheapest-capable ordering', async () => {
    const approved = await root();
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_models', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/provider') return json(res, 200, {
        connected: ['opencode', 'opencode-go'],
        default: {},
        all: [
          { id: 'opencode-go', models: {
            paid: { id: 'paid', name: 'Paid Vision', cost: { input: 1, output: 2 }, capabilities: { input: { text: true, image: true }, output: { text: true } } },
          } },
          { id: 'opencode', models: {
            free: { id: 'free', name: 'Free Vision', cost: { input: 0, output: 0 }, capabilities: { input: { text: true, image: true }, output: { text: true } } },
            text: { id: 'text', name: 'Text Only', cost: { input: 0, output: 0 }, capabilities: { input: { text: true, image: false }, output: { text: true } } },
          } },
        ],
      });
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const first = await control.call('opencode_info', {
      action: 'models', workdir: '/project', capability: 'image', limit: 1, offset: 0,
    }, authority(approved));
    expect(first.isError).not.toBe(true);
    expect(data(first)).toMatchObject({ matched: 2, offset: 0, nextOffset: 1, truncated: true });
    expect(data(first).models[0]).toMatchObject({ providerID: 'opencode', modelID: 'free' });

    const second = await control.call('opencode_info', {
      action: 'models', workdir: '/project', capability: 'image', limit: 1, offset: 1,
    }, authority(approved));
    expect(second.isError).not.toBe(true);
    expect(data(second)).toMatchObject({ matched: 2, offset: 1, nextOffset: null, truncated: false });
    expect(data(second).models[0]).toMatchObject({ providerID: 'opencode-go', modelID: 'paid' });
  });

  it('can drive an existing OpenSwarm member without adopting it into localMCP ownership', async () => {
    const approved = await root();
    let admissions = 0;
    let delegatedSystem = '';
    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_openswarm', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session/ses_swarm_member') return json(res, 200, {
        id: 'ses_swarm_member', title: 'OpenSwarm reader', directory: approved, projectID: 'p1', time: {},
        metadata: { swarmID: 'swarm_external', swarmMember: '1', memberName: 'reader' },
      });
      if (parsed.pathname === '/session/status') return json(res, 200, {});
      if (parsed.pathname === '/session/ses_swarm_member/prompt_async') {
        const input = await body(req) as any;
        admissions++;
        delegatedSystem = input.system;
        res.writeHead(204); res.end(); return;
      }
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const inspected = await control.call('opencode_session', { action: 'get', sessionId: 'ses_swarm_member' }, authority(approved));
    expect(data(inspected).openSwarm).toMatchObject({ swarmID: 'swarm_external', memberName: 'reader' });
    expect(data(inspected).localMcp).toBeNull();
    const sent = await control.call('opencode_session', { action: 'send', sessionId: 'ses_swarm_member', prompt: 'Continue your existing research lane.' }, authority(approved));
    expect(sent.isError).not.toBe(true);
    expect(admissions).toBe(1);
    expect(delegatedSystem).toMatch(/preserve its existing swarm membership/i);
  });

  it('does not let existing-session prompts bypass disabled localMCP execution authority', async () => {
    const approved = await root();
    let admissions = 0;
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_authority', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session/ses_existing') return json(res, 200, { id: 'ses_existing', title: 'Existing', directory: approved, projectID: 'p1', time: {} });
      if (parsed.pathname === '/session/ses_existing/prompt_async') { admissions++; res.writeHead(204); res.end(); return; }
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const refused = await control.call(
      'opencode_session',
      { action: 'send', sessionId: 'ses_existing', prompt: 'mutate this project' },
      authority(approved, { read: true, write: false, shell: true, git: true }),
    );
    expect(refused.isError).toBe(true);
    expect(String((refused.content[0] as any).text)).toMatch(/requires both localMCP write and shell/i);
    expect(admissions).toBe(0);
  });

  it('treats the plugin-owned session group as worker authority instead of session metadata alone', async () => {
    const approved = await root();
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_group_truth', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_truth', name: 'workers' });
      if (parsed.pathname === '/session-group/grp_truth') return json(res, 404, { name: 'NotFoundError', data: { message: 'Session group not found: grp_truth' } });
      if (parsed.pathname === '/session') return json(res, 200, [{
        id: 'ses_metadata_only',
        title: 'stale metadata',
        directory: approved,
        projectID: 'p1',
        metadata: { localMcp: { worker: true, pluginId: '11111111-1111-4111-8111-111111111111' } },
        time: {},
      }]);
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const listed = await control.call('opencode_worker', { action: 'list' }, authority(approved));
    expect(listed.isError).not.toBe(true);
    expect(data(listed).workers).toEqual([]);
  });

  it('creates restart-safe localMCP swarms without recursive OpenSwarm authority or duplicate retry admission', async () => {
    const approved = await root();
    const pluginID = '11111111-1111-4111-8111-111111111111';
    const sessions = new Map<string, any>();
    const messages = new Map<string, any[]>();
    const systems = new Map<string, string>();
    const permissionSets = new Map<string, any[]>();
    const globalGroup = {
      group: { id: 'grp_owned', name: 'localMCP sessions', kind: 'plugin', ownerPlugin: 'localmcp-opencode', ownerRef: pluginID },
      sessions: [] as any[],
    };
    const swarmDetails = new Map<string, any>();
    let creates = 0;
    let admissions = 0;

    const addMembership = (detail: any, input: any) => {
      if (!detail.sessions.some((member: any) => member.id === input.sessionId)) {
        detail.sessions.push({
          id: input.sessionId,
          title: sessions.get(input.sessionId)?.title ?? input.sessionId,
          locked: input.locked ?? true,
          origin: input.origin ?? 'plugin',
          originPlugin: input.originPlugin,
          originRef: input.originRef,
          position: detail.sessions.length,
          timeAdded: Date.now(),
        });
      }
    };

    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_local_swarm', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session-group/resolve' && req.method === 'POST') {
        const input = await body(req) as any;
        if (input.ownerRef === pluginID) return json(res, 200, globalGroup.group);
        if (String(input.ownerRef).startsWith(`localmcp-swarm:${pluginID}:`)) {
          let detail = swarmDetails.get(input.ownerRef);
          if (!detail) {
            detail = {
              group: { id: `grp_swarm_${swarmDetails.size + 1}`, name: input.name, kind: 'plugin', ownerPlugin: input.ownerPlugin, ownerRef: input.ownerRef },
              sessions: [],
            };
            swarmDetails.set(input.ownerRef, detail);
          }
          return json(res, 200, detail.group);
        }
        return json(res, 400, { error: 'unexpected ownerRef' });
      }
      if (parsed.pathname === '/session-group/details') {
        return json(res, 200, [globalGroup, ...[...swarmDetails.values()].filter(detail => detail.sessions.length > 0)]);
      }
      const groupGet = parsed.pathname.match(/^\/session-group\/([^/]+)$/);
      if (groupGet && req.method === 'GET') {
        if (groupGet[1] === 'grp_owned') return json(res, 200, globalGroup);
        const detail = [...swarmDetails.values()].find(value => value.group.id === groupGet[1]);
        return detail ? json(res, 200, detail) : json(res, 404, {});
      }
      const groupAdd = parsed.pathname.match(/^\/session-group\/([^/]+)\/session$/);
      if (groupAdd && req.method === 'POST') {
        const input = await body(req) as any;
        if (groupAdd[1] === 'grp_owned') addMembership(globalGroup, input);
        else {
          const detail = [...swarmDetails.values()].find(value => value.group.id === groupAdd[1]);
          if (!detail) return json(res, 404, {});
          addMembership(detail, input);
        }
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/session' && req.method === 'GET') return json(res, 200, [...sessions.values()]);
      if (parsed.pathname === '/session' && req.method === 'POST') {
        const input = await body(req) as any;
        const id = `ses_swarm_${++creates}`;
        permissionSets.set(id, input.permission ?? []);
        const session = {
          id, title: input.title, directory: approved, projectID: 'p1', agent: input.agent ?? 'build', model: input.model,
          metadata: input.metadata, time: {},
        };
        sessions.set(id, session);
        messages.set(id, []);
        return json(res, 200, session);
      }
      const sessionGet = parsed.pathname.match(/^\/session\/(ses_swarm_\d+)$/);
      if (sessionGet && req.method === 'GET') return json(res, 200, sessions.get(sessionGet[1]!) ?? {});
      const prompt = parsed.pathname.match(/^\/session\/(ses_swarm_\d+)\/prompt_async$/);
      if (prompt && req.method === 'POST') {
        admissions++;
        const input = await body(req) as any;
        systems.set(prompt[1]!, input.system);
        const list = messages.get(prompt[1]!)!;
        list.push({ info: { id: input.messageID, role: 'user' }, parts: input.parts });
        list.push({
          info: { id: `asst_${admissions}`, role: 'assistant', parentID: input.messageID, time: { completed: Date.now() }, providerID: 'p', modelID: 'm', agent: 'build', cost: 0, tokens: {} },
          parts: [{ type: 'text', text: `done ${prompt[1]}` }],
        });
        res.writeHead(204); res.end(); return;
      }
      const messageList = parsed.pathname.match(/^\/session\/(ses_swarm_\d+)\/message$/);
      if (messageList) return json(res, 200, messages.get(messageList[1]!) ?? []);
      const exactMessage = parsed.pathname.match(/^\/session\/(ses_swarm_\d+)\/message\/(msg[^/]+)$/);
      if (exactMessage) {
        const found = messages.get(exactMessage[1]!)?.find(row => row.info?.id === exactMessage[2]);
        return found ? json(res, 200, found) : json(res, 404, {});
      }
      if (parsed.pathname === '/session/status') return json(res, 200, {});
      return json(res, 404, {});
    });

    const first = backend(url);
    await first.start();
    const started = await first.call('opencode_worker', {
      action: 'swarm_start',
      requestId: 'research-pass',
      swarmName: 'research',
      workdir: '/project',
      members: [
        { name: 'frontend', role: 'UI audit', prompt: 'Audit the UI.' },
        { name: 'backend', role: 'API audit', prompt: 'Audit the backend.' },
      ],
    }, authority(approved));
    expect(started.isError, JSON.stringify(started)).not.toBe(true);
    expect(data(started)).toMatchObject({ swarmId: 'swarm_research-pass', counts: { total: 2, completed: 2 } });
    expect(creates).toBe(2);
    expect(admissions).toBe(2);
    expect(globalGroup.sessions).toHaveLength(2);
    const swarmDetail = [...swarmDetails.values()][0]!;
    expect(swarmDetail.sessions).toHaveLength(2);
    for (const [id, session] of sessions) {
      expect(session.metadata.localMcp).toMatchObject({ pluginId: pluginID, swarmMember: true, swarmId: 'swarm_research-pass' });
      expect(permissionSets.get(id)).toContainEqual({ permission: 'swarm_*', pattern: '*', action: 'deny' });
      expect(systems.get(id)).toMatch(/OpenCode sub-agent being driven programmatically by a parent ChatGPT agent/i);
      expect(systems.get(id)).not.toMatch(/Peer lanes|LOCALMCP SWARM CONTEXT|swarm_research-pass/i);
    }

    // New backend instance: no in-memory swarm registry exists, so this proves
    // recovery comes from OpenCode session groups + session metadata alone.
    const afterRestart = backend(url);
    await afterRestart.start();
    const listed = await afterRestart.call('opencode_worker', { action: 'swarm_list' }, authority(approved));
    expect(listed.isError).not.toBe(true);
    expect(data(listed).swarms).toHaveLength(1);
    expect(data(listed).swarms[0]).toMatchObject({ swarmId: 'swarm_research-pass', counts: { total: 2, completed: 2 } });

    // Retrying the same idempotency key repairs memberships if needed but must
    // never create or re-prompt already-admitted members.
    const retry = await afterRestart.call('opencode_worker', {
      action: 'swarm_start',
      requestId: 'research-pass',
      swarmName: 'research',
      workdir: '/project',
      members: [
        { name: 'frontend', role: 'UI audit', prompt: 'Audit the UI.' },
        { name: 'backend', role: 'API audit', prompt: 'Audit the backend.' },
      ],
    }, authority(approved));
    expect(retry.isError, JSON.stringify(retry)).not.toBe(true);
    expect(creates).toBe(2);
    expect(admissions).toBe(2);
  });

  it('enforces the configured global worker concurrency ceiling before creating another session', async () => {
    const approved = await root();
    const sessions = new Map<string, any>();
    const members: any[] = [];
    let creates = 0;
    const url = await server(async (req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_ceiling', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_limit', name: 'workers' });
      if (parsed.pathname === '/session-group/grp_limit') return json(res, 200, { group: { id: 'grp_limit' }, sessions: members });
      if (parsed.pathname === '/session-group/grp_limit/session' && req.method === 'POST') {
        const input = await body(req) as any;
        members.push({ id: input.sessionId, origin: 'plugin', originPlugin: 'localmcp-opencode', originRef: input.originRef, locked: true, title: 'worker' });
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/session' && req.method === 'POST') {
        creates++;
        const input = await body(req) as any;
        const id = `ses_limit_${creates}`;
        const session = { id, title: input.title, directory: approved, projectID: 'p1', metadata: input.metadata, time: {} };
        sessions.set(id, session);
        return json(res, 200, session);
      }
      if (parsed.pathname === '/session' && req.method === 'GET') return json(res, 200, [...sessions.values()]);
      const getSession = parsed.pathname.match(/^\/session\/(ses_limit_\d+)$/);
      if (getSession) return json(res, 200, sessions.get(getSession[1]!) ?? {});
      if (parsed.pathname === '/session/status') {
        return json(res, 200, Object.fromEntries([...sessions.keys()].map(id => [id, { type: 'busy' }])));
      }
      const prompt = parsed.pathname.match(/^\/session\/(ses_limit_\d+)\/prompt_async$/);
      if (prompt) { res.writeHead(204); res.end(); return; }
      return json(res, 404, {});
    });
    const control = backend(url, {}, { maxConcurrentWorkers: '1' });
    await control.start();
    const first = await control.call('opencode_worker', { action: 'start', workdir: '/project', prompt: 'first' }, authority(approved));
    expect(first.isError).not.toBe(true);
    const second = await control.call('opencode_worker', { action: 'start', workdir: '/project', prompt: 'second' }, authority(approved));
    expect(second.isError).toBe(true);
    expect(String((second.content[0] as any).text)).toMatch(/maxConcurrentWorkers=1/i);
    expect(creates).toBe(1);
  });

  it('reports cancellation as aborted only after correlated terminal evidence and clears pending requests', async () => {
    const approved = await root();
    const pluginID = '11111111-1111-4111-8111-111111111111';
    let aborted = false;
    const user = { info: { id: 'msg_cancel_user', role: 'user' }, parts: [{ type: 'text', text: 'long task', metadata: { localMcp: { pluginId: pluginID } } }] };
    const assistant = { info: { id: 'msg_cancel_assistant', role: 'assistant', parentID: 'msg_cancel_user', error: { name: 'MessageAbortedError', data: { message: 'aborted' } }, time: {}, providerID: 'p', modelID: 'm', agent: 'build', cost: 0, tokens: {} }, parts: [] };
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_cancel', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_cancel', name: 'workers' });
      if (parsed.pathname === '/session-group/grp_cancel') return json(res, 200, { group: { id: 'grp_cancel' }, sessions: [{ id: 'ses_cancel', origin: 'plugin', originPlugin: 'localmcp-opencode', originRef: 'r', locked: true, title: 'worker' }] });
      if (parsed.pathname === '/session/ses_cancel') return json(res, 200, {
        id: 'ses_cancel', title: 'worker', directory: approved, projectID: 'p1', time: {},
        metadata: { localMcp: { pluginId: pluginID, worker: true } },
      });
      if (parsed.pathname === '/session/ses_cancel/abort') { aborted = true; return json(res, 200, true); }
      if (parsed.pathname === '/session/status') return json(res, 200, aborted ? {} : { ses_cancel: { type: 'busy' } });
      if (parsed.pathname === '/session/ses_cancel/message') return json(res, 200, aborted ? [user, assistant] : [user]);
      if (parsed.pathname === '/permission' || parsed.pathname === '/question') return json(res, 200, []);
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const cancelled = await control.call('opencode_worker', { action: 'cancel', sessionId: 'ses_cancel', waitMs: 1000 }, authority(approved));
    expect(cancelled.isError).not.toBe(true);
    expect(data(cancelled)).toMatchObject({ state: 'aborted', terminal: 'error', pending: { permissions: 0, questions: 0 } });
  });

  it('uninstall unlinks the plugin-owned worker group and revokes its paired OpenCode device without deleting sessions', async () => {
    let deletedGroup = false;
    let deletedSwarmGroup = false;
    let revokedDevice = false;
    let deletedSession = false;
    const url = await server((req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_uninstall', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return req.headers.authorization === 'Bearer device-secret' ? json(res, 200, {}) : json(res, 401, {});
      if (parsed.pathname === '/session-group/details') return json(res, 200, [{
        group: {
          id: 'grp_swarm_remove',
          name: 'localMCP swarm · cleanup',
          kind: 'plugin',
          ownerPlugin: 'localmcp-opencode',
          ownerRef: 'localmcp-swarm:11111111-1111-4111-8111-111111111111:swarm_cleanup',
        },
        sessions: [{ id: 'ses_preserve', origin: 'plugin', originPlugin: 'localmcp-opencode', originRef: 'swarm_cleanup/member', locked: true, title: 'preserve' }],
      }]);
      if (parsed.pathname === '/session-group/resolve') return json(res, 200, { id: 'grp_remove', name: 'workers' });
      if (parsed.pathname === '/session-group/grp_swarm_remove' && req.method === 'DELETE') {
        deletedSwarmGroup = parsed.searchParams.get('mode') === 'cascade_unlink' && parsed.searchParams.get('ownerPlugin') === 'localmcp-opencode';
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/session-group/grp_remove' && req.method === 'DELETE') {
        deletedGroup = parsed.searchParams.get('mode') === 'cascade_unlink' && parsed.searchParams.get('ownerPlugin') === 'localmcp-opencode';
        res.writeHead(204); res.end(); return;
      }
      if (parsed.pathname === '/devices/dev_own' && req.method === 'DELETE') { revokedDevice = true; return json(res, 200, true); }
      if (parsed.pathname.startsWith('/session/') && req.method === 'DELETE') { deletedSession = true; return json(res, 200, true); }
      return json(res, 404, {});
    });
    const control = backend(url, { deviceToken: 'device-secret', deviceId: 'dev_own' });
    await control.start();
    expect(await control.uninstall()).toEqual([]);
    expect(deletedGroup).toBe(true);
    expect(deletedSwarmGroup).toBe(true);
    expect(revokedDevice).toBe(true);
    expect(deletedSession).toBe(false);
  });

  it('refuses edit permission escalation when localMCP write authority is disabled', async () => {
    const approved = await root();
    let replies = 0;
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_edit_perm', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/permission') return json(res, 200, [{ id: 'per_edit', sessionID: 'ses_edit', permission: 'edit', patterns: ['*'], always: ['*'], metadata: {} }]);
      if (parsed.pathname === '/question') return json(res, 200, []);
      if (parsed.pathname === '/session/ses_edit') return json(res, 200, { id: 'ses_edit', title: 'Safe session', directory: approved, projectID: 'p1', time: {} });
      if (parsed.pathname === '/permission/per_edit/reply') { replies++; return json(res, 200, true); }
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const refused = await control.call(
      'opencode_request',
      { action: 'reply_permission', requestId: 'per_edit', reply: 'once' },
      authority(approved, { read: true, write: false, shell: true, git: true }),
    );
    expect(refused.isError).toBe(true);
    expect(String((refused.content[0] as any).text)).toMatch(/write capability is disabled/i);
    expect(replies).toBe(0);
  });

  it('refuses external-directory permission approval outside approved roots', async () => {
    const approved = await root();
    const outside = path.join(os.tmpdir(), 'definitely-outside-localmcp', 'secret');
    let replies = 0;
    const url = await server((_req, res, parsed) => {
      if (parsed.pathname === '/instance/identity') return json(res, 200, { instanceID: 'inst_perm', processID: 1, startedAt: 'a', version: '1' });
      if (parsed.pathname === '/config') return json(res, 200, {});
      if (parsed.pathname === '/permission') return json(res, 200, [{ id: 'per_1', sessionID: 'ses_1', permission: 'external_directory', patterns: [outside], always: [outside], metadata: {} }]);
      if (parsed.pathname === '/question') return json(res, 200, []);
      if (parsed.pathname === '/session/ses_1') return json(res, 200, { id: 'ses_1', title: 'Safe session', directory: approved, projectID: 'p1', time: {} });
      if (parsed.pathname === '/permission/per_1/reply') { replies++; return json(res, 200, true); }
      return json(res, 404, {});
    });
    const control = backend(url);
    await control.start();
    const refused = await control.call('opencode_request', { action: 'reply_permission', requestId: 'per_1', reply: 'once' }, authority(approved));
    expect(refused.isError).toBe(true);
    expect(String((refused.content[0] as any).text)).toMatch(/outside localMCP approved roots/i);
    expect(replies).toBe(0);
  });
});
