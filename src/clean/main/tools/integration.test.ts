import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginManager } from '../../../main/plugins/manager.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('stable integration gateway support', () => {
  it('keeps bundled native declarations stable without exposing dynamic installation state', async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-integration-surface-'));
    cleanups.push(() => fs.rm(state, { recursive: true, force: true }));
    const manager = new PluginManager(async () => undefined);
    cleanups.push(() => manager.close());
    await manager.initialize(state);

    expect(manager.stableTools().map(tool => tool.name).sort()).toEqual([
      'opencode_info', 'opencode_request', 'opencode_session', 'opencode_worker',
    ]);
    expect(manager.integrationList()).toEqual([]);
  });
});
