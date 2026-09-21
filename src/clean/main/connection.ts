import type { ConnectionState, TunnelHealth } from '../../shared/types.js';
import { getOpenAiApiKey } from '../../main/secrets.js';
import { startTunnel, type TunnelHandle, TunnelError } from '../../main/tunnel/index.js';
import { logError, logInfo, logWarn } from '../../main/logger.js';
import { getConfig, onConfigChanged, type LocalMcpConfig } from './state.js';
import { lastRequestAt, lastToolCallAt, startMcpServer, type McpEndpoint } from './mcp.js';
import { toolSurfaceFingerprint } from './tools/registry.js';
import { pluginManager } from '../../main/plugins/manager.js';

export interface LocalConnectionStatus {
  connectorName: string;
  state: ConnectionState;
  detail: string;
  localUrl: string | null;
  publicUrl: string | null;
  handshakeAt: number | null;
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
  health: TunnelHealth | null;
  /** Epoch ms of a scheduled start-up retry, or null when no retry is pending. */
  autoRetryAt: number | null;
}

type PublishedStatus = Omit<LocalConnectionStatus, 'autoRetryAt' | 'connectorName'>;

const EMPTY_STATUS: PublishedStatus = {
  state: 'disconnected',
  detail: 'Disconnected.',
  localUrl: null,
  publicUrl: null,
  handshakeAt: null,
  lastRequestAt: null,
  lastToolCallAt: null,
  health: null
};

let status: PublishedStatus = { ...EMPTY_STATUS };
let endpoint: McpEndpoint | null = null;
let tunnel: TunnelHandle | null = null;
let generation = 0;
let operation: Promise<void> = Promise.resolve();
let observedFingerprint: string | null = null;
let observedConnectorName: string | null = null;
const listeners = new Set<(status: LocalConnectionStatus) => void>();

/**
 * Start-up retry schedule. This exists only to survive a boot that races the network stack — a
 * login item can easily reach connect() before an adapter has an address. Once a tunnel handle
 * exists the client runs its own backoff and reconnects itself, so this loop stops there: two
 * independent recovery loops on one process would fight each other.
 */
const AUTO_RETRY_DELAYS_MS = [4_000, 12_000, 30_000, 60_000, 120_000];
let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;
let autoRetryIndex = 0;
let autoRetryAt: number | null = null;

function notify(): void {
  const snapshot = getConnectionStatus();
  for (const listener of listeners) listener(snapshot);
}

function publish(patch: Partial<PublishedStatus>): void {
  status = {
    ...status,
    ...patch,
    lastRequestAt: lastRequestAt(),
    lastToolCallAt: lastToolCallAt()
  };
  notify();
}

export function getConnectionStatus(): LocalConnectionStatus {
  return {
    connectorName: getConfig().connectorName,
    ...status,
    lastRequestAt: lastRequestAt(),
    lastToolCallAt: lastToolCallAt(),
    autoRetryAt
  };
}

