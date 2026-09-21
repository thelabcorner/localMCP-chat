const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface OpenCodeIdentity {
  instanceID: string;
  processID: number;
  startedAt: string;
  version: string;
  client?: string;
}

export interface OpenCodeClientConfig {
  serverUrl: string;
  username?: string;
  deviceToken?: string;
  bootstrapPassword?: string;
  deviceName: string;
  fetchImpl?: typeof fetch;
}

export interface OpenCodeStartResult {
  identity: OpenCodeIdentity;
  credentialUpdates?: Record<string, string>;
  authenticated: boolean;
}

interface PairedDevice {
  token: string;
  deviceId?: string;
}

export class OpenCodeNeedsAuthError extends Error {}
export class OpenCodeIdentityMismatchError extends Error {}

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message = `OpenCode returned HTTP ${status}`,
  ) {
    super(body ? `${message}: ${body.slice(0, 800)}` : message);
  }
}

export function validateOpenCodeServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('OpenCode server URL must be a valid loopback HTTP URL.');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (url.protocol !== 'http:' || !loopback) {
    throw new Error('OpenCode server URL must use http:// on localhost, 127.0.0.1, or ::1.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('OpenCode server URL must be an origin only, without credentials, path, query, or fragment.');
  }
  url.pathname = '/';
  return url;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`OpenCode response exceeds ${maxBytes} bytes.`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`OpenCode response exceeds ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export class OpenCodeHttpClient {
  readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly username: string;
  private readonly bootstrapPassword?: string;
  private readonly deviceName: string;
  private deviceToken?: string;
  private identity?: OpenCodeIdentity;

  constructor(config: OpenCodeClientConfig) {
    this.baseUrl = validateOpenCodeServerUrl(config.serverUrl);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.username = config.username?.trim() || 'opencode';
    this.deviceToken = config.deviceToken?.trim() || undefined;
    this.bootstrapPassword = config.bootstrapPassword?.trim() || undefined;
    this.deviceName = config.deviceName.slice(0, 80);
  }

  currentIdentity(): OpenCodeIdentity | undefined {
    return this.identity ? { ...this.identity } : undefined;
  }

  currentDeviceToken(): string | undefined {
    return this.deviceToken;
  }

  async start(): Promise<OpenCodeStartResult> {
    const identity = await this.probeIdentity(false);
    if (this.identity && identity.instanceID !== this.identity.instanceID) {
      throw new OpenCodeIdentityMismatchError(
        `OpenCode instance changed from ${this.identity.instanceID} to ${identity.instanceID}. Restart the OpenCode Control integration before sending credentials or work to the replacement process.`,
      );
    }
    this.identity = identity;
    // Pin immediately after discovery. This closes the probe/request port-reuse race before
    // any credential is sent to the service.
    await this.probeIdentity(true);

    if (this.deviceToken) {
      const verified = await this.raw('/config', { auth: 'device', timeoutMs: DEFAULT_TIMEOUT_MS });
      if (verified.status >= 200 && verified.status < 300) {
        return { identity, authenticated: true };
      }
      if (verified.status !== 401 && verified.status !== 403) this.throwHttp(verified);
      // A revoked token can be repaired with an explicitly supplied bootstrap password. Never
      // fall through to repeatedly trying a dead token against arbitrary endpoints.
      if (!this.bootstrapPassword) throw new OpenCodeNeedsAuthError('The stored OpenCode device token was rejected. Configure a one-time server password to pair again.');
    }

    if (this.bootstrapPassword) {
      const paired = await this.pair(this.bootstrapPassword);
      this.deviceToken = paired.token;
      const verified = await this.raw('/config', { auth: 'device', timeoutMs: DEFAULT_TIMEOUT_MS });
      if (verified.status < 200 || verified.status >= 300) this.throwHttp(verified);
      return {
        identity,
        authenticated: true,
        credentialUpdates: {
          deviceToken: paired.token,
          bootstrapPassword: '',
          ...(paired.deviceId ? { deviceId: paired.deviceId } : {}),
        },
      };
    }

    // Unsecured loopback servers are valid OpenCode configurations. Verify that path before
    // asking the user for a credential that the server does not need.
    const anonymous = await this.raw('/config', { auth: 'none', timeoutMs: DEFAULT_TIMEOUT_MS });
    if (anonymous.status >= 200 && anonymous.status < 300) return { identity, authenticated: false };
    if (anonymous.status === 401 || anonymous.status === 403) {
      throw new OpenCodeNeedsAuthError('OpenCode requires authentication. Configure a device token or a one-time server password.');
    }
    this.throwHttp(anonymous);
  }

  async probeIdentity(pin = true): Promise<OpenCodeIdentity> {
    const result = await this.raw('/instance/identity', { auth: 'none', pin, timeoutMs: 4_000 });
    if (result.status < 200 || result.status >= 300) this.throwHttp(result);
    const body = result.data;
    if (!body || typeof body !== 'object') throw new Error('OpenCode identity response is malformed.');
    const value = body as Record<string, unknown>;
    if (
      typeof value.instanceID !== 'string' || !value.instanceID ||
      typeof value.processID !== 'number' ||
      typeof value.startedAt !== 'string' ||
      typeof value.version !== 'string'
    ) throw new Error('OpenCode identity response is malformed.');
    const identity: OpenCodeIdentity = {
      instanceID: value.instanceID,
      processID: value.processID,
      startedAt: value.startedAt,
      version: value.version,
      ...(typeof value.client === 'string' ? { client: value.client } : {}),
    };
    if (pin && this.identity && identity.instanceID !== this.identity.instanceID) {
      throw new OpenCodeIdentityMismatchError(`OpenCode instance changed from ${this.identity.instanceID} to ${identity.instanceID}. Reconnect before sending work.`);
    }
    return identity;
  }

  async request<T = unknown>(
    pathname: string,
    options: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      timeoutMs?: number;
      maxResponseBytes?: number;
    } = {},
  ): Promise<{ data: T; headers: Headers; status: number }> {
    const result = await this.raw(pathname, {
      ...options,
      auth: this.deviceToken ? 'device' : 'none',
      pin: true,
    });
    if (result.status < 200 || result.status >= 300) this.throwHttp(result);
    return result as { data: T; headers: Headers; status: number };
  }

  /**
   * Consume OpenCode's global SSE stream. The stream is only a wake-up channel:
   * callers must reconcile authoritative session/message snapshots after every pulse.
   * `Last-Event-ID` preserves OpenCode's replay cursor across transient reconnects.
   */
  async subscribeGlobalEvents(
    signal: AbortSignal,
    lastEventId: string | undefined,
    onEvent: (frame: { id?: string; event: unknown }) => void,
    onOpen?: () => void,
  ): Promise<void> {
    if (!this.identity) throw new Error('OpenCode identity has not been established.');
    const url = new URL('global/event', this.baseUrl);
    const headers = new Headers({
      accept: 'text/event-stream',
      'x-opencode-expect-instance': this.identity.instanceID,
    });
    if (this.deviceToken) headers.set('authorization', `Bearer ${this.deviceToken}`);
    if (lastEventId) headers.set('last-event-id', lastEventId);
    const response = await this.fetchImpl(url, { headers, redirect: 'error', signal });
    if (response.status === 409) throw new OpenCodeIdentityMismatchError('OpenCode event stream was rebound to a different server instance.');
    if (response.status === 401 || response.status === 403) {
      throw new OpenCodeNeedsAuthError('OpenCode rejected the event-stream credential. Reconfigure the integration.');
    }
    if (!response.ok) {
      const text = await boundedText(response, MAX_ERROR_BYTES);
      throw new OpenCodeHttpError(response.status, text);
    }
    if (!response.body) throw new Error('OpenCode event stream has no response body.');
    onOpen?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines: string[] = [];
    let frameId: string | undefined;
    const flush = () => {
      if (!dataLines.length) return;
      const text = dataLines.join('\n');
      dataLines = [];
      const id = frameId;
      frameId = undefined;
      try { onEvent({ ...(id ? { id } : {}), event: JSON.parse(text) }); }
      catch { onEvent({ ...(id ? { id } : {}), event: text }); }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(buffer, 'utf8') > 1024 * 1024) throw new Error('OpenCode SSE frame exceeded 1 MiB.');
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (line === '') { flush(); continue; }
          if (line.startsWith('id:')) frameId = line.slice(3).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
      }
      flush();
    } finally {
      reader.releaseLock();
    }
  }

  private async pair(password: string): Promise<PairedDevice> {
    const begin = await this.raw('/pair/begin', {
      method: 'POST',
      auth: 'basic',
      basicPassword: password,
      body: {},
      pin: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (begin.status === 401 || begin.status === 403) throw new OpenCodeNeedsAuthError('The OpenCode server password was rejected.');
    if (begin.status < 200 || begin.status >= 300) this.throwHttp(begin);
    const code = (begin.data as Record<string, unknown> | undefined)?.code;
    if (typeof code !== 'string' || !code) throw new Error('OpenCode pairing did not return a code.');

    const claim = await this.raw('/pair/claim', {
      method: 'POST',
      auth: 'none',
      body: { code, name: this.deviceName },
      pin: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (claim.status < 200 || claim.status >= 300) this.throwHttp(claim);
    const token = (claim.data as Record<string, unknown> | undefined)?.token;
    if (typeof token !== 'string' || !token) throw new Error('OpenCode pairing did not return a device token.');
    const device = (claim.data as Record<string, unknown> | undefined)?.device;
    const deviceId = device && typeof device === 'object' && typeof (device as Record<string, unknown>).id === 'string'
      ? String((device as Record<string, unknown>).id)
      : undefined;
    return { token, ...(deviceId ? { deviceId } : {}) };
  }

  private async raw(
    pathname: string,
    options: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      timeoutMs?: number;
      auth: 'none' | 'device' | 'basic';
      basicPassword?: string;
      pin?: boolean;
      maxResponseBytes?: number;
    },
  ): Promise<{ data: unknown; text: string; headers: Headers; status: number }> {
    const url = new URL(pathname.replace(/^\/+/, ''), this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ accept: 'application/json' });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    if (options.pin !== false && this.identity) headers.set('x-opencode-expect-instance', this.identity.instanceID);
    if (options.auth === 'device' && this.deviceToken) headers.set('authorization', `Bearer ${this.deviceToken}`);
    if (options.auth === 'basic' && options.basicPassword !== undefined) headers.set('authorization', basic(this.username, options.basicPassword));

    const response = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      redirect: 'error',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(Math.max(250, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000))),
    });
    const max = response.ok ? (options.maxResponseBytes ?? MAX_RESPONSE_BYTES) : MAX_ERROR_BYTES;
    const text = response.status === 204 ? '' : await boundedText(response, max);
    let data: unknown = undefined;
    if (text) {
      const type = response.headers.get('content-type') ?? '';
      if (type.includes('json')) {
        try { data = JSON.parse(text); }
        catch { data = text; }
      } else data = text;
    }
    if (response.status === 409) {
      throw new OpenCodeIdentityMismatchError('OpenCode rejected the request because the selected server instance changed. Reconnect before retrying mutations.');
    }
    return { status: response.status, headers: response.headers, text, data };
  }

  private throwHttp(result: { status: number; text: string }): never {
    throw new OpenCodeHttpError(result.status, result.text);
  }
}
