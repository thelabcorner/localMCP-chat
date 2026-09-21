import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  safeStorage: {
    isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => { throw new Error('unexpected'); },
    decryptStringAsync: async () => { throw new Error('unexpected'); }
  }
}));

const { getOpenAiApiKey } = await import('../../main/secrets.js');
const { childEnv } = await import('../../main/exec.js');
const originalDirect = process.env['LOCALMCP_OPENAI_API_KEY'];
const originalFile = process.env['LOCALMCP_OPENAI_API_KEY_FILE'];

afterEach(() => {
  if (originalDirect === undefined) delete process.env['LOCALMCP_OPENAI_API_KEY'];
  else process.env['LOCALMCP_OPENAI_API_KEY'] = originalDirect;
  if (originalFile === undefined) delete process.env['LOCALMCP_OPENAI_API_KEY_FILE'];
  else process.env['LOCALMCP_OPENAI_API_KEY_FILE'] = originalFile;
});

describe('runtime OpenAI credential source', () => {
  it('uses the process-only value without requiring safeStorage', async () => {
    delete process.env['LOCALMCP_OPENAI_API_KEY_FILE'];
    process.env['LOCALMCP_OPENAI_API_KEY'] = 'sk-runtime-only-test';
    await expect(getOpenAiApiKey()).resolves.toBe('sk-runtime-only-test');
  });

  it('reads an absolute protected credential file when no direct value is set', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-runtime-secret-'));
    const file = path.join(directory, 'openai.key');
    try {
      await fs.writeFile(file, 'sk-file-test\n', { mode: 0o600 });
      delete process.env['LOCALMCP_OPENAI_API_KEY'];
      process.env['LOCALMCP_OPENAI_API_KEY_FILE'] = file;
      await expect(getOpenAiApiKey()).resolves.toBe('sk-file-test');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a relative credential-file path', async () => {
    delete process.env['LOCALMCP_OPENAI_API_KEY'];
    process.env['LOCALMCP_OPENAI_API_KEY_FILE'] = 'relative.key';
    await expect(getOpenAiApiKey()).rejects.toThrow(/absolute path/i);
  });

  it('never inherits runtime connector secrets into model-launched child environments', () => {
    process.env['LOCALMCP_OPENAI_API_KEY'] = 'sk-must-not-leak';
    process.env['LOCALMCP_OPENAI_API_KEY_FILE'] = path.join(os.tmpdir(), 'must-not-leak.key');
    const env = childEnv();
    const names = Object.keys(env).map((key) => key.toUpperCase());
    expect(names).not.toContain('LOCALMCP_OPENAI_API_KEY');
    expect(names).not.toContain('LOCALMCP_OPENAI_API_KEY_FILE');
  });
});
