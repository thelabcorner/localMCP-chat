import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyDeploymentFile,
  deploymentConfig,
  deploymentPathFromArgv,
  launchedHeadless,
  readDeploymentFile,
  shouldStoreOpenAiKeyFromEnv
} from './deployment.js';
import { getConfig, initConfig } from './state.js';

let base = '';
let state = '';
let root = '';

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-deploy-'));
  state = path.join(base, 'state');
  root = path.join(base, 'repo');
  await fs.mkdir(root, { recursive: true });
  await initConfig(state);
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

describe('deployment argv', () => {
  it('supports separate and equals deployment args plus headless/key flags', () => {
    expect(deploymentPathFromArgv(['app', '--apply-deployment', 'C:\\setup\\home.yaml'])).toBe('C:\\setup\\home.yaml');
    expect(deploymentPathFromArgv(['app', '--apply-deployment=/tmp/home.yaml'])).toBe('/tmp/home.yaml');
    expect(deploymentPathFromArgv(['app'])).toBeNull();
    expect(launchedHeadless(['app', '--headless'])).toBe(true);
    expect(shouldStoreOpenAiKeyFromEnv(['app', '--store-openai-key-from-env'])).toBe(true);
  });
});

describe('deployment files', () => {
  it('parses YAML and builds a canonical machine config', async () => {
    const file = path.join(base, 'homelab.yaml');
    await fs.writeFile(file, [
      'version: 1',
      'connectorName: localMCP-homelab',
      'roots:',
      '  - name: projects',
      `    path: ${JSON.stringify(root)}`,
      'permissions:',
      '  read: true',
      '  write: false',
      '  shell: true',
      '  git: true',
      '  plugins: false',
      'tunnel:',
      '  kind: manual',
      'preferences:',
      '  launchAtLogin: true',
      '  startHidden: true',
      '  autoConnect: true',
      '  closeToTray: true',
      ''
    ].join('\n'));

    const spec = await readDeploymentFile(file);
    const config = await deploymentConfig(spec);
    expect(config.connectorName).toBe('localMCP-homelab');
    expect(config.roots).toEqual([{ name: 'projects', path: await fs.realpath(root) }]);
    expect(config.permissions).toEqual({
      read: true,
      write: false,
      shell: true,
      git: true,
      plugins: false,
      filesReceive: true,
      filesSend: false,
    });
    expect(config.preferences).toEqual({ launchAtLogin: true, startHidden: true, autoConnect: true, closeToTray: true });
  });

  it('persists JSON through the ordinary config writer', async () => {
    const file = path.join(base, 'homelab.json');
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      connectorName: 'localMCP-homelab',
      roots: [{ name: 'projects', path: root }],
      permissions: { plugins: false },
      tunnel: { kind: 'manual' },
      preferences: { autoConnect: true }
    }), 'utf8');
    await applyDeploymentFile(file);
    expect(getConfig().connectorName).toBe('localMCP-homelab');
    expect(getConfig().roots[0]?.path).toBe(await fs.realpath(root));
    expect(getConfig().permissions.plugins).toBe(false);
    expect(getConfig().preferences.autoConnect).toBe(true);
  });

  it('rejects duplicate roots, reserved names, unsafe names and malformed tunnel ids', async () => {
    const sibling = path.join(base, 'repo-2');
    await fs.mkdir(sibling);
    await expect(deploymentConfig({
      version: 1,
      connectorName: 'localMCP-homelab',
      roots: [{ name: 'projects', path: root }, { name: 'projects', path: sibling }],
      tunnel: { kind: 'manual' }
    })).rejects.toThrow(/duplicate/i);

    const reserved = path.join(base, 'reserved.yaml');
    await fs.writeFile(reserved, `version: 1\nconnectorName: localMCP-homelab\nroots:\n  - name: skills\n    path: ${JSON.stringify(root)}\ntunnel:\n  kind: manual\n`);
    await expect(readDeploymentFile(reserved)).rejects.toThrow(/non-reserved/i);

    const dotRoot = path.join(base, 'dot-root.yaml');
    await fs.writeFile(dotRoot, `version: 1\nconnectorName: localMCP-homelab\nroots:\n  - name: .\n    path: ${JSON.stringify(root)}\ntunnel:\n  kind: manual\n`);
    await expect(readDeploymentFile(dotRoot)).rejects.toThrow(/root slug/i);

    await expect(deploymentConfig({
      version: 1,
      connectorName: 'localMCP-homelab',
      roots: [{ name: 'projects', path: root }],
      tunnel: { kind: 'openai', tunnelId: 'tunnel_not-valid' }
    })).rejects.toThrow(/32 lowercase hex/i);

    await expect(deploymentConfig({
      version: 1,
      connectorName: 'localMCP-homelab',
      roots: [{ name: 'projects', path: root }],
      tunnel: { kind: 'manual', binaryPath: 'relative\\tunnel.exe' }
    })).rejects.toThrow(/binaryPath must be absolute/i);

    const typo = path.join(base, 'typo.yaml');
    await fs.writeFile(typo, `version: 1\nconnectorName: localMCP-homelab\nroots:\n  - name: projects\n    path: ${JSON.stringify(root)}\npermissions:\n  shelll: true\ntunnel:\n  kind: manual\n`);
    await expect(readDeploymentFile(typo)).rejects.toThrow(/unknown field.*shelll/i);
  });
});
