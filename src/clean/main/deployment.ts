/**
 * Declarative, agent-friendly machine deployment.
 *
 * The deployment file contains configuration only. Credentials are deliberately excluded: a
 * desktop can keep using Electron safeStorage, while unattended machines inject the OpenAI key
 * at runtime with LOCALMCP_OPENAI_API_KEY[_FILE].
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { RESERVED_ROOT_NAMES, validateNewRoot } from '../../main/sandbox.js';
import type { Root } from '../../shared/types.js';
import {
  DEFAULT_CONFIG,
  saveConfig,
  validateConnectorName,
  type LocalMcpConfig,
  type Preferences,
  type ToolPermissions
} from './state.js';

export const DEPLOYMENT_VERSION = 1;
export const APPLY_DEPLOYMENT_FLAG = '--apply-deployment';
export const HEADLESS_FLAG = '--headless';
export const STORE_OPENAI_KEY_FLAG = '--store-openai-key-from-env';
const MAX_DEPLOYMENT_BYTES = 1024 * 1024;
const ROOT_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const TUNNEL_ID = /^tunnel_[0-9a-f]{32}$/;

export interface DeploymentSpecV1 {
  version: 1;
  connectorName: string;
  roots: Array<{ name: string; path: string }>;
  permissions?: Partial<ToolPermissions>;
  tunnel: { kind?: 'openai' | 'cloudflared' | 'manual'; tunnelId?: string; binaryPath?: string };
  preferences?: Partial<Preferences>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allow.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown ${unknown.length === 1 ? 'field' : 'fields'}: ${unknown.join(', ')}.`);
}

function boolPatch<T extends object>(value: unknown, keys: readonly (keyof T)[], label: string): Partial<T> {
  if (value === undefined) return {};
  const raw = object(value, label);
  knownKeys(raw, keys.map(String), label);
  const out: Partial<T> = {};
  for (const key of keys) {
    const entry = raw[String(key)];
    if (entry === undefined) continue;
    if (typeof entry !== 'boolean') throw new Error(`${label}.${String(key)} must be true or false.`);
    out[key] = entry as T[keyof T];
  }
  return out;
}

export function deploymentPathFromArgv(argv: readonly string[]): string | null {
  const direct = argv.find((arg) => arg.startsWith(`${APPLY_DEPLOYMENT_FLAG}=`));
  if (direct) return direct.slice(APPLY_DEPLOYMENT_FLAG.length + 1).trim() || null;
  const at = argv.indexOf(APPLY_DEPLOYMENT_FLAG);
  return at >= 0 ? argv[at + 1]?.trim() || null : null;
}

export function launchedHeadless(argv: readonly string[]): boolean {
  return argv.includes(HEADLESS_FLAG);
}

export function shouldStoreOpenAiKeyFromEnv(argv: readonly string[]): boolean {
  return argv.includes(STORE_OPENAI_KEY_FLAG);
}

export async function readDeploymentFile(filePath: string): Promise<DeploymentSpecV1> {
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error(`Deployment path is not a file: ${absolute}`);
  if (stat.size <= 0 || stat.size > MAX_DEPLOYMENT_BYTES) throw new Error(`Deployment file must be 1-${MAX_DEPLOYMENT_BYTES} bytes.`);
  const text = await fs.readFile(absolute, 'utf8');
  let parsed: unknown;
  try {
    parsed = /\.json$/i.test(absolute) ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new Error(`Could not parse deployment file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const raw = object(parsed, 'Deployment');
  knownKeys(raw, ['version', 'connectorName', 'roots', 'permissions', 'tunnel', 'preferences'], 'Deployment');
  if (raw.version !== DEPLOYMENT_VERSION) throw new Error(`Deployment version must be ${DEPLOYMENT_VERSION}.`);
  if (!Array.isArray(raw.roots)) throw new Error('Deployment.roots must be an array.');
  const tunnel = object(raw.tunnel, 'Deployment.tunnel');
  knownKeys(tunnel, ['kind', 'tunnelId', 'binaryPath'], 'Deployment.tunnel');
  return {
    version: 1,
    connectorName: validateConnectorName(raw.connectorName),
    roots: raw.roots.map((entry, index) => {
      const root = object(entry, `Deployment.roots[${index}]`);
      knownKeys(root, ['name', 'path'], `Deployment.roots[${index}]`);
      if (typeof root.name !== 'string' || !ROOT_NAME.test(root.name) || RESERVED_ROOT_NAMES.has(root.name)) {
        throw new Error(`Deployment.roots[${index}].name must be a non-reserved lowercase root slug (1-32 characters).`);
      }
      if (typeof root.path !== 'string' || !path.isAbsolute(root.path)) throw new Error(`Deployment.roots[${index}].path must be absolute.`);
      return { name: root.name, path: root.path };
    }),
    // FILE_TRANSFER permissions stay part of the ordinary declarative authority boundary.
    permissions: boolPatch<ToolPermissions>(raw.permissions, ['read', 'write', 'shell', 'git', 'plugins', 'filesReceive', 'filesSend'], 'Deployment.permissions'),
    tunnel: {
      kind: tunnel.kind === undefined ? 'openai' : tunnel.kind as DeploymentSpecV1['tunnel']['kind'],
      tunnelId: tunnel.tunnelId === undefined
        ? ''
        : typeof tunnel.tunnelId === 'string'
          ? tunnel.tunnelId.trim()
          : (() => { throw new Error('Deployment.tunnel.tunnelId must be a string.'); })(),
      binaryPath: tunnel.binaryPath === undefined
        ? ''
        : typeof tunnel.binaryPath === 'string'
          ? tunnel.binaryPath.trim()
          : (() => { throw new Error('Deployment.tunnel.binaryPath must be a string.'); })()
    },
    preferences: boolPatch<Preferences>(raw.preferences, ['launchAtLogin', 'startHidden', 'autoConnect', 'closeToTray'], 'Deployment.preferences')
  };
}

export async function deploymentConfig(spec: DeploymentSpecV1): Promise<LocalMcpConfig> {
  const kind = spec.tunnel.kind ?? 'openai';
  if (kind !== 'openai' && kind !== 'cloudflared' && kind !== 'manual') throw new Error(`Unsupported tunnel kind: ${String(kind)}`);
  if (kind === 'openai' && !TUNNEL_ID.test(spec.tunnel.tunnelId ?? '')) {
    throw new Error('OpenAI deployments require tunnelId in tunnel_<32 lowercase hex> format. Each machine should use its own tunnel ID.');
  }
  if (spec.tunnel.binaryPath && !path.isAbsolute(spec.tunnel.binaryPath)) {
    throw new Error('Deployment.tunnel.binaryPath must be absolute when provided.');
  }

  const roots: Root[] = [];
  const names = new Set<string>();
  for (const requested of spec.roots) {
    if (names.has(requested.name)) throw new Error(`Duplicate deployment root name: ${requested.name}`);
    names.add(requested.name);
    const canonical = await validateNewRoot(requested.path, roots);
    roots.push({ name: requested.name, path: canonical });
  }

  const permissions = { ...DEFAULT_CONFIG.permissions, ...spec.permissions };
  const needsRoot = permissions.read || permissions.write || permissions.shell || permissions.git;
  if (needsRoot && roots.length === 0) throw new Error('At least one root is required while read/write/shell/git capability is enabled.');

  return {
    connectorName: validateConnectorName(spec.connectorName),
    roots,
    permissions,
    tunnel: {
      kind,
      tunnelId: spec.tunnel.tunnelId ?? '',
      binaryPath: spec.tunnel.binaryPath ?? ''
    },
    preferences: { ...DEFAULT_CONFIG.preferences, ...spec.preferences }
  };
}

export async function applyDeploymentFile(filePath: string): Promise<LocalMcpConfig> {
  const spec = await readDeploymentFile(filePath);
  const config = await deploymentConfig(spec);
  return saveConfig(config);
}
