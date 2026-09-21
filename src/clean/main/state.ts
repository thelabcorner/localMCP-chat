import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root, TunnelSettings } from '../../shared/types.js';

export interface ToolPermissions {
  read: boolean;
  write: boolean;
  shell: boolean;
  git: boolean;
  plugins: boolean;
  /** FILE_TRANSFER: remote/ChatGPT/OpenAI -> approved local filesystem. */
  filesReceive: boolean;
  /** FILE_TRANSFER: explicit local-data egress to the public OpenAI Files API. */
  filesSend: boolean;
}

/**
 * Desktop behaviour the user controls. These are conveniences, never authority: nothing here
 * widens what a tool may touch. `autoConnect` in particular only replays the same `connect()`
 * the button does, and is still subject to every precondition that path enforces.
 */
export interface Preferences {
  /** Register a per-user login item so the connector is up before ChatGPT asks for it. */
  launchAtLogin: boolean;
  /** Start without showing the control window. Only meaningful with a tray icon present. */
  startHidden: boolean;
  /** Attempt one connect once startup has settled. */
  autoConnect: boolean;
  /** Closing the control window leaves the connector running in the tray instead of quitting. */
  closeToTray: boolean;
}

export interface LocalMcpConfig {
  /** Stable MCP/application identity for this machine, e.g. localMCP-workstation. */
  connectorName: string;
  roots: Root[];
  permissions: ToolPermissions;
  tunnel: TunnelSettings;
  preferences: Preferences;
}

export const DEFAULT_CONNECTOR_NAME = 'localMCP-chat';
export const CONNECTOR_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

export const DEFAULT_CONFIG: LocalMcpConfig = {
  connectorName: DEFAULT_CONNECTOR_NAME,
  roots: [],
  permissions: {
    read: true,
    write: true,
    shell: true,
    git: true,
    plugins: true,
    filesReceive: true,
    filesSend: false
  },
  tunnel: {
    kind: 'openai',
    tunnelId: '',
    binaryPath: ''
  },
  preferences: {
    launchAtLogin: false,
    startHidden: false,
    autoConnect: false,
    closeToTray: false
  }
};

let configPath = '';
let current: LocalMcpConfig = structuredClone(DEFAULT_CONFIG);
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(config: LocalMcpConfig) => void>();

function validRoot(value: unknown): value is Root {
  if (!value || typeof value !== 'object') return false;
  const root = value as Root;
  return typeof root.name === 'string' && /^[a-z0-9._-]{1,32}$/.test(root.name) && typeof root.path === 'string' && path.isAbsolute(root.path);
}

/**
 * Connector names become protocol/server identity and are also copied into deployment docs.
 * Keep them slug-like so they are safe in logs, labels and client namespaces everywhere.
 */
export function validateConnectorName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Connector name must be a string.');
  const trimmed = value.trim();
  if (!CONNECTOR_NAME_PATTERN.test(trimmed)) {
    throw new Error('Connector name must be 1-48 characters, start with a letter or number, and contain only letters, numbers, dot, underscore or hyphen.');
  }
  return trimmed;
}

function loadConnectorName(value: unknown): string {
  try { return validateConnectorName(value); }
  catch { return DEFAULT_CONNECTOR_NAME; }
}

function loadPermissions(value: unknown): ToolPermissions {
  const raw = value && typeof value === 'object' ? value as Partial<ToolPermissions> : {};
  return {
    read: raw.read !== false,
    write: raw.write !== false,
    shell: raw.shell !== false,
    git: raw.git !== false,
    plugins: raw.plugins !== false,
    // FILE_TRANSFER migration policy is intentionally asymmetric: receiving into an already
    // approved writable root is on unless disabled; transmitting local bytes is explicit opt-in.
    filesReceive: raw.filesReceive === undefined ? true : raw.filesReceive === true,
    filesSend: raw.filesSend === true
  };
}

/**
 * Preferences default to off, so a config written by an older build — or a hand-edited one
 * with the key missing — never silently opts a machine into launching at login.
 */
function loadPreferences(value: unknown): Preferences {
  const raw = value && typeof value === 'object' ? value as Partial<Preferences> : {};
  return {
    launchAtLogin: raw.launchAtLogin === true,
    startHidden: raw.startHidden === true,
    autoConnect: raw.autoConnect === true,
    closeToTray: raw.closeToTray === true
  };
}

function loadTunnel(value: unknown): TunnelSettings {
  const raw = value && typeof value === 'object' ? value as Partial<TunnelSettings> : {};
  const kind = raw.kind === 'cloudflared' || raw.kind === 'manual' || raw.kind === 'openai' ? raw.kind : 'openai';
  return {
    kind,
    tunnelId: typeof raw.tunnelId === 'string' ? raw.tunnelId : '',
    binaryPath: typeof raw.binaryPath === 'string' ? raw.binaryPath : ''
  };
}

function parseConfig(value: unknown): LocalMcpConfig {
  const raw = value && typeof value === 'object' ? value as Partial<LocalMcpConfig> : {};
  // Root count is not an authority boundary. Silently dropping the 33rd valid root made a
  // persisted configuration lose capabilities merely because it crossed an arbitrary count.
  // The config file itself is already bounded by normal filesystem/JSON constraints, and every
  // operation still re-validates containment against the selected root.
  const roots = Array.isArray(raw.roots) ? raw.roots.filter(validRoot) : [];
  return {
    connectorName: loadConnectorName(raw.connectorName),
    roots,
    permissions: loadPermissions(raw.permissions),
    tunnel: loadTunnel(raw.tunnel),
    preferences: loadPreferences(raw.preferences)
  };
}

export async function initConfig(userDataDir: string): Promise<LocalMcpConfig> {
  configPath = path.join(userDataDir, 'localmcp-chat.json');
  try {
    current = parseConfig(JSON.parse(await fs.readFile(configPath, 'utf8')));
  } catch {
    // The file on disk is the only source of this config, so anything that stops it being read
    // — missing, unreadable or malformed — yields the defaults. Leaving whatever was already in
    // memory would let a previous load leak into one that found no file.
    current = structuredClone(DEFAULT_CONFIG);
  }
  return getConfig();
}

export function getConfig(): LocalMcpConfig {
  return structuredClone(current);
}

export function onConfigChanged(listener: (config: LocalMcpConfig) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function saveConfig(next: LocalMcpConfig): Promise<LocalMcpConfig> {
  const normalized = parseConfig(next);
  current = normalized;
  const snapshot = getConfig();
  writeQueue = writeQueue.then(async () => {
    if (!configPath) return;
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const temp = `${configPath}.tmp`;
    await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.rename(temp, configPath);
  });
  await writeQueue;
  for (const listener of listeners) listener(getConfig());
  return getConfig();
}

export async function updateConfig(mutator: (draft: LocalMcpConfig) => void): Promise<LocalMcpConfig> {
  const draft = getConfig();
  mutator(draft);
  return saveConfig(draft);
}
