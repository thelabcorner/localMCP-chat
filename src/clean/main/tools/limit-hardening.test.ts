import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Tool } from '@modelcontextprotocol/client';
import type { Root } from '../../../shared/types.js';
import { pluginExposure } from '../../../main/plugins/exposure.js';
import { clearLog, getLog, logInfo } from '../../../main/logger.js';
import { uniqueRootName } from '../../../main/sandbox.js';
import { readTool } from './read.js';
import { findTool } from './read.js';
import { editTool } from './edit.js';
import { execTool, unifiedExecManager } from './exec.js';
import { archiveTool } from './archive.js';
import { ZipFile } from './archive/zipfile.js';
import { backgroundJobs } from './background.js';
import { symbolsTool } from './symbols.js';

let dir = '';
let roots: Root[] = [];

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent as Record<string, unknown>
    : {};
}

function text(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text ?? '' : '';
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-limits-'));
  roots = [{ name: 'project', path: await fs.realpath(dir) }];
});

afterEach(async () => {
  await unifiedExecManager.terminateAllProcesses();
  await backgroundJobs.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('count-limit hardening', () => {
  it('allocates root slugs beyond the old 999-collision naming ceiling', () => {
    const existing: Root[] = Array.from({ length: 1200 }, (_, index) => ({
      name: index === 0 ? 'folder' : `folder-${index + 1}`,
      path: path.join(dir, `root-${index}`),
    }));
    expect(uniqueRootName(path.join(dir, 'folder'), existing)).toBe('folder-1201');
  });

  it('keeps more than 500 small log entries when they fit the byte budget', () => {
    clearLog();
    for (let index = 0; index < 700; index++) logInfo(`small-log-${index}`);
    const rows = getLog();
    expect(rows).toHaveLength(700);
    expect(rows.at(-1)?.message).toBe('small-log-699');
    clearLog();
  });

  it('accepts more than the old 8-file read batch and streams files beyond the old 16 MiB read ceiling', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 12; i++) {
      const name = `small-${i}.txt`;
      await fs.writeFile(path.join(dir, name), `small-${i}\n`);
      paths.push(`/project/${name}`);
    }
    const batch = await readTool(roots, { filePaths: paths, limit: 1 });
    expect(structured(batch).targets).toBe(12);
    expect(text(batch)).toContain('small-11');

    const large = path.join(dir, 'large.txt');
    const handle = await fs.open(large, 'w');
    try {
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      chunk[chunk.length - 1] = 0x0a;
      for (let i = 0; i < 17; i++) await handle.write(chunk);
    } finally {
      await handle.close();
    }
    const result = await readTool(roots, { filePath: '/project/large.txt', limit: 1 });
    expect(text(result)).toContain('1: ');
    expect(text(result)).not.toMatch(/too large/i);
  });

  it('makes content beyond the old 2k-per-line preview ceiling reachable by column continuation', async () => {
    await fs.writeFile(path.join(dir, 'long-line.txt'), `${'a'.repeat(60_000)}MAGIC_LATE${'b'.repeat(10_000)}\n`);
    const first = await readTool(roots, { filePath: '/project/long-line.txt', offset: 1, limit: 1 });
    const firstText = text(first);
    expect(firstText).not.toContain('MAGIC_LATE');
    expect(firstText).not.toContain('(line truncated)');
    const match = firstText.match(/column=(\d+)/);
    expect(match?.[1]).toBeDefined();
    const second = await readTool(roots, {
      filePath: '/project/long-line.txt',
      offset: 1,
      limit: 1,
      column: Number(match![1]),
    });
    expect(text(second)).toContain('MAGIC_LATE');
  });

  it('paginates search matches instead of making results after the first page unreachable', async () => {
    const searchDir = path.join(dir, 'search-many');
    await fs.mkdir(searchDir);
    for (let index = 0; index < 230; index++) {
      await fs.writeFile(path.join(searchDir, `${String(index).padStart(3, '0')}.txt`), `needle-${index}\n`);
    }
    const first = await findTool(roots, { query: 'needle', path: '/project/search-many', mode: 'text', maxResults: 100 });
    expect(structured(first).nextOffset).toBe(100);
    const second = await findTool(roots, { query: 'needle', path: '/project/search-many', mode: 'text', maxResults: 100, offset: 100 });
    expect(text(second)).toContain('100.txt');
    expect(structured(second).nextOffset).toBe(200);
    const third = await findTool(roots, { query: 'needle', path: '/project/search-many', mode: 'text', maxResults: 100, offset: 200 });
    expect(text(third)).toContain('229.txt');
    expect(structured(third).nextOffset).toBeNull();
  });

  it('accepts more than the old 20-command exec batch', async () => {
    const result = await execTool(roots, {
      cmds: Array.from({ length: 25 }, (_, index) => `echo batch-${index}`),
      workdir: '/project',
      yield_time_ms: 5000,
    });
    expect(text(result)).toContain('batch-24');
  });

  it('accepts more than the old 100-operation edit batch atomically', async () => {
    const file = path.join(dir, 'many.txt');
    const before = Array.from({ length: 125 }, (_, index) => `v${index}`).join('\n') + '\n';
    await fs.writeFile(file, before);
    await readTool(roots, { filePath: '/project/many.txt', limit: 1 });
    const result = await editTool(roots, {
      filePath: '/project/many.txt',
      edits: Array.from({ length: 125 }, (_, index) => ({ line: index + 1, oldText: `v${index}`, newText: `x${index}` })),
    });
    expect(structured(result).applied).toBe(125);
    expect(await fs.readFile(file, 'utf8')).toContain('x124');
  });

  it('paginates archives instead of making entries after 200 inaccessible', async () => {
    const bytes = await ZipFile.zipToBuffer(Array.from({ length: 250 }, (_, index) => ({
      name: `entry-${String(index).padStart(3, '0')}.txt`,
      data: new TextEncoder().encode(String(index)),
      date: new Date(0),
    })));
    await fs.writeFile(path.join(dir, 'many.zip'), bytes);
    const result = await archiveTool(roots, { action: 'list', path: '/project/many.zip', offset: 201, limit: 50 }, true);
    expect(text(result)).toContain('entry-249.txt');
    expect(structured(result).count).toBe(250);
    expect(structured(result).nextOffset).toBeNull();
  });

  it('publishes more than the old 64-plugin-tool exposure ceiling', () => {
    const tools: Tool[] = Array.from({ length: 100 }, (_, index) => ({
      name: `tool_${index}`,
      description: `tool ${index}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    const exposure = pluginExposure([{ id: 'many', name: 'Many', enabled: true, tools, disabledTools: [] }]);
    expect(exposure.tools).toHaveLength(100);
    expect(exposure.owners.get('tool_99')).toBe('many');
  });

  it('keeps persisted background jobs addressable beyond the old 200-job restore ceiling', async () => {
    const state = path.join(dir, '.state');
    const output = path.join(state, 'job-output');
    await fs.mkdir(output, { recursive: true });
    for (let index = 0; index < 205; index++) {
      const id = `persisted_${String(index).padStart(3, '0')}`;
      const logPath = path.join(output, `${id}.log`);
      await fs.writeFile(logPath, '');
      await fs.writeFile(path.join(output, `${id}.json`), JSON.stringify({
        id, command: `echo ${index}`, cwd: dir, displayCwd: '/project', shell: 'test',
        startedAt: index, endedAt: index + 1, exitCode: 0, state: 'completed', logPath,
      }));
    }
    await backgroundJobs.initialize(state);
    const page = await backgroundJobs.action({ action: 'list', offset: 200, limit: 10 });
    expect(structured(page).total).toBe(205);
    expect((structured(page).jobs as unknown[]).length).toBe(5);
  });

  it('does not stop symbol discovery after the old 150 parsed candidates', async () => {
    const sourceDir = path.join(dir, 'src');
    await fs.mkdir(sourceDir);
    for (let index = 0; index < 151; index++) {
      const body = index === 150 ? 'export function NeedleBeyondOldCap() { return 1; }\n' : '// NeedleBeyondOldCap\n';
      await fs.writeFile(path.join(sourceDir, `${String(index).padStart(3, '0')}.ts`), body);
    }
    const result = await symbolsTool(roots, { action: 'search', query: 'NeedleBeyondOldCap', path: '/project/src' });
    expect(text(result)).toContain('150.ts');
    expect(structured(result).skipped).toBe(0);
  });
});
