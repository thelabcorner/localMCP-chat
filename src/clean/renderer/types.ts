/**
 * The renderer's view of the control channel.
 *
 * These mirror what `src/clean/main/ipc.ts` sends. They are declared here rather than imported
 * because the renderer is bundled separately and must not pull main-process modules — and their
 * transitive Node imports — into the window.
 */

export type ConnectionState =
  | 'disconnected'
  | 'starting-server'
  | 'connecting-tunnel'
  | 'connected'
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable';

// FILE_TRANSFER capabilities are separate from generic read/write because filesSend is network egress.
export type PermissionKey = 'read' | 'write' | 'shell' | 'git' | 'plugins' | 'filesReceive' | 'filesSend';
export type PreferenceKey = 'launchAtLogin' | 'startHidden' | 'autoConnect' | 'closeToTray';

export interface Root { name: string; path: string }

export interface LogEntry {
  seq: number;
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface PluginTool {
  name: string;
  exposedName: string;
  description?: string;
  enabled: boolean;
  published?: boolean;
  exposureError?: string;
}

export interface Plugin {
  id: string;
  name: string;
  status: 'installed' | 'connecting' | 'ready' | 'disabled' | 'error' | 'needs-auth' | 'authenticating';
  enabled: boolean;
  version: string;
  license: string;
  homepage?: string;
  error?: string;
  tools: PluginTool[];
  catalogId?: string;
  config: Record<string, string>;
  credentialKeys: string[];
  fields?: Array<{
    key: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    placeholder?: string;
    control?: 'text' | 'boolean' | 'number';
    defaultValue?: string;
    min?: number;
    max?: number;
  }>;
  source: { kind: string; package?: string; url?: string; command?: string; path?: string; auth?: string; nativeId?: string };
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  license: string;
  homepage: string;
  fields?: Array<{
    key: string;
    label: string;
    secret?: boolean;
    required?: boolean;
    placeholder?: string;
    control?: 'text' | 'boolean' | 'number';
    defaultValue?: string;
    min?: number;
    max?: number;
  }>;
  tools?: string[];
  instructions?: string[];
}

export interface ToolRow {
  name: string;
  description: string;
  /** Called during this run but no longer part of the published surface. */
  withdrawn: boolean;
  calls: number;
  failures: number;
  lastAt: number | null;
  avgMs: number | null;
  lastError: string | null;
}

export interface ToolStat {
  name: string;
  calls: number;
  failures: number;
  lastAt: number | null;
  lastDurationMs: number | null;
  totalDurationMs: number;
  lastError: string | null;
}

export interface McpMetrics {
  since: number;
  requests: number;
  requestErrors: number;
  calls: number;
  failures: number;
  unknownTools: number;
  totalDurationMs: number;
  slowestMs: number;
  slowestTool: string | null;
  tools: ToolStat[];
}

export interface ControlState {
  config: {
    connectorName: string;
    roots: Root[];
    permissions: Record<PermissionKey, boolean>;
    tunnel: { kind: 'openai' | 'cloudflared' | 'manual'; tunnelId: string; binaryPath: string };
    preferences: Record<PreferenceKey, boolean>;
  };
  connection: {
    connectorName: string;
    state: ConnectionState;
    detail: string;
    localUrl: string | null;
    publicUrl: string | null;
    handshakeAt: number | null;
    lastRequestAt: number | null;
    lastToolCallAt: number | null;
    autoRetryAt: number | null;
  };
  plugins: { plugins: Plugin[]; catalog: CatalogEntry[]; schemaRevision: number };
  tools: ToolRow[];
  metrics: McpMetrics;
  hasApiKey: boolean;
  secureStorage: { available: boolean; detail: string | null };
  autostart: { supported: boolean; enabled: boolean; detail: string | null };
  runtime: { platform: string; tray: boolean; titleBarOverlay: boolean; logFile: string | null };
}

export interface LocalApi {
  getState(): Promise<ControlState>;
  getLog(): Promise<LogEntry[]>;
  setConnectorName(value: string): Promise<ControlState>;

  addRoot(): Promise<ControlState>;
  removeRoot(name: string): Promise<ControlState>;
  revealRoot(name: string): Promise<ControlState>;
  setPermissions(patch: Partial<Record<PermissionKey, boolean>>): Promise<ControlState>;
  setTunnel(patch: { kind?: string; tunnelId?: string; binaryPath?: string }): Promise<ControlState>;
  setPreferences(patch: Partial<Record<PreferenceKey, boolean>>): Promise<ControlState>;
  setApiKey(value: string): Promise<ControlState>;
  connect(): Promise<ControlState>;
  disconnect(): Promise<ControlState>;

  clearLog(): Promise<LogEntry[]>;
  copyLog(): Promise<void>;
  exportLog(): Promise<string | null>;
  openLogFile(): Promise<boolean>;
  revealLogFile(): Promise<boolean>;
  openExternal(url: string): Promise<boolean>;
  resetMetrics(): Promise<ControlState>;

  installPlugin(request: unknown): Promise<ControlState>;
  configurePlugin(id: string, patch: unknown): Promise<ControlState>;
  setPluginEnabled(id: string, enabled: boolean): Promise<ControlState>;
  setPluginToolEnabled(id: string, name: string, enabled: boolean): Promise<ControlState>;
  uninstallPlugin(id: string): Promise<ControlState>;
  authenticatePlugin(id: string): Promise<ControlState>;
  cancelPluginAuth(id: string): Promise<ControlState>;
  restartPlugin(id: string): Promise<ControlState>;

  onState(listener: (state: ControlState) => void): () => void;
  onLogEntries(listener: (entries: LogEntry[]) => void): () => void;
}
