import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, getConfig, initConfig, updateConfig, validateConnectorName } from './state.js';

let directory = '';

async function writeConfig(value: unknown): Promise<void> {
  await fs.writeFile(path.join(directory, 'localmcp-chat.json'), JSON.stringify(value), 'utf8');
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-state-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('preferences', () => {
  it('defaults every preference off when the key is missing', async () => {
    // A config written by an older build must never opt a machine into launching at login.
    await writeConfig({ roots: [], permissions: {}, tunnel: { kind: 'openai' } });
    const config = await initConfig(directory);
    expect(config.preferences).toEqual({ launchAtLogin: false, startHidden: false, autoConnect: false, closeToTray: false });
  });

  it('defaults off for a config with no preferences object at all', async () => {
    await initConfig(directory);
    expect(getConfig().preferences).toEqual(DEFAULT_CONFIG.preferences);
  });

  it('only accepts a literal true, unlike permissions which are opt-out', async () => {
    await writeConfig({
      preferences: { launchAtLogin: 'yes', startHidden: 1, autoConnect: true, closeToTray: null }
    });
    const config = await initConfig(directory);
    expect(config.preferences).toEqual({ launchAtLogin: false, startHidden: false, autoConnect: true, closeToTray: false });
  });

  it('round-trips through a save and a reload', async () => {
    await initConfig(directory);
    await updateConfig((draft) => { draft.preferences.launchAtLogin = true; draft.preferences.closeToTray = true; });
    const reloaded = await initConfig(directory);
    expect(reloaded.preferences).toEqual({ launchAtLogin: true, startHidden: false, autoConnect: false, closeToTray: true });
  });

  it('survives a corrupt config file by falling back to the defaults', async () => {
    await fs.writeFile(path.join(directory, 'localmcp-chat.json'), '{ not json', 'utf8');
    const config = await initConfig(directory);
    expect(config.preferences).toEqual(DEFAULT_CONFIG.preferences);
    expect(config.roots).toEqual([]);
  });

  it('keeps legacy permissions opt-out while preferences and file egress stay opt-in', async () => {
    await writeConfig({ permissions: { shell: false }, preferences: {} });
    const config = await initConfig(directory);
    expect(config.permissions).toEqual({
      read: true,
      write: true,
      shell: false,
      git: true,
      plugins: true,
      filesReceive: true,
      filesSend: false,
    });
    expect(config.preferences.autoConnect).toBe(false);
  });

  it('migrates file transfer with receive enabled but remote egress opt-in', async () => {
    await writeConfig({ permissions: {} });
    const config = await initConfig(directory);
    expect(config.permissions.filesReceive).toBe(true);
    expect(config.permissions.filesSend).toBe(false);
  });

  it('fails closed for malformed file-transfer permission values', async () => {
    await writeConfig({ permissions: { filesReceive: 'yes', filesSend: 1 } });
    const config = await initConfig(directory);
    expect(config.permissions.filesReceive).toBe(false);
    expect(config.permissions.filesSend).toBe(false);
  });
});

describe('connector identity', () => {
  it('migrates an older config to the default connector name', async () => {
    await writeConfig({ roots: [], permissions: {}, tunnel: { kind: 'manual' }, preferences: {} });
    const config = await initConfig(directory);
    expect(config.connectorName).toBe('localMCP-chat');
  });

  it('round-trips a distinct machine identity', async () => {
    await initConfig(directory);
    await updateConfig((draft) => { draft.connectorName = 'localMCP-homelab'; });
    expect((await initConfig(directory)).connectorName).toBe('localMCP-homelab');
  });

  it('validates connector names before they enter config', () => {
    expect(validateConnectorName('localMCP-workstation')).toBe('localMCP-workstation');
    expect(() => validateConnectorName('bad name')).toThrow(/letters, numbers/i);
    expect(() => validateConnectorName('../escape')).toThrow(/letters, numbers/i);
    expect(() => validateConnectorName('')).toThrow(/1-48/);
  });
});

describe('resource-count hardening', () => {
  it('preserves every valid approved root instead of silently keeping only the first 32', async () => {
    const roots = Array.from({ length: 64 }, (_, index) => ({
      name: `root-${index}`,
      path: path.resolve(directory, `root-${index}`),
    }));
    await writeConfig({ roots });
    const config = await initConfig(directory);
    expect(config.roots).toHaveLength(64);
    expect(config.roots.at(-1)?.name).toBe('root-63');
  });
});