export function onConnectionStatus(listener: (status: LocalConnectionStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function cancelAutoRetry(): void {
  if (autoRetryTimer) clearTimeout(autoRetryTimer);
  autoRetryTimer = null;
  autoRetryIndex = 0;
  if (autoRetryAt !== null) {
    autoRetryAt = null;
    notify();
  }
}

async function disconnectNow(): Promise<void> {
  generation++;
  const oldTunnel = tunnel;
  const oldEndpoint = endpoint;
  tunnel = null;
  endpoint = null;
  observedFingerprint = null;
  observedConnectorName = null;
  if (oldTunnel) await oldTunnel.stop().catch(() => undefined);
  if (oldEndpoint) await oldEndpoint.stop().catch(() => undefined);
  publish({ ...EMPTY_STATUS });
}

export function disconnect(): Promise<void> {
  // An explicit disconnect is a decision, so it also calls off any pending start-up retry.
  cancelAutoRetry();
  operation = operation.then(disconnectNow, disconnectNow);
  return operation;
}

/**
 * The configuration reasons a connect cannot even be attempted. Returned as a message so the
 * manual path and the automatic one report the same thing for the same cause, and so
 * auto-connect can tell "this machine is not set up yet" — never worth retrying — from "the
 * tunnel would not start", which is exactly what the retry schedule is for.
 */
function preflight(config: LocalMcpConfig): string | null {
  const needsRoot = config.permissions.read || config.permissions.write || config.permissions.shell || config.permissions.git;
  if (needsRoot && config.roots.length === 0) return 'Add at least one approved folder before connecting.';
  if (config.tunnel.kind === 'openai' && !/^tunnel_[0-9a-f]{32}$/.test(config.tunnel.tunnelId)) {
    return 'Enter a valid OpenAI Secure MCP Tunnel ID before connecting.';
  }
  return null;
}

async function connectNow(): Promise<void> {
  await disconnectNow();
  const mine = ++generation;
  const config = getConfig();
  const blocked = preflight(config);
  if (blocked) {
    publish({ state: 'disconnected', detail: blocked });
    return;
  }
  try {
    publish({ state: 'starting-server', detail: `Starting ${config.connectorName} MCP server…`, publicUrl: null, health: null });
    const started = await startMcpServer();
    if (mine !== generation) { await started.stop().catch(() => undefined); return; }
    endpoint = started;
    observedFingerprint = started.toolSurfaceFingerprint;
    observedConnectorName = config.connectorName;
    publish({ state: 'connecting-tunnel', detail: 'Local server is ready. Starting tunnel…', localUrl: started.url });
    const apiKey = config.tunnel.kind === 'openai' ? await getOpenAiApiKey() : null;
    if (config.tunnel.kind === 'openai' && !apiKey) throw new TunnelError('Save an OpenAI API key before starting the Secure MCP Tunnel.');
    const startedTunnel = await startTunnel({
      localUrl: started.url,
      settings: config.tunnel,
      apiKey,
      label: config.connectorName,
      report: (report) => {
        if (mine !== generation) return;
        publish({
          state: report.state,
          detail: report.detail,
          ...(report.publicUrl === undefined ? {} : { publicUrl: report.publicUrl }),
          ...(report.handshakeAt === undefined ? {} : { handshakeAt: report.handshakeAt }),
          ...(report.health === undefined ? {} : { health: report.health })
        });
      }
    });
    if (mine !== generation) { await startedTunnel.stop().catch(() => undefined); return; }
    tunnel = startedTunnel;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`connect failed: ${message}`);
    const oldEndpoint = endpoint;
    endpoint = null;
    if (oldEndpoint) await oldEndpoint.stop().catch(() => undefined);
    publish({
      state: error instanceof TunnelError ? 'tunnel-unavailable' : 'disconnected',
      detail: message,
      localUrl: null,
      publicUrl: null
    });
  }
}

async function refreshToolSurfaceNow(): Promise<void> {
  if (!endpoint || !tunnel) return;
  const config = getConfig();
  const next = toolSurfaceFingerprint(getConfig());
  if (next === observedFingerprint && config.connectorName === observedConnectorName) return;
  observedFingerprint = next;
  observedConnectorName = config.connectorName;
  // The modern HTTP SDK creates a short-lived server instance per request, so an unsolicited
  // tools/list_changed notification has no durable session object to target here. ChatGPT can
  // retain tools/list for a connector lifetime, therefore rotate only when the projection changes.
  await connectNow();
}

onConfigChanged(() => {
  // Identity is visible even while disconnected, so publish it without waiting for a reconnect.
  notify();
  operation = operation.then(refreshToolSurfaceNow, refreshToolSurfaceNow);
});

// Plugin lifecycle changes are a second source of model-facing schema changes. The fingerprint
// check inside refreshToolSurfaceNow makes status-only/native-runtime churn a no-op, while a real
// external MCP declaration change rotates the connector exactly once so the tunnel points at a
// server publishing the new projection. ChatGPT may still require its own custom-app Refresh for
// dynamic third-party schemas, but localMCP must never leave the transport on the old projection.
pluginManager.onChanged(() => {
  operation = operation.then(refreshToolSurfaceNow, refreshToolSurfaceNow);
});

export function connect(): Promise<void> {
  cancelAutoRetry();
  operation = operation.then(connectNow, connectNow);
  return operation;
}

/**
 * Whether a failed start-up attempt is worth repeating.
 *
 * A live tunnel handle means the client owns recovery from here — including the offline state,
 * which it re-probes on its own schedule — so there is nothing for this loop to do. A rejected
 * credential will be rejected identically next time and only burns attempts against OpenAI.
 * What is left is the transient case this schedule exists for.
 */
function shouldRetryAutoConnect(): boolean {
  if (tunnel) return false;
  return status.state === 'disconnected' || status.state === 'tunnel-unavailable';
}

function scheduleAutoRetry(): void {
  const delay = AUTO_RETRY_DELAYS_MS[autoRetryIndex];
  if (delay === undefined) {
    logWarn('auto-connect gave up after its last scheduled retry; use Connect to try again');
    cancelAutoRetry();
    return;
  }
  autoRetryIndex++;
  autoRetryAt = Date.now() + delay;
  if (autoRetryTimer) clearTimeout(autoRetryTimer);
  const timer = setTimeout(() => {
    autoRetryTimer = null;
    autoRetryAt = null;
    void attemptAutoConnect();
  }, delay);
  // A pending retry is not a reason to keep the process alive through a quit.
  timer.unref?.();
  autoRetryTimer = timer;
  notify();
}

async function attemptAutoConnect(): Promise<void> {
  const config = getConfig();
  if (!config.preferences.autoConnect) {
    cancelAutoRetry();
    return;
  }
  const blocked = preflight(config);
  if (blocked) {
    // No amount of waiting adds an approved folder or a tunnel ID.
    logWarn(`auto-connect skipped: ${blocked}`);
    cancelAutoRetry();
    publish({ state: 'disconnected', detail: blocked });
    return;
  }
  logInfo(`auto-connect: attempt ${autoRetryIndex + 1}`);
  operation = operation.then(connectNow, connectNow);
  await operation;
  if (!shouldRetryAutoConnect()) {
    cancelAutoRetry();
    return;
  }
  scheduleAutoRetry();
}

/**
 * Startup entry point. Safe to call unconditionally: with the preference off it does nothing,
 * so the caller does not have to repeat the check.
 */
export function beginAutoConnect(): void {
  if (!getConfig().preferences.autoConnect) return;
  cancelAutoRetry();
  void attemptAutoConnect();
}

export async function shutdownConnection(): Promise<void> {
  cancelAutoRetry();
  await disconnect();
}
