import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginManager } from '../../main/plugins/manager.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('bundled native plugin tool surface', () => {
  it('pre-publishes fixed OpenCode Control tools before the integration is configured', async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-native-surface-'));
    cleanups.push(() => fs.rm(state, { recursive: true, force: true }));
    const manager = new PluginManager(async () => undefined);
    cleanups.push(() => manager.close());
    await manager.initialize(state);

    expect(manager.tools().map(tool => tool.name)).toEqual(expect.arrayContaining([
      'opencode_info',
      'opencode_session',
      'opencode_worker',
      'opencode_request',
    ]));

    const refused = await manager.call('opencode_info', { action: 'status' }, undefined, {
      roots: [],
      connectorName: 'localMCP-test',
      permissions: { read: true, write: true, shell: true, git: true },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.type === 'text' ? refused.content[0].text : '').toMatch(/not been installed\/configured/i);
  });
});
