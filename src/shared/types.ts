/** Small cross-process type surface used by the clean localMCP-chat runtime. */

export interface SecureStorageInfo {
  available: boolean;
  detail: string | null;
}

/** One user-approved filesystem root. The native path never crosses the MCP boundary. */
export interface Root {
  name: string;
  path: string;
}

export type TunnelKind = 'openai' | 'cloudflared' | 'manual';

/** Transport settings for the single localMCP-chat MCP endpoint. */
export interface TunnelSettings {
  kind: TunnelKind;
  /** OpenAI Secure MCP Tunnel id, format tunnel_<32 hex>. */
  tunnelId: string;
  /** Optional explicit path to tunnel-client or cloudflared. */
  binaryPath: string;
}

export type ConnectionState =
  | 'disconnected'
  | 'starting-server'
  | 'connecting-tunnel'
  | 'connected'
  | 'offline'
  | 'auth-failed'
  | 'tunnel-unavailable';

export interface TunnelHealth {
  pollErrors: number | null;
  uptimeSeconds: number | null;
  route: string | null;
  probe: string | null;
  clientVersion: string | null;
}

export interface LogEntry {
  /**
   * Process-lifetime sequence number, strictly increasing. The control window bootstraps from
   * the whole ring and is also pushed each new line, so the two can overlap; this is what lets
   * it merge them without duplicating or reordering anything. Timestamps cannot: several lines
   * routinely share a millisecond.
   */
  seq: number;
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}
