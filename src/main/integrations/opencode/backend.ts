import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { Root } from '../../../shared/types.js';
import { resolvePath } from '../../sandbox.js';
import type {
  NativeCallAuthority,
  NativePluginBackend,
  NativePluginInit,
  NativeRuntimeStatus,
  NativeStartResult,
} from '../../plugins/native.js';
import {
  OpenCodeHttpClient,
  OpenCodeHttpError,
  OpenCodeIdentityMismatchError,
  OpenCodeNeedsAuthError,
  type OpenCodeIdentity,
} from './client.js';
import {
  catalogFromProviderPayload,
  hasCapability,
  modelInputPrice,
  modelsWithCapability,
  normalizeProvider,
  providerDisplayName,
  resolveModel,
  resolveVariant,
  type ModelCapability,
  type OpenCodeModelInfo,
} from './model-catalog.js';

type Json = Record<string, unknown>;

const OWNER_PLUGIN = 'localmcp-opencode';
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1024 * 1024;
const SWARM_OWNER_PREFIX = 'localmcp-swarm:';
const MAX_TEXT = 80 * 1024;
const DEFAULT_WAIT_MS = 30_000;

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Tool['inputSchema'] {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  } as Tool['inputSchema'];
}

const workdir = { type: 'string', description: 'Approved localMCP working directory. Required when the operation cannot infer one.' };
const sessionId = { type: 'string', minLength: 1, description: 'OpenCode session id.' };
const waitMs = { type: 'integer', minimum: 0, maximum: 30000, description: 'Maximum time to wait for the correlated assistant turn.' };
const modelFields = {
  providerId: { type: 'string', description: 'Optional OpenCode provider id or tier alias (for example opencode-go, go, opencode, zen). Omit to resolve a unique model across providers.' },
  modelId: { type: 'string', description: 'OpenCode model id or exact display name. The bridge resolves it against the live provider catalog and refuses ambiguity.' },
  agent: { type: 'string', description: 'OpenCode agent name.' },
  variant: { type: 'string', description: 'Optional live reasoning variant. Human forms such as "extra high" resolve to a published key such as xhigh only when that model actually publishes it.' },
};

const workerTaskSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt', 'workdir'],
  properties: {
    prompt: { type: 'string', minLength: 1, maxLength: 100000 },
    workdir,
    title: { type: 'string', maxLength: 200 },
    requestId: { type: 'string', maxLength: 160, description: 'Optional caller idempotency key for worker creation.' },
    capability: { type: 'string', enum: ['text', 'image', 'pdf', 'audio', 'video'], description: 'Optional required input capability. Used only when no explicit model is supplied.' },
    ...modelFields,
  },
};

const swarmMemberSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'prompt'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', description: 'Stable member name inside the localMCP swarm.' },
    role: { type: 'string', maxLength: 160, description: 'Short lane/role description for this member.' },
    prompt: { type: 'string', minLength: 1, maxLength: 100000 },
    title: { type: 'string', maxLength: 200 },
    capability: { type: 'string', enum: ['text', 'image', 'pdf', 'audio', 'video'], description: 'Optional input capability. If no explicit model is supplied, localMCP chooses the cheapest live model that advertises this capability.' },
    ...modelFields,
  },
};

export const OPENCODE_CONTROL_TOOLS: readonly Tool[] = [
  {
    name: 'opencode_info',
    description: 'Inspect the connected OpenCode service, capabilities, providers/models, agents, provider quota, or approved-project usage. The schema is intentionally stable even while OpenCode is offline.',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['status', 'capabilities', 'providers', 'models', 'agents', 'limits', 'usage'] },
      workdir,
      providerId: { type: 'string' },
      query: { type: 'string', maxLength: 200 },
      tier: { type: 'string', maxLength: 80, description: 'Optional model tier/provider family filter, for example go, zen, zen-free, workbuddy, or openrouter.' },
      capability: { type: 'string', enum: ['text', 'image', 'pdf', 'audio', 'video'], description: 'Only list models that advertise this input capability. Capability-filtered results are cheapest first.' },
      cheapest: { type: 'integer', minimum: 1, maximum: 100, description: 'Return at most N cheapest matching models.' },
      offset: { type: 'integer', minimum: 0, maximum: 100000, description: 'Zero-based model-list offset for bounded full-catalog enumeration.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      since: { type: 'number', description: 'Usage window start as Unix milliseconds.' },
      until: { type: 'number', description: 'Usage window end as Unix milliseconds.' },
      resolution: { type: 'string', enum: ['hour', 'day'] },
    }, ['action']),
  },
  {
    name: 'opencode_session',
    description: 'List or inspect approved-root OpenCode sessions, read messages/children, send a correlated turn, pause/resume/abort, or detach blocking native subagents into OpenCode background execution.',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['list', 'get', 'messages', 'children', 'selection', 'set_selection', 'send', 'turn', 'pause', 'resume', 'abort', 'background_subagents'] },
      sessionId,
      workdir,
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      messageId: { type: 'string', pattern: '^msg', description: 'Optional explicit correlation/idempotency id. Normally generated by localMCP.' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      before: { type: 'string' },
      waitMs,
      ...modelFields,
    }, ['action']),
  },
  {
    name: 'opencode_worker',
    description: 'Create/manage durable localMCP-owned OpenCode workers and localMCP swarms. State lives in OpenCode session metadata/session groups, survives localMCP restarts, and never uses OpenSwarm as a recursive scheduler.',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['start', 'list', 'get', 'wait', 'result', 'continue', 'cancel', 'swarm_start', 'swarm_list', 'swarm_get', 'swarm_wait', 'swarm_cancel', 'swarm_continue'] },
      sessionId,
      prompt: { type: 'string', minLength: 1, maxLength: 100000 },
      workdir,
      title: { type: 'string', maxLength: 200 },
      requestId: { type: 'string', maxLength: 160 },
      capability: { type: 'string', enum: ['text', 'image', 'pdf', 'audio', 'video'], description: 'Optional required input capability for a standalone worker when no explicit model is supplied.' },
      tasks: { type: 'array', minItems: 1, maxItems: 8, items: workerTaskSchema },
      swarmId: { type: 'string', maxLength: 220, description: 'LocalMCP swarm id returned by swarm_start.' },
      swarmName: { type: 'string', minLength: 1, maxLength: 100, description: 'Human-facing swarm name.' },
      member: { type: 'string', maxLength: 64, description: 'LocalMCP swarm member name for swarm_continue.' },
      members: { type: 'array', minItems: 1, maxItems: 8, items: swarmMemberSchema },
      waitMs,
      ...modelFields,
    }, ['action']),
  },
  {
    name: 'opencode_request',
    description: 'List and answer OpenCode permission/question requests for approved-root sessions. External-directory approvals are refused unless every requested path remains inside a localMCP approved root.',
    inputSchema: objectSchema({
      action: { type: 'string', enum: ['list', 'reply_permission', 'answer_question', 'reject_question'] },
      requestId: { type: 'string', minLength: 1 },
      sessionId,
      reply: { type: 'string', enum: ['once', 'always', 'reject'] },
      message: { type: 'string', maxLength: 4000, description: 'Optional rejection/correction feedback.' },
      answers: {
        type: 'array',
        maxItems: 32,
        items: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 500 } },
      },
      details: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 4000 } },
    }, ['action']),
  },
] as const;

function clip(text: string, max = MAX_TEXT): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= max) return text;
  let end = max;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}\n… [truncated]`;
}

function result(action: string, data: unknown, summary?: string): CallToolResult {
  const body = clip(JSON.stringify(data, null, 2));
  const text = `${summary ? `${summary}\n` : ''}<opencode action="${action}">\n${body}\n</opencode>`;
  return { content: [{ type: 'text', text }], structuredContent: { action, data, text } };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function str(input: unknown, name: string, required = false): string | undefined {
  if (input === undefined || input === null || input === '') {
    if (required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof input !== 'string') throw new Error(`${name} must be a string.`);
  return input;
}

function integer(input: unknown, fallback: number, min: number, max: number): number {
  if (input === undefined) return fallback;
  if (!Number.isInteger(input) || Number(input) < min || Number(input) > max) throw new Error(`Expected an integer from ${min} to ${max}.`);
  return Number(input);
}

function messageID(input?: string): string {
  if (input !== undefined) {
    if (!/^msg[A-Za-z0-9._:-]{0,150}$/.test(input)) throw new Error('messageId must begin with "msg" and contain only simple identifier characters.');
    return input;
  }
  return `msg_localmcp_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

function requestID(input?: string): string {
  if (input) return input.slice(0, 160);
  return `localmcp_${Date.now().toString(36)}_${randomBytes(8).toString('hex')}`;
}

function deterministicMessageID(seed: string): string {
  const digest = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32);
  return `msg_localmcp_${digest}`;
}

