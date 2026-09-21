import type { Tool, CallToolResult } from '@modelcontextprotocol/client';
import type { Root } from '../../shared/types.js';
import { OpenCodeControlBackend, OPENCODE_CONTROL_TOOLS } from '../integrations/opencode/backend.js';

export type NativePluginId = 'opencode-control';

export interface NativeCallAuthority {
  roots: readonly Root[];
  connectorName: string;
  permissions: {
    read: boolean;
    write: boolean;
    shell: boolean;
    git: boolean;
  };
}

export interface NativePluginInit {
  id: string;
  name: string;
  config: Record<string, string>;
  credentials: Record<string, string>;
}

export interface NativeStartResult {
  credentialUpdates?: Record<string, string>;
  needsAuth?: string;
}

export interface NativeRuntimeStatus {
  state: 'ready' | 'needs-auth' | 'error';
  detail?: string;
}

export interface NativePluginBackend {
  readonly tools: readonly Tool[];
  start(): Promise<NativeStartResult | void>;
  call(name: string, args: Record<string, unknown>, authority: NativeCallAuthority): Promise<CallToolResult>;
  runtimeStatus(): NativeRuntimeStatus;
  /** Explicit installation removal only. Disable/restart/update must never call this. */
  uninstall?(): Promise<string[]>;
  close(): Promise<void>;
}

export function isNativePluginId(value: unknown): value is NativePluginId {
  return value === 'opencode-control';
}

export function nativePluginTools(id: NativePluginId): readonly Tool[] {
  if (id === 'opencode-control') return OPENCODE_CONTROL_TOOLS;
  return [];
}

export function createNativePluginBackend(id: NativePluginId, init: NativePluginInit): NativePluginBackend {
  if (id === 'opencode-control') return new OpenCodeControlBackend(init);
  throw new Error(`Unknown native integration: ${String(id)}`);
}