function record(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface ApprovedDirectory {
  real: string;
  virtual: string;
  root: Root;
}

interface AuthorizedSession {
  session: Json;
  directory: ApprovedDirectory;
}

interface TurnRef {
  sessionId: string;
  messageId: string;
  directory: ApprovedDirectory;
}

interface EventPump {
  controller: AbortController;
  waiters: Map<string, Set<() => void>>;
  task: Promise<void>;
  lastEventId?: string;
  connected: boolean;
  reconnects: number;
  gaps: number;
}

export class OpenCodeControlBackend implements NativePluginBackend {
  readonly tools = OPENCODE_CONTROL_TOOLS;
  private client?: OpenCodeHttpClient;
  private identity?: OpenCodeIdentity;
  private auth: 'unknown' | 'ready' | 'anonymous' | 'needs-auth' | 'offline' = 'unknown';
  private authDetail?: string;
  private readonly config: Record<string, string>;
  private readonly credentials: Record<string, string>;
  private workerGroupPromise?: Promise<Json | undefined>;
  private eventPump?: EventPump;
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private workerAdmissionQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly init: NativePluginInit) {
    this.config = { ...init.config };
    this.credentials = { ...init.credentials };
  }

  async start(): Promise<NativeStartResult> {
    try {
      const started = await this.connect();
      return { ...(started.credentialUpdates ? { credentialUpdates: started.credentialUpdates } : {}) };
    } catch (error) {
      if (error instanceof OpenCodeNeedsAuthError) {
        this.auth = 'needs-auth';
        this.authDetail = error.message;
        return { needsAuth: error.message };
      }
      this.auth = 'offline';
      this.authDetail = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.workerGroupPromise = undefined;
    const pump = this.eventPump;
    this.eventPump = undefined;
    pump?.controller.abort();
    await pump?.task.catch(() => undefined);
  }

  async uninstall(): Promise<string[]> {
    const warnings: string[] = [];
    let client: OpenCodeHttpClient;
    try {
      client = await this.requireReady();
    } catch (error) {
      return [`OpenCode cleanup skipped because the configured server was unavailable: ${error instanceof Error ? error.message : String(error)}`];
    }

    // Remove only relationship containers. Session rows, messages, worktrees and files remain
    // OpenCode-owned and are intentionally preserved after the integration is removed.
    try {
      const swarms = await this.localSwarmGroups();
      for (const detail of swarms) {
        const group = record(detail.group);
        if (typeof group.id !== 'string') continue;
        try {
          await client.request(`/session-group/${encodeURIComponent(group.id)}`, {
            method: 'DELETE',
            query: { mode: 'cascade_unlink', ownerPlugin: OWNER_PLUGIN },
          });
        } catch (error) {
          warnings.push(`OpenCode localMCP swarm-group unlink failed for ${String(group.name ?? group.id)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      warnings.push(`OpenCode localMCP swarm discovery failed during cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const group = await this.ensureWorkerGroup();
      const groupID = typeof group?.id === 'string' ? group.id : undefined;
      if (groupID) {
        await client.request(`/session-group/${encodeURIComponent(groupID)}`, {
          method: 'DELETE',
          query: { mode: 'cascade_unlink', ownerPlugin: OWNER_PLUGIN },
        });
      }
      this.workerGroupPromise = undefined;
    } catch (error) {
      warnings.push(`OpenCode worker-group unlink failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Pairing tokens are revocable OpenCode devices. Prefer the exact id returned during pairing;
    // older/manual configurations can recover it by the token's display prefix. Never guess when
    // that prefix is ambiguous.
    try {
      const token = client.currentDeviceToken() ?? this.credentials.deviceToken;
      let deviceID = this.credentials.deviceId?.trim() || undefined;
      if (!deviceID && token) {
        const response = await client.request<unknown[]>('/devices');
        const matches = array(response.data)
          .map(record)
          .filter(device => device.revokedAt === undefined && device.tokenPrefix === token.slice(0, 8) && typeof device.id === 'string');
        if (matches.length === 1) deviceID = String(matches[0]!.id);
        else if (matches.length > 1) warnings.push('OpenCode device revocation was skipped because the stored token prefix matched more than one active device.');
      }
      if (deviceID) {
        await client.request(`/devices/${encodeURIComponent(deviceID)}`, { method: 'DELETE' });
      }
    } catch (error) {
      warnings.push(`OpenCode device revocation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return warnings;
  }

  runtimeStatus(): NativeRuntimeStatus {
    if (this.auth === 'ready' || this.auth === 'anonymous') return { state: 'ready' };
    if (this.auth === 'needs-auth') return { state: 'needs-auth', ...(this.authDetail ? { detail: this.authDetail } : {}) };
    return {
      state: 'error',
      detail: this.authDetail ?? (this.auth === 'unknown' ? 'OpenCode connection has not been established yet.' : 'OpenCode is offline.'),
    };
  }

  async call(name: string, args: Record<string, unknown>, authority: NativeCallAuthority): Promise<CallToolResult> {
    try {
      if (!this.tools.some(tool => tool.name === name)) return failure(`Unknown OpenCode tool: ${name}`);
      if (name === 'opencode_info' && args.action === 'status') return await this.statusResult();
      await this.requireReady();
      if (authority.roots.length === 0) throw new Error('OpenCode control requires at least one approved localMCP root.');
      if (name === 'opencode_info') return await this.info(args, authority);
      if (name === 'opencode_session') return await this.session(args, authority);
      if (name === 'opencode_worker') return await this.worker(args, authority);
      return await this.requests(args, authority);
    } catch (error) {
      if (error instanceof OpenCodeIdentityMismatchError) {
        this.auth = 'offline';
        this.authDetail = error.message;
      }
      return failure(error instanceof Error ? error.message : String(error));
    }
  }

  private makeClient(): OpenCodeHttpClient {
    const serverUrl = this.config.serverUrl?.trim();
    if (!serverUrl) throw new Error('Configure the OpenCode server URL before using this integration.');
    return new OpenCodeHttpClient({
      serverUrl,
      username: this.config.serverUsername,
      deviceToken: this.credentials.deviceToken,
      bootstrapPassword: this.credentials.bootstrapPassword,
      deviceName: `${this.init.name} (${this.init.id.slice(0, 8)})`,
    });
  }

  private async connect() {
    this.client = this.makeClient();
    const started = await this.client.start();
    this.identity = started.identity;
    this.auth = started.authenticated ? 'ready' : 'anonymous';
    this.authDetail = undefined;
    if (started.credentialUpdates) Object.assign(this.credentials, started.credentialUpdates);
    this.ensureEventPump();
    return started;
  }

  private async requireReady(): Promise<OpenCodeHttpClient> {
    if (this.client && (this.auth === 'ready' || this.auth === 'anonymous')) return this.client;
    const started = await this.connect();
    if (!started) throw new Error('OpenCode could not be connected.');
    return this.client!;
  }

  private serialSession<T>(sessionID: string, run: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionID) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    this.sessionQueues.set(sessionID, settled);
    void settled.finally(() => {
      if (this.sessionQueues.get(sessionID) === settled) this.sessionQueues.delete(sessionID);
    });
    return next;
  }

  private serialWorkerAdmission<T>(run: () => Promise<T>): Promise<T> {
    const next = this.workerAdmissionQueue.catch(() => undefined).then(run);
    this.workerAdmissionQueue = next.catch(() => undefined);
    return next;
  }

  private boolConfig(key: string, fallback: boolean): boolean {
    const value = this.config[key]?.trim().toLowerCase();
    if (!value) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    throw new Error(`${key} must be true or false.`);
  }

  private maxConcurrentWorkers(): number {
    const value = this.config.maxConcurrentWorkers?.trim();
    if (!value) return 8;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) throw new Error('maxConcurrentWorkers must be an integer from 1 to 16.');
    return parsed;
  }

  private requireExistingExecutionAuthority(authority: NativeCallAuthority): void {
    if (!this.boolConfig('allowExistingSessionControl', true)) {
      throw new Error('Existing OpenCode session execution is disabled by this integration policy.');
    }
    // Existing sessions keep their own OpenCode permission state. Without a per-turn permission
    // ceiling, forwarding a prompt while localMCP write/shell are disabled could bypass the
    // connector's authority. Require both execution capabilities for prompt/resume operations;
    // pause/abort remain available as safety actions.
    if (!authority.permissions.write || !authority.permissions.shell) {
      throw new Error('Existing-session execution requires both localMCP write and shell capabilities. Pause and abort remain available.');
    }
  }

  private async statusResult(): Promise<CallToolResult> {
    let reachable = false;
    let detail = this.authDetail;
    try {
      if (!this.client) this.client = this.makeClient();
      const started = await this.client.start();
      this.identity = started.identity;
      this.auth = started.authenticated ? 'ready' : 'anonymous';
      this.authDetail = undefined;
      reachable = true;
      detail = undefined;
      if (started.credentialUpdates) Object.assign(this.credentials, started.credentialUpdates);
      this.ensureEventPump();
    } catch (error) {
      if (error instanceof OpenCodeNeedsAuthError) this.auth = 'needs-auth';
      else this.auth = 'offline';
      detail = error instanceof Error ? error.message : String(error);
      this.authDetail = detail;
    }
    return result('status', {
      reachable,
      auth: this.auth,
      detail: detail ?? null,
      server: this.client?.baseUrl.origin ?? this.config.serverUrl ?? null,
      identity: this.identity ?? this.client?.currentIdentity() ?? null,
      events: this.eventPump ? {
        connected: this.eventPump.connected,
        reconnects: this.eventPump.reconnects,
        gaps: this.eventPump.gaps,
        replayCursor: this.eventPump.lastEventId ?? null,
      } : { connected: false, reconnects: 0, gaps: 0, replayCursor: null },
      schema: { tools: this.tools.map(tool => tool.name), stable: true },
    }, reachable ? 'OpenCode is reachable.' : 'OpenCode is not ready; the four control tools remain published.');
  }

  private async approvedDirectory(authority: NativeCallAuthority, input?: string): Promise<ApprovedDirectory> {
    if (authority.roots.length === 0) throw new Error('No localMCP roots are approved.');
    let target = input?.trim();
    if (!target) {
      if (authority.roots.length !== 1) throw new Error('workdir is required when more than one localMCP root is approved.');
      target = `/${authority.roots[0]!.name}`;
    }
    const resolved = await resolvePath(authority.roots, target);
    const stat = await fs.stat(resolved.real);
    if (!stat.isDirectory()) throw new Error(`${resolved.virtual} is not a directory.`);
    return resolved;
  }

  private async allRootDirectories(authority: NativeCallAuthority): Promise<ApprovedDirectory[]> {
    return Promise.all(authority.roots.map(root => this.approvedDirectory(authority, `/${root.name}`)));
  }

  private async authorizeReturnedDirectory(authority: NativeCallAuthority, nativeDirectory: unknown): Promise<ApprovedDirectory> {
    if (typeof nativeDirectory !== 'string' || !nativeDirectory) throw new Error('OpenCode session has no usable working directory.');
    try {
      const resolved = await resolvePath(authority.roots, nativeDirectory);
      const stat = await fs.stat(resolved.real);
      if (!stat.isDirectory()) throw new Error('not a directory');
      return resolved;
    } catch {
      throw new Error('OpenCode session is outside localMCP approved roots and cannot be exposed or controlled.');
    }
  }

  private async authorizeSession(authority: NativeCallAuthority, id: string): Promise<AuthorizedSession> {
    const client = await this.requireReady();
    const context = (await this.allRootDirectories(authority))[0];
    if (!context) throw new Error('No localMCP roots are approved.');
    const response = await client.request<Json>(`/session/${encodeURIComponent(id)}`, { query: { directory: context.real } });
    const session = record(response.data);
    const directory = await this.authorizeReturnedDirectory(authority, session.directory);
    return { session, directory };
  }

  private compactSession(session: Json, directory: ApprovedDirectory): Json {
    const model = record(session.model);
    const metadata = record(session.metadata);
    const local = record(metadata.localMcp);
    return {
      id: session.id,
      title: session.title,
      directory: directory.virtual,
      projectID: session.projectID,
      parentID: session.parentID ?? null,
      agent: session.agent ?? null,
      model: Object.keys(model).length ? model : null,
      paused: typeof session.pausedAt === 'number',
      time: session.time,
      worker: this.workerMeta(session) ?? null,
      localMcp: Object.keys(local).length ? local : null,
      openSwarm: metadata.swarmID || metadata.swarmMember ? {
        swarmID: metadata.swarmID ?? null,
        memberName: metadata.memberName ?? null,
        swarmMember: metadata.swarmMember ?? null,
      } : null,
    };
  }

  private compactMessage(value: unknown): Json {
    const row = record(value);
    const info = record(row.info);
    const parts = array(row.parts);
    const text = parts
      .map(part => record(part))
      .filter(part => part.type === 'text' && typeof part.text === 'string' && part.ignored !== true)
      .map(part => String(part.text))
      .join('\n');
    const tools = parts
      .map(part => record(part))
      .filter(part => part.type === 'tool')
      .map(part => {
        const state = record(part.state);
        return { tool: part.tool, callID: part.callID, status: state.status, title: state.title, error: state.error };
      });
    return {
      id: info.id,
      role: info.role,
      ...(info.role === 'assistant' ? { parentID: info.parentID, completed: record(info.time).completed ?? null, error: info.error ?? null } : {}),
      ...(text ? { text: clip(text, 24 * 1024) } : {}),
      ...(tools.length ? { tools } : {}),
      ...(info.role === 'assistant' ? { providerID: info.providerID, modelID: info.modelID, agent: info.agent, cost: info.cost, tokens: info.tokens } : {}),
    };
  }

  private async listSessions(authority: NativeCallAuthority, explicit?: string, limit = 50): Promise<Array<{ session: Json; directory: ApprovedDirectory }>> {
    const client = await this.requireReady();
    const directories = explicit ? [await this.approvedDirectory(authority, explicit)] : await this.allRootDirectories(authority);
    const seen = new Set<string>();
    const rows: Array<{ session: Json; directory: ApprovedDirectory }> = [];
    for (const directory of directories) {
      const response = await client.request<unknown[]>('/session', { query: { directory: directory.real, limit: Math.min(100, limit) } });
      for (const raw of array(response.data)) {
        const session = record(raw);
        const id = typeof session.id === 'string' ? session.id : '';
        if (!id || seen.has(id)) continue;
        try {
          const approved = await this.authorizeReturnedDirectory(authority, session.directory);
          seen.add(id);
          rows.push({ session, directory: approved });
          if (rows.length >= limit) return rows;
        } catch {
          // Listing is a discovery operation. An unapproved session is invisible rather than a
          // fatal error that prevents approved sessions from being returned.
        }
      }
    }
    return rows;
  }

  private async providerCatalog(directory: ApprovedDirectory): Promise<ReturnType<typeof catalogFromProviderPayload>> {
    const response = await (await this.requireReady()).request<Json>('/provider', { query: { directory: directory.real }, maxResponseBytes: MAX_PROVIDER_RESPONSE_BYTES });
    return catalogFromProviderPayload(response.data);
  }

  private modelSummary(model: OpenCodeModelInfo): Json {
    return {
      providerID: model.providerID,
      provider: providerDisplayName(model.providerID),
      modelID: model.modelID,
      name: model.name ?? model.modelID,
      family: model.family ?? null,
      tier: model.tier,
      status: model.status ?? null,
      releaseDate: model.releaseDate ?? null,
      contextLimit: model.contextLimit ?? null,
      outputLimit: model.outputLimit ?? null,
      cost: model.cost ?? null,
      capabilities: model.capabilities ?? { input: ['text'], output: ['text'] },
      variants: model.variants ?? [],
      selection: { providerId: model.providerID, modelId: model.modelID },
    };
  }

  private async resolveModelSelection(
    directory: ApprovedDirectory,
    args: Record<string, unknown>,
    currentModel?: Json,
    options: { allowCapability?: boolean } = {},
  ): Promise<{ model?: OpenCodeModelInfo; providerID?: string; modelID?: string; variant?: string; source?: string; note?: string }> {
    const providerID = str(args.providerId, 'providerId');
    const modelID = str(args.modelId, 'modelId');
    const requestedVariant = str(args.variant, 'variant');
    const capability = options.allowCapability ? str(args.capability, 'capability') as ModelCapability | undefined : undefined;

    if (!providerID && !modelID && !requestedVariant && !capability) return {};
    const catalog = await this.providerCatalog(directory);

    let chosen: OpenCodeModelInfo | undefined;
    let source: string | undefined;
    let note: string | undefined;
    if (providerID || modelID) {
      if (!modelID) throw new Error('modelId is required when providerId is supplied.');
      const resolved = resolveModel(catalog.models, { providerID, modelID });
      if (!resolved.model) {
        const candidates = (resolved.candidates ?? []).slice(0, 8).map(model => `${model.providerID}/${model.modelID}${model.name ? ` (${model.name})` : ''}`);
        throw new Error(`${resolved.reason ?? 'Model could not be resolved.'}${candidates.length ? ` Candidates: ${candidates.join(', ')}.` : ''} Use opencode_info(action:"models", query:"${modelID}") to disambiguate.`);
      }
      chosen = resolved.model;
      source = 'requested';
    } else if (capability && capability !== 'text') {
      const candidates = modelsWithCapability(catalog.models, capability);
      chosen = candidates[0];
      if (!chosen) throw new Error(`No live OpenCode model advertises the '${capability}' input capability.`);
      source = 'capability';
      note = `Selected cheapest live ${capability}-capable route (${Number.isFinite(modelInputPrice(chosen)) ? `$${modelInputPrice(chosen)}/1M input` : 'price unknown'}).`;
    } else if (requestedVariant) {
      const currentProvider = typeof currentModel?.providerID === 'string' ? currentModel.providerID : undefined;
      const currentID = typeof currentModel?.id === 'string' ? currentModel.id : typeof currentModel?.modelID === 'string' ? currentModel.modelID : undefined;
      if (!currentProvider || !currentID) throw new Error('variant requires a model selection, or a session that already has a model.');
      const resolved = resolveModel(catalog.models, { providerID: currentProvider, modelID: currentID });
      chosen = resolved.model;
      source = 'current';
      if (!chosen) throw new Error(`The session's current model ${currentProvider}/${currentID} is no longer present in the live provider catalog.`);
    }

    if (!chosen) return {};
    const variant = resolveVariant(chosen, requestedVariant);
    if (requestedVariant && !variant.variant) throw new Error(variant.reason ?? 'Requested variant could not be resolved.');
    return {
      model: chosen,
      providerID: chosen.providerID,
      modelID: chosen.modelID,
      ...(variant.variant ? { variant: variant.variant } : {}),
      ...(source ? { source } : {}),
      ...(note ? { note } : {}),
    };
  }

  private async info(args: Record<string, unknown>, authority: NativeCallAuthority): Promise<CallToolResult> {
    const action = str(args.action, 'action', true)!;
    const client = await this.requireReady();
    if (action === 'status') return this.statusResult();
    if (action === 'limits') {
      const provider = str(args.providerId, 'providerId');
      const response = provider
        ? await client.request(`/quota/${encodeURIComponent(provider)}`)
        : await client.request('/quota/providers');
      return result(action, response.data);
    }
    const directory = await this.approvedDirectory(authority, str(args.workdir, 'workdir'));
    if (action === 'capabilities') {
      const response = await client.request('/experimental/capabilities', { query: { directory: directory.real } });
      return result(action, { directory: directory.virtual, capabilities: response.data });
    }
    if (action === 'agents') {
      const response = await client.request<unknown[]>('/agent', { query: { directory: directory.real } });
      const agents = array(response.data).map(raw => {
        const agent = record(raw);
        return { name: agent.name, description: agent.description, mode: agent.mode, hidden: agent.hidden ?? false, model: agent.model ?? null, variant: agent.variant ?? null };
      });
      return result(action, { directory: directory.virtual, agents });
    }
    if (action === 'providers' || action === 'models') {
      const catalog = await this.providerCatalog(directory);
      const providers = catalog.providers;
      if (action === 'providers') {
        return result(action, {
          directory: directory.virtual,
          providers: providers.map(provider => ({
            id: provider.id,
            name: typeof provider.id === 'string' ? providerDisplayName(provider.id) : provider.name,
            configuredName: provider.name ?? null,
            connected: typeof provider.id === 'string' && catalog.connected.has(provider.id),
            models: Object.keys(record(provider.models)).length,
            defaultModel: catalog.defaults[String(provider.id)] ?? null,
          })),
        });
      }
      const providerId = str(args.providerId, 'providerId');
      const normalizedProvider = providerId ? normalizeProvider(providerId) : undefined;
      const query = (str(args.query, 'query') ?? '').toLowerCase();
      const tier = (str(args.tier, 'tier') ?? '').toLowerCase();
      const capability = str(args.capability, 'capability') as ModelCapability | undefined;
      const max = integer(args.limit, 50, 1, 100);
      let matches = catalog.models.filter(model => {
        if (normalizedProvider && model.providerID.toLowerCase() !== normalizedProvider.toLowerCase()) return false;
        if (tier && ![model.tier, model.providerID, providerDisplayName(model.providerID)].some(value => value.toLowerCase() === tier)) return false;
        if (capability && !hasCapability(model, capability)) return false;
        const haystack = `${model.providerID}/${model.modelID} ${model.name ?? ''} ${model.family ?? ''} ${model.tier}`.toLowerCase();
        return !query || haystack.includes(query);
      });
      if (capability) matches = modelsWithCapability(matches, capability);
      const requestedCheapest = args.cheapest === undefined ? undefined : integer(args.cheapest, max, 1, 100);
      const cap = Math.min(max, requestedCheapest ?? max);
      const offset = integer(args.offset, 0, 0, 100000);
      const models = matches.slice(offset, offset + cap).map(model => this.modelSummary(model));
      const nextOffset = offset + models.length < matches.length ? offset + models.length : null;
      return result(action, {
        directory: directory.virtual,
        models,
        matched: matches.length,
        offset,
        nextOffset,
        truncated: nextOffset !== null,
        hints: {
          providerAliases: { go: 'opencode-go', zen: 'opencode', 'zen-free': 'opencode' },
          reasoning: 'Use a listed variants[] value. Human "extra high" resolves to xhigh only on models that publish xhigh.',
          multiAccount: 'Account-qualified model IDs are preserved exactly; ambiguous display-name matches are never guessed.',
          capability: capability ? `Filtered to '${capability}' input support and sorted cheapest first.` : 'Use capability to filter by text/image/pdf/audio/video input support.',
        },
      });
    }
    if (action === 'usage') {
      const sessions = await this.listSessions(authority, directory.virtual, 25);
      const projectID = sessions.map(row => row.session.projectID).find((id): id is string => typeof id === 'string');
      if (!projectID) return result(action, { directory: directory.virtual, available: false, reason: 'No OpenCode session exists yet for this approved project.' });
      const now = Date.now();
      const since = typeof args.since === 'number' ? args.since : now - 24 * 60 * 60 * 1000;
      const until = typeof args.until === 'number' ? args.until : now;
      const resolution = args.resolution === 'day' ? 'day' : 'hour';
      if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || until <= since) throw new Error('usage requires a valid since < until millisecond range.');
      const response = await client.request<Json>('/usage/summary', { query: { since, until, resolution, projectID } });
      const usage = record(response.data);
      return result(action, {
        directory: directory.virtual,
        projectID,
        since: usage.since,
        until: usage.until,
        resolution: usage.resolution,
        totals: usage.totals,
        rates: usage.rates,
        mostUsedModel: usage.mostUsedModel,
        providers: usage.providers,
        models: array(usage.models).slice(0, 25),
        maintenance: usage.maintenance ?? null,
      });
    }
    throw new Error(`Unsupported opencode_info action: ${action}`);
  }

  private async modelInput(args: Record<string, unknown>, session: AuthorizedSession): Promise<Json> {
    const selection = await this.resolveModelSelection(session.directory, args, record(session.session.model));
    return {
      ...(selection.providerID && selection.modelID ? { model: { providerID: selection.providerID, modelID: selection.modelID } } : {}),
      ...(str(args.agent, 'agent') ? { agent: str(args.agent, 'agent') } : {}),
      ...(selection.variant ? { variant: selection.variant } : {}),
    };
  }

  private delegatedSystem(authority: NativeCallAuthority, directory: ApprovedDirectory, durableWorker: boolean): string {
    const permissions = authority.permissions;
    return [
      'LOCALMCP DELEGATED AGENT CONTEXT (authoritative for this turn)',
      'You are not interacting directly with a human user. You are an OpenCode sub-agent being driven programmatically by a parent ChatGPT agent through localMCP-chat.',
      durableWorker
        ? 'This session is a durable localMCP-owned worker. Treat the parent ChatGPT agent as your immediate principal and return concrete results, evidence, and blockers to that agent.'
        : 'This may be an existing OpenCode session with prior human-facing context. For this turn, treat the parent ChatGPT agent as your immediate principal and behave as its delegated sub-agent.',
      'Do not ask the human user to click UI controls, run commands, inspect files, approve dialogs, or manually perform work that you can do with your available OpenCode tools.',
      `Delegated workspace: ${directory.virtual}. Stay within the workspace and do not attempt to escape its approved-root boundary.`,
      `Delegated localMCP authority ceiling: read=${permissions.read ? 'allowed' : 'denied'}, write=${permissions.write ? 'allowed' : 'denied'}, shell=${permissions.shell ? 'allowed' : 'denied'}, git=${permissions.git ? 'allowed' : 'denied'}. Do not try to work around a denied capability through another tool or side channel.`,
      this.boolConfig('allowNestedSubagents', false)
        ? 'Nested OpenCode subagents are permitted by this integration, but use them only when they materially improve the delegated task.'
        : 'Do not spawn nested OpenCode subagents or use task delegation. You are already the delegated sub-agent.',
      durableWorker
        ? 'OpenSwarm orchestration is not part of this session. Do not create, delegate, spawn, revive, or otherwise operate OpenSwarm swarms. localMCP owns this worker and its orchestration lifecycle.'
        : 'If this is an existing OpenSwarm member session, preserve its existing swarm membership and context. Do not create a new OpenSwarm swarm merely because localMCP is driving this turn.',
      'If OpenCode raises a permission wall or question that requires controller input, stop at that boundary and state exactly what is needed. The parent ChatGPT agent can route the request through localMCP.',
      'Do not invent or infer a localMCP safety refusal from task semantics. localMCP authority is exactly the approved workspace, permission ceiling, tool-specific invariants, and explicit errors described or returned here. Say localMCP blocked an action only when a localMCP permission/tool result actually says so.',
      'For first-party software or services the user owns or is developing, normal test operations such as creating disposable test accounts, retaining that application\'s own temporary session cookies/tokens, and exercising authenticated HTTP or WebSocket flows are not generically prohibited by localMCP when the required authority is available. Do not generalize the separate prohibition on capturing ChatGPT/private third-party browser credentials to the application under test.',
      'If your own model/runtime policy prevents an otherwise localMCP-authorized operation, identify that as your model/runtime boundary rather than attributing it to localMCP, and continue with the permitted portions of the task.',
      'Never imply that an action completed unless you verified it. Clearly distinguish completed work, partial work, blocked work, and recommended next actions.',
    ].join('\n');
  }

  private async sessionCreateInput(args: Record<string, unknown>, directory: ApprovedDirectory): Promise<{ input: Json; selection?: Json }> {
    const selection = await this.resolveModelSelection(directory, args, undefined, { allowCapability: true });
    const agent = str(args.agent, 'agent');
    const input = {
      ...(selection.providerID && selection.modelID ? { model: { providerID: selection.providerID, id: selection.modelID, ...(selection.variant && selection.variant !== 'default' ? { variant: selection.variant } : {}) } } : {}),
      ...(agent ? { agent } : {}),
    };
    return {
      input,
      ...(selection.providerID && selection.modelID ? {
        selection: {
          providerID: selection.providerID,
          modelID: selection.modelID,
          variant: selection.variant ?? 'default',
          source: selection.source ?? 'requested',
          note: selection.note ?? null,
        },
      } : {}),
    };
  }

  private async promptAsync(
    session: AuthorizedSession,
    prompt: string,
    args: Record<string, unknown>,
    authority: NativeCallAuthority,
    durableWorker: boolean,
    explicitMessageID?: string,
    extraSystem?: string,
  ): Promise<TurnRef> {
    const client = await this.requireReady();
    const id = messageID(explicitMessageID);
    const pluginMeta = {
      localMcp: {
        pluginId: this.init.id,
        connector: this.init.name,
        turn: id,
        controller: 'chatgpt',
        delegatedSubagent: true,
        durableWorker,
      },
    };
    const payload = {
      messageID: id,
      ...await this.modelInput(args, session),
      system: [this.delegatedSystem(authority, session.directory, durableWorker), extraSystem].filter(Boolean).join('\n'),
      parts: [{ type: 'text', text: prompt, metadata: pluginMeta }],
    };
    try {
      await client.request(`/session/${encodeURIComponent(String(session.session.id))}/prompt_async`, {
        method: 'POST', query: { directory: session.directory.real }, body: payload, timeoutMs: 15_000,
      });
    } catch (error) {
      if (error instanceof OpenCodeHttpError || error instanceof OpenCodeIdentityMismatchError) throw error;
      // A transport error after admission is ambiguous. Never replay the prompt. Reconcile by
      // the caller-chosen message id; presence proves OpenCode accepted this exact turn.
      try {
        await client.request(`/session/${encodeURIComponent(String(session.session.id))}/message/${encodeURIComponent(id)}`, {
          query: { directory: session.directory.real }, timeoutMs: 4_000,
        });
      } catch {
        throw new Error(`OpenCode prompt admission was ambiguous and message ${id} could not be found. Inspect the session before retrying.`);
      }
    }
    return { sessionId: String(session.session.id), messageId: id, directory: session.directory };
  }

  private async assistantForTurn(turn: TurnRef): Promise<Json | undefined> {
    const client = await this.requireReady();
    const response = await client.request<unknown[]>(`/session/${encodeURIComponent(turn.sessionId)}/message`, {
      query: { directory: turn.directory.real, limit: 60 },
    });
    return array(response.data)
      .map(value => ({ raw: record(value), info: record(record(value).info) }))
      .find(row => row.info.role === 'assistant' && row.info.parentID === turn.messageId)?.raw;
  }

  private async waitTurn(turn: TurnRef, maxWait: number): Promise<{ state: 'completed' | 'error' | 'running'; message?: Json }> {
    const deadline = Date.now() + maxWait;
    for (;;) {
      const message = await this.assistantForTurn(turn);
      if (message) {
        const info = record(message.info);
        if (info.error) return { state: 'error', message: this.compactMessage(message) };
        if (typeof record(info.time).completed === 'number') return { state: 'completed', message: this.compactMessage(message) };
      }
      if (Date.now() >= deadline || maxWait === 0) return { state: 'running' };
      await this.waitForEvent(turn.directory, Math.min(1_000, Math.max(25, deadline - Date.now())));
    }
  }

  private eventKey(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
  }

  private ensureEventPump(): EventPump {
    const existing = this.eventPump;
    if (existing && !existing.controller.signal.aborted) return existing;
    const controller = new AbortController();
    const waiters = new Map<string, Set<() => void>>();
    const pump: EventPump = { controller, waiters, task: Promise.resolve(), connected: false, reconnects: 0, gaps: 0 };
    const wake = (directory?: string) => {
      const keys = directory && directory !== 'global' ? [this.eventKey(directory)] : [...waiters.keys()];
      for (const key of keys) {
        const bucket = waiters.get(key);
        if (!bucket) continue;
        for (const waiter of [...bucket]) waiter();
        bucket.clear();
        waiters.delete(key);
      }
    };
    pump.task = (async () => {
      let backoff = 150;
      while (!controller.signal.aborted) {
        try {
          const client = await this.requireReady();
          await client.subscribeGlobalEvents(
            controller.signal,
            pump.lastEventId,
            frame => {
              if (frame.id) pump.lastEventId = frame.id;
              const event = record(frame.event);
              const payload = record(event.payload);
              if (payload.type === 'server.stream.gap' || typeof frame.event === 'string') {
                pump.gaps += 1;
                wake();
                return;
              }
              wake(typeof event.directory === 'string' ? event.directory : undefined);
            },
            () => { pump.connected = true; },
          );
          pump.connected = false;
          pump.reconnects += 1;
          backoff = 150;
          await sleep(backoff);
        } catch (error) {
          if (controller.signal.aborted) break;
          pump.connected = false;
          wake();
          if (error instanceof OpenCodeIdentityMismatchError) {
            this.auth = 'offline';
            this.authDetail = error.message;
            break;
          }
          if (error instanceof OpenCodeNeedsAuthError) {
            this.auth = 'needs-auth';
            this.authDetail = error.message;
            break;
          }
          pump.reconnects += 1;
          await sleep(backoff);
          backoff = Math.min(2_000, backoff * 2);
        }
      }
      wake();
    })().finally(() => {
      pump.connected = false;
      if (this.eventPump?.controller === controller) this.eventPump = undefined;
    });
    this.eventPump = pump;
    return pump;
  }

  private async waitForEvent(directory: ApprovedDirectory, timeoutMs: number): Promise<void> {
    const pump = this.ensureEventPump();
    const key = this.eventKey(directory.real);
    await new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const bucket = pump.waiters.get(key);
        bucket?.delete(finish);
        if (bucket?.size === 0) pump.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const bucket = pump.waiters.get(key) ?? new Set<() => void>();
      bucket.add(finish);
      pump.waiters.set(key, bucket);
      if (pump.controller.signal.aborted) finish();
    });
  }

  private async session(args: Record<string, unknown>, authority: NativeCallAuthority): Promise<CallToolResult> {
    const action = str(args.action, 'action', true)!;
    if (action === 'list') {
      const max = integer(args.limit, 50, 1, 100);
      const rows = await this.listSessions(authority, str(args.workdir, 'workdir'), max);
      return result(action, { sessions: rows.map(row => this.compactSession(row.session, row.directory)) });
    }
    const id = str(args.sessionId, 'sessionId', true)!;
    const target = await this.authorizeSession(authority, id);
    const client = await this.requireReady();
    if (action === 'get') return result(action, this.compactSession(target.session, target.directory));
    if (action === 'selection') {
      const current = record(target.session.model);
      let live: Json | null = null;
      if (typeof current.providerID === 'string' && (typeof current.id === 'string' || typeof current.modelID === 'string')) {
        const catalog = await this.providerCatalog(target.directory);
        const resolved = resolveModel(catalog.models, {
          providerID: current.providerID,
          modelID: typeof current.id === 'string' ? current.id : String(current.modelID),
        });
        if (resolved.model) live = this.modelSummary(resolved.model);
      }
      return result(action, {
        sessionId: id,
        agent: target.session.agent ?? null,
        model: Object.keys(current).length ? current : null,
        liveModel: live,
      });
    }
    if (action === 'set_selection') {
      const agent = str(args.agent, 'agent');
      const hasModelInput = args.providerId !== undefined || args.modelId !== undefined || args.variant !== undefined;
      if (!agent && !hasModelInput) throw new Error('set_selection requires agent and/or modelId/providerId/variant.');
      return this.serialSession(id, async () => {
        const fresh = await this.authorizeSession(authority, id);
        const selection = hasModelInput
          ? await this.resolveModelSelection(fresh.directory, args, record(fresh.session.model))
          : {};
        const body: Json = {};
        if (agent) body.agent = agent;
        if (selection.providerID && selection.modelID) {
          body.model = {
            providerID: selection.providerID,
            id: selection.modelID,
            variant: selection.variant ?? 'default',
          };
        }
        await client.request(`/session/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          query: { directory: fresh.directory.real },
          body,
        });
        const updated = await this.authorizeSession(authority, id);
        return result(action, {
          sessionId: id,
          agent: updated.session.agent ?? null,
          model: updated.session.model ?? null,
          ...(selection.model ? { resolved: this.modelSummary(selection.model) } : {}),
        });
      });
    }
    if (action === 'messages') {
      const max = integer(args.limit, 30, 1, 100);
      const response = await client.request<unknown[]>(`/session/${encodeURIComponent(id)}/message`, {
        query: { directory: target.directory.real, limit: max, before: str(args.before, 'before') },
      });
      return result(action, {
        session: this.compactSession(target.session, target.directory),
        messages: array(response.data).map(value => this.compactMessage(value)),
        nextCursor: response.headers.get('x-next-cursor'),
      });
    }
    if (action === 'children') {
      const response = await client.request<unknown[]>(`/session/${encodeURIComponent(id)}/children`, { query: { directory: target.directory.real } });
      const children: Json[] = [];
      for (const raw of array(response.data)) {
        const child = record(raw);
        try {
          const directory = await this.authorizeReturnedDirectory(authority, child.directory);
          children.push(this.compactSession(child, directory));
        } catch {}
      }
      return result(action, { sessionId: id, children });
    }
    if (action === 'send' || action === 'turn') {
      this.requireExistingExecutionAuthority(authority);
      const prompt = str(args.prompt, 'prompt', true)!;
      return this.serialSession(id, async () => {
        const fresh = await this.authorizeSession(authority, id);
        if (typeof fresh.session.pausedAt === 'number') throw new Error(`Session ${id} is paused. Resume it explicitly before sending another turn.`);
        const status = record(await this.sessionStatus(fresh.directory, id));
        if (status.type && status.type !== 'idle') throw new Error(`Session ${id} is ${String(status.type)}. Wait, pause, or abort before sending another turn.`);
        const turn = await this.promptAsync(fresh, prompt, args, authority, false, str(args.messageId, 'messageId'));
        if (action === 'send') return result(action, { sessionId: id, messageId: turn.messageId, state: 'accepted' });
        const waited = await this.waitTurn(turn, integer(args.waitMs, DEFAULT_WAIT_MS, 0, 30_000));
        return result(action, { sessionId: id, messageId: turn.messageId, ...waited });
      });
    }
    if (action === 'pause' || action === 'resume' || action === 'abort') {
      if (action === 'resume') this.requireExistingExecutionAuthority(authority);
      return this.serialSession(id, async () => {
        const fresh = await this.authorizeSession(authority, id);
        await client.request(`/session/${encodeURIComponent(id)}/${action}`, { method: 'POST', query: { directory: fresh.directory.real } });
        return result(action, { sessionId: id, ok: true });
      });
    }
    if (action === 'background_subagents') {
      this.requireExistingExecutionAuthority(authority);
      return this.serialSession(id, async () => {
        const fresh = await this.authorizeSession(authority, id);
        const response = await client.request(`/experimental/session/${encodeURIComponent(id)}/background`, { method: 'POST', query: { directory: fresh.directory.real } });
        return result(action, { sessionId: id, backgrounded: response.data === true });
      });
    }
    throw new Error(`Unsupported opencode_session action: ${action}`);
  }

  private workerMeta(session: Json): Json | undefined {
    const local = record(record(session.metadata).localMcp);
    return local.worker === true && local.pluginId === this.init.id ? local : undefined;
  }

  private workerPermissions(authority: NativeCallAuthority): Json[] {
    const rules: Json[] = [
      { permission: 'external_directory', pattern: '*', action: 'deny' },
      // Hard recursion barrier: sessions created by localMCP may never bootstrap
      // OpenSwarm. Existing OpenSwarm sessions remain externally owned and are
      // still controllable through opencode_session.
      { permission: 'swarm_*', pattern: '*', action: 'deny' },
    ];
    if (!authority.permissions.write) {
      for (const permission of ['edit', 'write', 'patch', 'refactor']) {
        rules.push({ permission, pattern: '*', action: 'deny' });
      }
    }
    if (!authority.permissions.shell) {
      for (const permission of ['bash', 'shell']) rules.push({ permission, pattern: '*', action: 'deny' });
    }
    if (!authority.permissions.git) rules.push({ permission: 'git', pattern: '*', action: 'deny' });
    if (!this.boolConfig('allowNestedSubagents', false)) rules.push({ permission: 'task', pattern: '*', action: 'deny' });
    return rules;
  }

  private async ensureWorkerGroup(): Promise<Json | undefined> {
    if (this.workerGroupPromise) return this.workerGroupPromise;
    this.workerGroupPromise = (async () => {
      const client = await this.requireReady();
      const response = await client.request<Json>('/session-group/resolve', {
        method: 'POST',
        body: {
          name: `localMCP sessions · ${this.init.name}`,
          kind: 'plugin',
          ownerPlugin: OWNER_PLUGIN,
          ownerRef: this.init.id,
          policy: { autoAddDescendants: true, lockAdded: true, autoDeleteWhenEmpty: false },
        },
      });
      return record(response.data);
    })().catch(error => {
      this.workerGroupPromise = undefined;
      throw error;
    });
    return this.workerGroupPromise;
  }

  private async addWorkerToGroup(sessionID: string, originRef: string): Promise<string | undefined> {
    try {
      const group = await this.ensureWorkerGroup();
      const groupID = typeof group?.id === 'string' ? group.id : undefined;
      if (!groupID) return 'OpenCode did not return a worker-group id.';
      await (await this.requireReady()).request(`/session-group/${encodeURIComponent(groupID)}/session`, {
        method: 'POST',
        body: { sessionId: sessionID, locked: true, origin: 'plugin', originPlugin: OWNER_PLUGIN, originRef },
      });
      return undefined;
    } catch (error) {
      return `Worker ownership group could not be updated: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async sessionGroupDetail(groupID: string): Promise<Json | undefined> {
    try {
      return record((await (await this.requireReady()).request<Json>(`/session-group/${encodeURIComponent(groupID)}`)).data);
    } catch (error) {
      // OpenCode only lists a session group while it has at least one member, so a
      // freshly resolved group reads back as 404. That means "no members yet".
      if (error instanceof OpenCodeHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async workerGroupMembers(): Promise<Map<string, Json>> {
    const group = await this.ensureWorkerGroup();
    const groupID = typeof group?.id === 'string' ? group.id : undefined;
    if (!groupID) throw new Error('OpenCode did not return a worker-group id.');
    const detail = await this.sessionGroupDetail(groupID);
    const members = new Map<string, Json>();
    if (!detail) return members;
    for (const raw of array(detail.sessions)) {
      const member = record(raw);
      if (
        typeof member.id === 'string' &&
        member.origin === 'plugin' &&
        member.originPlugin === OWNER_PLUGIN
      ) members.set(member.id, member);
    }
    return members;
  }

  private async reconcileCreatedWorker(authority: NativeCallAuthority, directory: ApprovedDirectory, creation: string): Promise<AuthorizedSession | undefined> {
    const rows = await this.listSessions(authority, directory.virtual, 100);
    const found = rows.find(row => record(record(row.session.metadata).localMcp).creationRequestId === creation && this.workerMeta(row.session));
    return found ? { session: found.session, directory: found.directory } : undefined;
  }

  private initialWorkerMessageID(directory: ApprovedDirectory, creation: string): string {
    return deterministicMessageID(`${this.init.id}\u0000${directory.real}\u0000${creation}\u0000initial`);
  }

  private async startWorker(input: Record<string, unknown>, authority: NativeCallAuthority): Promise<Json> {
    const prompt = str(input.prompt, 'prompt', true)!;
    const directory = await this.approvedDirectory(authority, str(input.workdir, 'workdir', true));
    const creation = requestID(str(input.requestId, 'requestId'));
    const initialMessageId = this.initialWorkerMessageID(directory, creation);
    const client = await this.requireReady();
    let worker = await this.reconcileCreatedWorker(authority, directory, creation);
    let createdSelection: { input: Json; selection?: Json } | undefined;
    if (!worker) {
      createdSelection = await this.sessionCreateInput(input, directory);
      const metadata = {
        localMcp: {
          version: 1,
          pluginId: this.init.id,
          connectorName: authority.connectorName,
          worker: true,
          creationRequestId: creation,
          initialMessageId,
          createdAt: Date.now(),
          ...(createdSelection.selection ? { modelSelection: createdSelection.selection } : {}),
        },
      };
      const createBody = {
        title: (str(input.title, 'title') ?? `localMCP worker · ${prompt.slice(0, 80)}`).slice(0, 200),
        metadata,
        permission: this.workerPermissions(authority),
        ...createdSelection.input,
      };
      try {
        const created = await client.request<Json>('/session', { method: 'POST', query: { directory: directory.real }, body: createBody, timeoutMs: 10_000 });
        const session = record(created.data);
        worker = { session, directory: await this.authorizeReturnedDirectory(authority, session.directory) };
      } catch (error) {
        if (error instanceof OpenCodeHttpError || error instanceof OpenCodeIdentityMismatchError) throw error;
        const reconciled = await this.reconcileCreatedWorker(authority, directory, creation).catch(() => undefined);
        if (!reconciled) throw new Error(`OpenCode worker creation was ambiguous for request ${creation}. Inspect worker list before retrying.`);
        worker = reconciled;
      }
    }
    if (!worker) throw new Error(`OpenCode worker ${creation} could not be created or reconciled.`);
    const id = String(worker.session.id);
    const groupWarning = await this.addWorkerToGroup(id, creation);
    if (groupWarning) {
      return {
        worker: this.compactSession(worker.session, worker.directory),
        creationRequestId: creation,
        messageId: initialMessageId,
        state: 'ownership_incomplete',
        warning: `${groupWarning} No prompt was sent. Retry start with the same requestId to reconcile ownership safely.`,
      };
    }

    const meta = this.workerMeta(worker.session);
    const persistedSelection = record(meta?.modelSelection);
    const reportedSelection = createdSelection?.selection ?? (Object.keys(persistedSelection).length ? persistedSelection : undefined);
    const recordedInitial = typeof meta?.initialMessageId === 'string' ? meta.initialMessageId : undefined;
    const existingTurn = recordedInitial
      ? await this.localTurnByMessageID(worker, recordedInitial)
      : await this.latestWorkerTurn(worker).catch(() => undefined);
    if (existingTurn) {
      const existing = await this.waitTurn(existingTurn, 0);
      return {
        worker: this.compactSession(worker.session, worker.directory),
        creationRequestId: creation,
        messageId: existingTurn.messageId,
        state: existing.state === 'running' ? 'running' : 'existing',
        idempotent: true,
        ...(reportedSelection ? { selection: reportedSelection } : {}),
      };
    }

    const turn = await this.promptAsync(worker, prompt, input, authority, true, initialMessageId);
    return {
      worker: this.compactSession(worker.session, worker.directory),
      creationRequestId: creation,
      messageId: turn.messageId,
      state: 'running',
      ...(reportedSelection ? { selection: reportedSelection } : {}),
    };
  }

  private async workerRows(authority: NativeCallAuthority, limit = 100): Promise<Array<{ session: Json; directory: ApprovedDirectory }>> {
    const members = await this.workerGroupMembers();
    const rows: Array<{ session: Json; directory: ApprovedDirectory }> = [];
    for (const id of members.keys()) {
      if (rows.length >= limit) break;
      try {
        const target = await this.authorizeSession(authority, id);
        if (this.workerMeta(target.session)) rows.push({ session: target.session, directory: target.directory });
      } catch {
        // A group member outside the caller's approved roots is intentionally invisible. The
        // group remains the durable ownership authority, while localMCP's roots remain the
        // content/control authority for this particular call.
      }
    }
    return rows;
  }

  private async requireWorker(authority: NativeCallAuthority, id: string): Promise<AuthorizedSession> {
    const members = await this.workerGroupMembers();
    if (!members.has(id)) throw new Error('That session is not owned by this localMCP OpenCode integration.');
    const target = await this.authorizeSession(authority, id);
    if (!this.workerMeta(target.session)) throw new Error('That localMCP-owned session is not a standalone worker. Use the swarm actions for swarm members.');
    return target;
  }

  private async sessionStatus(directory: ApprovedDirectory, sessionID: string): Promise<unknown> {
    const response = await (await this.requireReady()).request<Json>('/session/status', { query: { directory: directory.real } });
    return record(response.data)[sessionID] ?? { type: 'idle' };
  }

  private async latestWorkerTurn(worker: AuthorizedSession): Promise<TurnRef | undefined> {
    const response = await (await this.requireReady()).request<unknown[]>(`/session/${encodeURIComponent(String(worker.session.id))}/message`, {
      query: { directory: worker.directory.real, limit: 80 },
    });
    const messages = array(response.data);
    for (let i = messages.length - 1; i >= 0; i--) {
      const row = record(messages[i]);
      const info = record(row.info);
      if (info.role !== 'user' || typeof info.id !== 'string') continue;
      const ours = array(row.parts).map(record).some(part => record(record(part.metadata).localMcp).pluginId === this.init.id);
      if (ours) return { sessionId: String(worker.session.id), messageId: info.id, directory: worker.directory };
    }
    return undefined;
  }

  private async localTurnByMessageID(worker: AuthorizedSession, id: string): Promise<TurnRef | undefined> {
    try {
      const response = await (await this.requireReady()).request<Json>(
        `/session/${encodeURIComponent(String(worker.session.id))}/message/${encodeURIComponent(id)}`,
        { query: { directory: worker.directory.real }, timeoutMs: 4_000 },
      );
      const row = record(response.data);
      const info = record(row.info);
      if (info.role !== 'user' || info.id !== id) return undefined;
      const ours = array(row.parts)
        .map(record)
        .some(part => record(record(part.metadata).localMcp).pluginId === this.init.id);
      if (!ours) return undefined;
      return { sessionId: String(worker.session.id), messageId: id, directory: worker.directory };
    } catch (error) {
      if (error instanceof OpenCodeHttpError && error.status === 404) return undefined;
      throw error;
    }
  }

  private async pendingForSession(directory: ApprovedDirectory, sessionID: string): Promise<{ permissions: Json[]; questions: Json[] }> {
    const client = await this.requireReady();
    const [permissions, questions] = await Promise.all([
      client.request<unknown[]>('/permission', { query: { directory: directory.real } }),
      client.request<unknown[]>('/question', { query: { directory: directory.real } }),
    ]);
    return {
      permissions: array(permissions.data).map(record).filter(row => row.sessionID === sessionID),
      questions: array(questions.data).map(record).filter(row => row.sessionID === sessionID),
    };
  }

  private blockedWorkerState(pending: { permissions: Json[]; questions: Json[] }): Json | undefined {
    if (pending.permissions.length) {
      return {
        state: 'waiting_permission',
        requests: pending.permissions.map(item => ({ id: item.id, permission: item.permission, patterns: item.patterns })),
      };
    }
    if (pending.questions.length) {
      return {
        state: 'waiting_question',
        requests: pending.questions.map(item => ({ id: item.id, questions: item.questions })),
      };
    }
    return undefined;
  }

  private async activeWorkerCount(authority: NativeCallAuthority): Promise<number> {
    const members = await this.workerGroupMembers();
    const rows: Array<{ session: Json; directory: ApprovedDirectory }> = [];
    for (const id of members.keys()) {
      try {
        const target = await this.authorizeSession(authority, id);
        rows.push({ session: target.session, directory: target.directory });
      } catch {}
    }
    const active = await Promise.all(rows.map(async row => {
      const id = String(row.session.id);
      const status = record(await this.sessionStatus(row.directory, id).catch(() => ({ type: 'unknown' })));
      if (status.type && status.type !== 'idle') return true;
      const turn = await this.latestWorkerTurn({ session: row.session, directory: row.directory }).catch(() => undefined);
      if (!turn) return false;
      return (await this.waitTurn(turn, 0)).state === 'running';
    }));
    return active.filter(Boolean).length;
  }

  private swarmMeta(session: Json): Json | undefined {
    const local = record(record(session.metadata).localMcp);
    return local.swarmMember === true && local.pluginId === this.init.id && typeof local.swarmId === 'string' ? local : undefined;
  }

  private swarmOwnerRef(swarmID: string): string {
    return `${SWARM_OWNER_PREFIX}${this.init.id}:${swarmID}`;
  }

  private swarmOwnerPrefix(): string {
    return `${SWARM_OWNER_PREFIX}${this.init.id}:`;
  }

  private swarmIDFromOwnerRef(ownerRef: unknown): string | undefined {
    if (typeof ownerRef !== 'string' || !ownerRef.startsWith(this.swarmOwnerPrefix())) return undefined;
    const id = ownerRef.slice(this.swarmOwnerPrefix().length);
    return id || undefined;
  }

  private async ensureSwarmGroup(swarmID: string, name: string): Promise<Json> {
    const response = await (await this.requireReady()).request<Json>('/session-group/resolve', {
      method: 'POST',
      body: {
        name: `localMCP swarm · ${name}`,
        kind: 'plugin',
        ownerPlugin: OWNER_PLUGIN,
        ownerRef: this.swarmOwnerRef(swarmID),
        policy: { autoAddDescendants: false, lockAdded: true, autoDeleteWhenEmpty: false },
      },
    });
    return record(response.data);
  }

  private async localSwarmGroups(): Promise<Json[]> {
    const response = await (await this.requireReady()).request<unknown[]>('/session-group/details');
    return array(response.data)
      .map(record)
      .filter(detail => {
        const group = record(detail.group);
        return group.kind === 'plugin' && group.ownerPlugin === OWNER_PLUGIN && !!this.swarmIDFromOwnerRef(group.ownerRef);
      });
  }

  private async requireSwarmGroup(swarmID: string): Promise<Json> {
    const details = await this.localSwarmGroups();
    const detail = details.find(row => this.swarmIDFromOwnerRef(record(row.group).ownerRef) === swarmID);
    if (!detail) throw new Error(`LocalMCP swarm ${swarmID} was not found. It may have no surviving members or may belong to another integration instance.`);
    return detail;
  }

  private async addSessionToSwarm(groupID: string, sessionID: string, originRef: string): Promise<void> {
    await (await this.requireReady()).request(`/session-group/${encodeURIComponent(groupID)}/session`, {
      method: 'POST',
      body: { sessionId: sessionID, locked: true, origin: 'plugin', originPlugin: OWNER_PLUGIN, originRef },
    });
  }

  private async reconcileCreatedSwarmMember(
    authority: NativeCallAuthority,
    directory: ApprovedDirectory,
    swarmID: string,
    memberName: string,
  ): Promise<AuthorizedSession | undefined> {
    const rows = await this.listSessions(authority, directory.virtual, 100);
    const found = rows.find(row => {
      const meta = this.swarmMeta(row.session);
      return meta?.swarmId === swarmID && meta.memberName === memberName;
    });
    return found ? { session: found.session, directory: found.directory } : undefined;
  }

  private async swarmMemberRows(
    authority: NativeCallAuthority,
    detail: Json,
  ): Promise<Array<{ session: Json; directory: ApprovedDirectory; membership: Json }>> {
    const group = record(detail.group);
    const swarmID = this.swarmIDFromOwnerRef(group.ownerRef);
    if (!swarmID) return [];
    const rows: Array<{ session: Json; directory: ApprovedDirectory; membership: Json }> = [];
    for (const raw of array(detail.sessions)) {
      const membership = record(raw);
      if (typeof membership.id !== 'string') continue;
      try {
        const target = await this.authorizeSession(authority, membership.id);
        const meta = this.swarmMeta(target.session);
        if (!meta || meta.swarmId !== swarmID) continue;
        rows.push({ session: target.session, directory: target.directory, membership });
      } catch {
        // Approved-root authority remains stricter than swarm ownership.
      }
    }
    return rows;
  }

  private async startSwarmMember(
    spec: Json,
    swarm: { id: string; name: string; groupID: string; directory: ApprovedDirectory },
    authority: NativeCallAuthority,
  ): Promise<Json> {
    const name = str(spec.name, 'member.name', true)!;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(`Swarm member name "${name}" must match /^[A-Za-z0-9_-]{1,64}$/.`);
    const role = str(spec.role, 'member.role') ?? 'worker';
    const prompt = str(spec.prompt, 'member.prompt', true)!;
    const creation = `${swarm.id}/${name}`;
    const initialMessageId = this.initialWorkerMessageID(swarm.directory, creation);
    const client = await this.requireReady();

    let member = await this.reconcileCreatedSwarmMember(authority, swarm.directory, swarm.id, name);
    let createdSelection: { input: Json; selection?: Json } | undefined;
    if (!member) {
      createdSelection = await this.sessionCreateInput(spec, swarm.directory);
      const metadata = {
        localMcp: {
          version: 1,
          pluginId: this.init.id,
          connectorName: authority.connectorName,
          swarmMember: true,
          swarmId: swarm.id,
          swarmName: swarm.name,
          memberName: name,
          role,
          creationRequestId: creation,
          initialMessageId,
          createdAt: Date.now(),
          ...(createdSelection.selection ? { modelSelection: createdSelection.selection } : {}),
        },
      };
      const createBody = {
        title: (str(spec.title, 'member.title') ?? `🐝 ${swarm.name} / ${name}`).slice(0, 200),
        metadata,
        permission: this.workerPermissions(authority),
        ...createdSelection.input,
      };
      try {
        const created = await client.request<Json>('/session', {
          method: 'POST',
          query: { directory: swarm.directory.real },
          body: createBody,
          timeoutMs: 10_000,
        });
        const session = record(created.data);
        member = { session, directory: await this.authorizeReturnedDirectory(authority, session.directory) };
      } catch (error) {
        if (error instanceof OpenCodeHttpError || error instanceof OpenCodeIdentityMismatchError) throw error;
        member = await this.reconcileCreatedSwarmMember(authority, swarm.directory, swarm.id, name).catch(() => undefined);
        if (!member) throw new Error(`OpenCode swarm-member creation was ambiguous for ${creation}. Inspect the swarm before retrying.`);
      }
    }

    const sessionID = String(member.session.id);
    const ownershipWarning = await this.addWorkerToGroup(sessionID, creation);
    try {
      await this.addSessionToSwarm(swarm.groupID, sessionID, `${swarm.id}/${name}`);
    } catch (error) {
      return {
        name,
        role,
        sessionId: sessionID,
        state: 'ownership_incomplete',
        warning: `Swarm group membership could not be persisted; no prompt was sent. Retry swarm_start with the same requestId to reconcile. ${error instanceof Error ? error.message : String(error)}`,
        ...(ownershipWarning ? { ownershipWarning } : {}),
      };
    }

    if (ownershipWarning) {
      return {
        name,
        role,
        sessionId: sessionID,
        messageId: initialMessageId,
        state: 'ownership_incomplete',
        warning: `${ownershipWarning} No prompt was sent. Retry swarm_start with the same requestId to reconcile ownership safely.`,
      };
    }

    const memberMeta = this.swarmMeta(member.session);
    const recordedInitial = typeof memberMeta?.initialMessageId === 'string' ? memberMeta.initialMessageId : undefined;
    const initialTurn = recordedInitial
      ? await this.localTurnByMessageID(member, recordedInitial)
      : await this.latestWorkerTurn(member).catch(() => undefined);
    if (initialTurn) {
      const existing = await this.waitTurn(initialTurn, 0);
      return {
        name,
        role,
        sessionId: sessionID,
        state: existing.state === 'running' ? 'running' : 'existing',
        messageId: initialTurn.messageId,
        idempotent: true,
      };
    }

    // A localMCP "swarm" is intentionally only a durable batch handle over
    // independent task-like workers. Do not project peer membership into the
    // model prompt: ChatGPT is the coordinator and each member receives the same
    // delegated-agent system contract plus its own standalone assignment. This
    // mirrors OpenCode's native task tool and keeps the reusable prompt prefix
    // stable across members.
    const turn = await this.promptAsync(member, prompt, spec, authority, true, initialMessageId);
    return {
      name,
      role,
      sessionId: sessionID,
      messageId: turn.messageId,
      state: 'running',
      ...(createdSelection?.selection ? { selection: createdSelection.selection } : {}),
    };
  }

  private async swarmSnapshot(authority: NativeCallAuthority, detail: Json): Promise<Json> {
    const group = record(detail.group);
    const swarmID = this.swarmIDFromOwnerRef(group.ownerRef)!;
    const rows = await this.swarmMemberRows(authority, detail);
    const members = await Promise.all(rows.map(async row => {
      const meta = this.swarmMeta(row.session)!;
      const id = String(row.session.id);
      const status = record(await this.sessionStatus(row.directory, id).catch(() => ({ type: 'unknown' })));
      const turn = await this.latestWorkerTurn({ session: row.session, directory: row.directory }).catch(() => undefined);
      const terminal = turn ? await this.waitTurn(turn, 0) : { state: 'empty' as const };
      const blocked = terminal.state === 'running'
        ? this.blockedWorkerState(await this.pendingForSession(row.directory, id).catch(() => ({ permissions: [], questions: [] })))
        : undefined;
      return {
        name: meta.memberName,
        role: meta.role ?? 'worker',
        sessionId: id,
        model: row.session.model ?? null,
        agent: row.session.agent ?? null,
        status,
        turn: blocked ?? terminal,
      };
    }));
    return {
      swarmId: swarmID,
      name: String(group.name ?? '').replace(/^localMCP swarm · /, ''),
      groupId: group.id,
      members,
      counts: {
        total: members.length,
        running: members.filter(member => record(member.turn).state === 'running').length,
        completed: members.filter(member => record(member.turn).state === 'completed').length,
        blocked: members.filter(member => ['waiting_permission', 'waiting_question'].includes(String(record(member.turn).state))).length,
        errors: members.filter(member => record(member.turn).state === 'error').length,
        empty: members.filter(member => record(member.turn).state === 'empty').length,
      },
    };
  }

  private async cancelOwnedSession(target: AuthorizedSession, wait = 5_000): Promise<Json> {
    const id = String(target.session.id);
    const client = await this.requireReady();
    await client.request(`/session/${encodeURIComponent(id)}/abort`, { method: 'POST', query: { directory: target.directory.real } });
    const pending = await this.pendingForSession(target.directory, id).catch(() => ({ permissions: [], questions: [] }));
    await Promise.all([
      ...pending.permissions.filter(row => typeof row.id === 'string').map(row =>
        client.request(`/permission/${encodeURIComponent(String(row.id))}/reply`, { method: 'POST', query: { directory: target.directory.real }, body: { reply: 'reject' } }).catch(() => undefined)),
      ...pending.questions.filter(row => typeof row.id === 'string').map(row =>
        client.request(`/question/${encodeURIComponent(String(row.id))}/reject`, { method: 'POST', query: { directory: target.directory.real } }).catch(() => undefined)),
    ]);
    const deadline = Date.now() + wait;
    let status = record(await this.sessionStatus(target.directory, id).catch(() => ({ type: 'unknown' })));
    while (status.type !== 'idle' && Date.now() < deadline) {
      await this.waitForEvent(target.directory, Math.min(750, Math.max(25, deadline - Date.now())));
      status = record(await this.sessionStatus(target.directory, id).catch(() => ({ type: 'unknown' })));
    }
    return { sessionId: id, status, state: status.type === 'idle' ? 'idle_after_abort' : 'interrupt_pending' };
  }

  private async worker(args: Record<string, unknown>, authority: NativeCallAuthority): Promise<CallToolResult> {
    const action = str(args.action, 'action', true)!;
    if (action === 'swarm_start') {
      if (!Array.isArray(args.members) || args.members.length < 1 || args.members.length > 8) {
        throw new Error('swarm_start requires members[] with 1-8 member specifications.');
      }
      const specs = args.members.map(record);
      const names = specs.map(spec => str(spec.name, 'member.name', true)!);
      const normalized = names.map(name => name.toLowerCase());
      if (new Set(normalized).size !== normalized.length) throw new Error('Swarm member names must be unique case-insensitively.');
      const directory = await this.approvedDirectory(authority, str(args.workdir, 'workdir', true));
      const creation = requestID(str(args.requestId, 'requestId'));
      const swarmID = `swarm_${creation}`;
      const swarmName = (str(args.swarmName, 'swarmName') ?? `localmcp-${creation.slice(-10)}`).slice(0, 100);
      return this.serialWorkerAdmission(async () => {
        const group = await this.ensureSwarmGroup(swarmID, swarmName);
        const groupID = typeof group.id === 'string' ? group.id : undefined;
        if (!groupID) throw new Error('OpenCode did not return a swarm session-group id.');
        const detail = (await this.sessionGroupDetail(groupID)) ?? record({});
        const existing = await this.swarmMemberRows(authority, detail);
        const existingNames = new Set(existing.map(row => String(this.swarmMeta(row.session)?.memberName ?? '').toLowerCase()));
        const newCount = names.filter(name => !existingNames.has(name.toLowerCase())).length;
        const active = await this.activeWorkerCount(authority);
        const max = this.maxConcurrentWorkers();
        if (active + newCount > max) {
          throw new Error(`Swarm admission would exceed maxConcurrentWorkers=${max} (${active} localMCP sessions currently active, ${newCount} new swarm members requested).`);
        }

        const defaults = {
          providerId: args.providerId,
          modelId: args.modelId,
          variant: args.variant,
          agent: args.agent,
        };
        const settled = await Promise.allSettled(specs.map(spec => this.startSwarmMember({
          ...spec,
          ...(spec.providerId === undefined && defaults.providerId !== undefined ? { providerId: defaults.providerId } : {}),
          ...(spec.modelId === undefined && defaults.modelId !== undefined ? { modelId: defaults.modelId } : {}),
          ...(spec.variant === undefined && defaults.variant !== undefined ? { variant: defaults.variant } : {}),
          ...(spec.agent === undefined && defaults.agent !== undefined ? { agent: defaults.agent } : {}),
        }, { id: swarmID, name: swarmName, groupID, directory }, authority)));
        const members = settled.map((entry, index) => entry.status === 'fulfilled'
          ? entry.value
          : { name: names[index], state: 'failed', error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason) });
        const admittedCount = members.filter(member => ['running', 'existing'].includes(String(member.state))).length;
        const ownershipIncomplete = members.filter(member => member.state === 'ownership_incomplete').length;
        const refreshed = (await this.sessionGroupDetail(groupID)) ?? record({});
        const snapshot = await this.swarmSnapshot(authority, refreshed);
        return result(action, {
          ...snapshot,
          admitted: members,
          admittedCount,
          ownershipIncomplete,
          activeBefore: active,
          maxConcurrentWorkers: max,
          note: 'This localMCP swarm is a durable batch of independent task-like OpenCode workers coordinated by ChatGPT. Members do not communicate with peers or run an autonomous scheduler. OpenSwarm swarm_* execution remains denied for localMCP-created sessions.',
        }, `${admittedCount}/${members.length} localMCP task-like workers admitted${ownershipIncomplete ? `; ${ownershipIncomplete} await ownership reconciliation` : ''}.`);
      });
    }
    if (action === 'swarm_list') {
      const groups = await this.localSwarmGroups();
      const swarms = await Promise.all(groups.slice(0, 50).map(group => this.swarmSnapshot(authority, group)));
      return result(action, { swarms });
    }
    if (action === 'swarm_get' || action === 'swarm_wait' || action === 'swarm_cancel' || action === 'swarm_continue') {
      const swarmID = str(args.swarmId, 'swarmId', true)!;
      let detail = await this.requireSwarmGroup(swarmID);
      if (action === 'swarm_get') return result(action, await this.swarmSnapshot(authority, detail));
      if (action === 'swarm_wait') {
        const wait = integer(args.waitMs, DEFAULT_WAIT_MS, 0, 30_000);
        const deadline = Date.now() + wait;
        for (;;) {
          detail = await this.requireSwarmGroup(swarmID);
          const snapshot = await this.swarmSnapshot(authority, detail);
          const counts = record(snapshot.counts);
          const running = typeof counts.running === 'number' ? counts.running : 0;
          const blocked = typeof counts.blocked === 'number' ? counts.blocked : 0;
          if (running === 0 || blocked > 0 || Date.now() >= deadline || wait === 0) return result(action, snapshot);
          const rows = await this.swarmMemberRows(authority, detail);
          const directory = rows[0]?.directory;
          if (!directory) return result(action, snapshot);
          await this.waitForEvent(directory, Math.min(1_000, Math.max(25, deadline - Date.now())));
        }
      }
      const rows = await this.swarmMemberRows(authority, detail);
      if (action === 'swarm_cancel') {
        const wait = integer(args.waitMs, 5_000, 0, 30_000);
        const settled = await Promise.allSettled(rows.map(row => this.serialSession(
          String(row.session.id),
          () => this.cancelOwnedSession({ session: row.session, directory: row.directory }, wait),
        )));
        const cancelled = settled.map((entry, index) => {
          const row = rows[index]!;
          const meta = this.swarmMeta(row.session);
          return entry.status === 'fulfilled'
            ? { member: meta?.memberName ?? row.session.id, ...entry.value }
            : {
                member: meta?.memberName ?? row.session.id,
                sessionId: row.session.id,
                state: 'cancel_failed',
                error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
              };
        });
        detail = await this.requireSwarmGroup(swarmID);
        return result(action, {
          swarm: await this.swarmSnapshot(authority, detail),
          cancelled,
          failures: cancelled.filter(row => row.state === 'cancel_failed').length,
        });
      }

      const memberRef = str(args.member, 'member') ?? str(args.sessionId, 'sessionId');
      if (!memberRef) throw new Error('swarm_continue requires member or sessionId.');
      const targetRow = rows.find(row => {
        const meta = this.swarmMeta(row.session);
        return row.session.id === memberRef || String(meta?.memberName ?? '').toLowerCase() === memberRef.toLowerCase();
      });
      if (!targetRow) throw new Error(`No approved member "${memberRef}" exists in localMCP swarm ${swarmID}.`);
      const id = String(targetRow.session.id);
      return this.serialSession(id, async () => {
        const fresh = await this.authorizeSession(authority, id);
        const meta = this.swarmMeta(fresh.session);
        if (!meta || meta.swarmId !== swarmID) throw new Error('Swarm membership changed before the continuation could be admitted.');
        const status = record(await this.sessionStatus(fresh.directory, id));
        if (status.type && status.type !== 'idle') throw new Error(`Swarm member ${String(meta.memberName)} is ${String(status.type)}. Wait or cancel before continuing it.`);
        const prior = await this.latestWorkerTurn(fresh);
        if (prior && (await this.waitTurn(prior, 0)).state === 'running') throw new Error(`Swarm member ${String(meta.memberName)} still has an uncompleted localMCP turn.`);
        const turn = await this.promptAsync(fresh, str(args.prompt, 'prompt', true)!, args, authority, true);
        return result(action, { swarmId: swarmID, member: meta.memberName, sessionId: id, messageId: turn.messageId, state: 'accepted' });
      });
    }
    if (action === 'start') {
      const tasks = Array.isArray(args.tasks) ? args.tasks : undefined;
      if (tasks && (args.prompt !== undefined || args.workdir !== undefined)) throw new Error('Use either tasks[] or the single-worker fields, not both.');
      const inputs = tasks ? tasks.map(record) : [args];
      if (inputs.length < 1 || inputs.length > 8) throw new Error('Start accepts 1-8 workers.');
      return this.serialWorkerAdmission(async () => {
        const max = this.maxConcurrentWorkers();
        const active = await this.activeWorkerCount(authority);
        if (active + inputs.length > max) {
          throw new Error(`Worker admission would exceed maxConcurrentWorkers=${max} (${active} currently active, ${inputs.length} requested).`);
        }
        const workers = await Promise.all(inputs.map(task => this.startWorker(task, authority)));
        return result(action, { workers, activeBefore: active, maxConcurrentWorkers: max }, `${workers.length} OpenCode worker${workers.length === 1 ? '' : 's'} admitted.`);
      });
    }
    if (action === 'list') {
      const rows = await this.workerRows(authority, 100);
      const workers = await Promise.all(rows.map(async row => ({
        ...this.compactSession(row.session, row.directory),
        status: await this.sessionStatus(row.directory, String(row.session.id)).catch(() => ({ type: 'unknown' })),
      })));
      return result(action, { workers });
    }
    const id = str(args.sessionId, 'sessionId', true)!;
    const target = await this.requireWorker(authority, id);
    if (action === 'get') {
      return result(action, { worker: this.compactSession(target.session, target.directory), status: await this.sessionStatus(target.directory, id) });
    }
    if (action === 'continue') {
      return this.serialSession(id, async () => {
        const fresh = await this.requireWorker(authority, id);
        const status = record(await this.sessionStatus(fresh.directory, id));
        if (status.type && status.type !== 'idle') throw new Error(`Worker ${id} is ${String(status.type)}. Wait or cancel it before starting another turn.`);
        const prior = await this.latestWorkerTurn(fresh);
        if (prior && (await this.waitTurn(prior, 0)).state === 'running') {
          throw new Error(`Worker ${id} still has an uncompleted localMCP turn. Wait or cancel it before continuing.`);
        }
        const turn = await this.promptAsync(fresh, str(args.prompt, 'prompt', true)!, args, authority, true);
        return result(action, { sessionId: id, messageId: turn.messageId, state: 'accepted' });
      });
    }
    if (action === 'wait' || action === 'result') {
      const turn = await this.latestWorkerTurn(target);
      if (!turn) return result(action, { sessionId: id, state: 'empty', message: null });
      const max = action === 'result' ? 0 : integer(args.waitMs, DEFAULT_WAIT_MS, 0, 30_000);
      const waited = await this.waitTurn(turn, max);
      if (waited.state === 'running') {
        const blocked = this.blockedWorkerState(await this.pendingForSession(target.directory, id));
        if (blocked) return result(action, { sessionId: id, messageId: turn.messageId, ...blocked });
      }
      return result(action, { sessionId: id, messageId: turn.messageId, ...waited });
    }
    if (action === 'cancel') {
      return this.serialSession(id, async () => {
        const fresh = await this.requireWorker(authority, id);
        const client = await this.requireReady();
        await client.request(`/session/${encodeURIComponent(id)}/abort`, { method: 'POST', query: { directory: fresh.directory.real } });
        // A cancelled agent can otherwise remain blocked forever on a pending human request.
        const pending = await this.pendingForSession(fresh.directory, id).catch(() => ({ permissions: [], questions: [] }));
        await Promise.all([
          ...pending.permissions.filter(row => typeof row.id === 'string').map(row =>
            client.request(`/permission/${encodeURIComponent(String(row.id))}/reply`, { method: 'POST', query: { directory: fresh.directory.real }, body: { reply: 'reject' } }).catch(() => undefined)),
          ...pending.questions.filter(row => typeof row.id === 'string').map(row =>
            client.request(`/question/${encodeURIComponent(String(row.id))}/reject`, { method: 'POST', query: { directory: fresh.directory.real } }).catch(() => undefined)),
        ]);

        const deadline = Date.now() + integer(args.waitMs, 5_000, 0, 30_000);
        let status = record(await this.sessionStatus(fresh.directory, id).catch(() => ({ type: 'unknown' })));
        while (status.type !== 'idle' && Date.now() < deadline) {
          await this.waitForEvent(fresh.directory, Math.min(750, Math.max(25, deadline - Date.now())));
          status = record(await this.sessionStatus(fresh.directory, id).catch(() => ({ type: 'unknown' })));
        }
        const turn = await this.latestWorkerTurn(fresh).catch(() => undefined);
        const terminal = turn ? await this.waitTurn(turn, 0) : { state: 'running' as const };
        const after = await this.pendingForSession(fresh.directory, id).catch(() => ({ permissions: [], questions: [] }));
        const encodedError = JSON.stringify(record(terminal.message?.error)).toLowerCase();
        const state = terminal.state === 'error' && encodedError.includes('abort')
          ? 'aborted'
          : status.type === 'idle'
            ? 'idle_after_abort'
            : 'interrupt_pending';
        return result(action, {
          sessionId: id,
          state,
          status,
          terminal: terminal.state,
          ...(terminal.message ? { message: terminal.message } : {}),
          pending: { permissions: after.permissions.length, questions: after.questions.length },
        });
      });
    }
    throw new Error(`Unsupported opencode_worker action: ${action}`);
  }

  private async pendingRequests(authority: NativeCallAuthority): Promise<{ permissions: Json[]; questions: Json[] }> {
    const client = await this.requireReady();
    const permissions: Json[] = [];
    const questions: Json[] = [];
    const seenPermission = new Set<string>();
    const seenQuestion = new Set<string>();
    for (const directory of await this.allRootDirectories(authority)) {
      const [p, q] = await Promise.all([
        client.request<unknown[]>('/permission', { query: { directory: directory.real } }),
        client.request<unknown[]>('/question', { query: { directory: directory.real } }),
      ]);
      for (const raw of array(p.data)) {
        const item = record(raw);
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id || seenPermission.has(id) || typeof item.sessionID !== 'string') continue;
        try {
          await this.authorizeSession(authority, item.sessionID);
          seenPermission.add(id);
          permissions.push(item);
        } catch {}
      }
      for (const raw of array(q.data)) {
        const item = record(raw);
        const id = typeof item.id === 'string' ? item.id : '';
        if (!id || seenQuestion.has(id) || typeof item.sessionID !== 'string') continue;
        try {
          await this.authorizeSession(authority, item.sessionID);
          seenQuestion.add(id);
          questions.push(item);
        } catch {}
      }
    }
    return { permissions, questions };
  }

  private async permissionPathAllowed(authority: NativeCallAuthority, pattern: string): Promise<boolean> {
    const wildcard = pattern.search(/[?*[]/);
    const prefix = (wildcard >= 0 ? pattern.slice(0, wildcard) : pattern).replace(/[\\/]+$/, '');
    if (!prefix) return false;
    try {
      await resolvePath(authority.roots, prefix);
      return true;
    } catch {
      return false;
    }
  }

  private async assertPermissionApprovalSafe(authority: NativeCallAuthority, request: Json, reply: string): Promise<void> {
    if (reply === 'reject') return;
    if (request.permission === 'edit' && !authority.permissions.write) {
      throw new Error('Refusing OpenCode edit approval because localMCP write capability is disabled.');
    }
    if (request.permission === 'bash' && !authority.permissions.shell) {
      throw new Error('Refusing OpenCode shell approval because localMCP shell capability is disabled.');
    }
    if (request.permission === 'task' && !this.boolConfig('allowNestedSubagents', false)) {
      throw new Error('Refusing OpenCode task/subagent approval because nested subagents are disabled for this integration.');
    }
    if (request.permission !== 'external_directory') return;
    const candidates = (reply === 'always' ? array(request.always) : array(request.patterns)).filter((x): x is string => typeof x === 'string');
    if (candidates.length === 0) throw new Error('OpenCode external-directory request did not contain a bounded path and cannot be approved through localMCP.');
    const checks = await Promise.all(candidates.map(pattern => this.permissionPathAllowed(authority, pattern)));
    if (checks.some(ok => !ok)) throw new Error('Refusing OpenCode external-directory approval because at least one requested path is outside localMCP approved roots.');
  }

  private async requests(args: Record<string, unknown>, authority: NativeCallAuthority): Promise<CallToolResult> {
    const action = str(args.action, 'action', true)!;
    const client = await this.requireReady();
    const pending = await this.pendingRequests(authority);
    const filterSession = str(args.sessionId, 'sessionId');
    if (action === 'list') {
      return result(action, {
        permissions: pending.permissions.filter(item => !filterSession || item.sessionID === filterSession).map(item => ({
          id: item.id,
          sessionID: item.sessionID,
          permission: item.permission,
          patterns: item.patterns,
          always: item.always,
          metadata: item.metadata,
        })),
        questions: pending.questions.filter(item => !filterSession || item.sessionID === filterSession),
      });
    }
    const id = str(args.requestId, 'requestId', true)!;
    if (action === 'reply_permission') {
      const request = pending.permissions.find(item => item.id === id);
      if (!request) throw new Error(`Pending OpenCode permission request ${id} was not found in approved roots.`);
      const reply = str(args.reply, 'reply', true)!;
      if (!['once', 'always', 'reject'].includes(reply)) throw new Error('reply must be once, always, or reject.');
      await this.assertPermissionApprovalSafe(authority, request, reply);
      const target = await this.authorizeSession(authority, String(request.sessionID));
      await client.request(`/permission/${encodeURIComponent(id)}/reply`, {
        method: 'POST', query: { directory: target.directory.real }, body: { reply, ...(str(args.message, 'message') ? { message: str(args.message, 'message') } : {}) },
      });
      return result(action, { requestId: id, sessionId: request.sessionID, reply });
    }
    const question = pending.questions.find(item => item.id === id);
    if (!question) throw new Error(`Pending OpenCode question ${id} was not found in approved roots.`);
    const target = await this.authorizeSession(authority, String(question.sessionID));
    if (action === 'reject_question') {
      await client.request(`/question/${encodeURIComponent(id)}/reject`, { method: 'POST', query: { directory: target.directory.real } });
      return result(action, { requestId: id, sessionId: question.sessionID, rejected: true });
    }
    if (action === 'answer_question') {
      if (!Array.isArray(args.answers) || !args.answers.every(answer => Array.isArray(answer) && answer.every(x => typeof x === 'string'))) {
        throw new Error('answers must be an array of string arrays, one array per question.');
      }
      if (args.details !== undefined && (!Array.isArray(args.details) || !args.details.every(x => typeof x === 'string'))) throw new Error('details must be an array of strings.');
      await client.request(`/question/${encodeURIComponent(id)}/reply`, {
        method: 'POST', query: { directory: target.directory.real }, body: { answers: args.answers, ...(args.details === undefined ? {} : { details: args.details }) },
      });
      return result(action, { requestId: id, sessionId: question.sessionID, answered: true });
    }
    throw new Error(`Unsupported opencode_request action: ${action}`);
  }
}
