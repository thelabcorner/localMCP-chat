import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Root } from '../../../shared/types.js';
import { readTool } from './read.js';
import { editTool } from './edit.js';
import { patchTool, restoreCapturedPreimages } from './patch.js';
import { applyPatch as applyCodexPatch } from '../../../main/codex/apply-patch/index.js';
import { gitTool } from './git.js';
import { execTool, unifiedExecManager, writeStdinTool } from './exec.js';
import { backgroundJobs, shellTool } from './background.js';

let dir = '';
let roots: Root[] = [];

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

function text(result: Awaited<ReturnType<typeof readTool>>): string {
  const block = result.content[0];
  return block?.type === 'text' ? block.text : '';
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent as Record<string, unknown>
    : {};
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-test-'));
  const canonical = await fs.realpath(dir);
  roots = [{ name: 'project', path: canonical }];
  await backgroundJobs.initialize(path.join(dir, '.state'));
});

afterEach(async () => {
  await Promise.allSettled([backgroundJobs.close(), unifiedExecManager.terminateAllProcesses()]);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('clean coding tool surface', () => {
  it('batches independent read windows and records content', async () => {
    await fs.writeFile(path.join(dir, 'a.ts'), 'one\ntwo\nthree\n');
    await fs.writeFile(path.join(dir, 'b.ts'), 'alpha\nbeta\n');
    const result = await readTool(roots, {
      reads: [
        { filePath: '/project/a.ts', offset: 2, limit: 1 },
        { filePath: '/project/b.ts', offset: 1, limit: 2 }
      ]
    });
    expect(text(result)).toContain('2: two');
    expect(text(result)).toContain('1: alpha');
    expect(structured(result).targets).toBe(2);
    expect(String(structured(result).text)).toContain('2: two');
    expect(String(structured(result).text)).toContain('1: alpha');
  });

  it('hard-refuses a known stale read before editing', async () => {
    const file = path.join(dir, 'stale.txt');
    await fs.writeFile(file, 'before\n');
    await readTool(roots, { filePath: '/project/stale.txt' });
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fs.writeFile(file, 'someone else changed it\n');
    await expect(editTool(roots, { filePath: '/project/stale.txt', oldString: 'before', newString: 'after' }))
      .rejects.toThrow(/changed on disk after it was last read/i);
    expect(await fs.readFile(file, 'utf8')).toBe('someone else changed it\n');
  });

  it('applies a non-overlapping single-file edit batch against original coordinates', async () => {
    const file = path.join(dir, 'batch.txt');
    await fs.writeFile(file, 'alpha\nbeta\ngamma\n');
    await readTool(roots, { filePath: '/project/batch.txt' });
    const result = await editTool(roots, {
      filePath: '/project/batch.txt',
      edits: [
        { line: 1, oldText: 'alpha', newText: 'ALPHA' },
        { oldString: 'gamma', newString: 'GAMMA' }
      ]
    });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  it('matches multiline exact edits independent of caller EOLs and preserves mixed source endings positionally', async () => {
    const file = path.join(dir, 'mixed-edit.txt');
    await fs.writeFile(file, 'alpha\r\nbeta\ngamma\r\n');
    await readTool(roots, { filePath: '/project/mixed-edit.txt' });
    await editTool(roots, {
      filePath: '/project/mixed-edit.txt',
      oldString: 'alpha\nbeta\ngamma',
      newString: 'ALPHA\nBETA\nGAMMA'
    });
    expect(await fs.readFile(file, 'utf8')).toBe('ALPHA\r\nBETA\nGAMMA\r\n');
  });

  it('supports CR-only source files without converting their line endings', async () => {
    const file = path.join(dir, 'cr-only.txt');
    await fs.writeFile(file, 'alpha\rbeta\r');
    await readTool(roots, { filePath: '/project/cr-only.txt' });
    await editTool(roots, {
      filePath: '/project/cr-only.txt',
      oldString: 'alpha\nbeta',
      newString: 'ALPHA\nBETA'
    });
    expect(await fs.readFile(file, 'utf8')).toBe('ALPHA\rBETA\r');
  });

  it('replaceAll sees equivalent mixed-EOL occurrences instead of silently editing only one style', async () => {
    const file = path.join(dir, 'mixed-replace-all.txt');
    await fs.writeFile(file, 'x\r\ny\nx\ny\r\n');
    await readTool(roots, { filePath: '/project/mixed-replace-all.txt' });
    await editTool(roots, {
      filePath: '/project/mixed-replace-all.txt',
      oldString: 'x\ny',
      newString: 'X\nY',
      replaceAll: true
    });
    expect(await fs.readFile(file, 'utf8')).toBe('X\r\nY\nX\nY\r\n');
  });

  it('preflights and applies one native multi-file patch', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
    await readTool(roots, { filePath: '/project/a.txt' });
    const patchText = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-one',
      '+ONE',
      ' two',
      '*** Add File: b.txt',
      '+created',
      '*** End Patch'
    ].join('\n');
    const result = await patchTool(roots, { patchText, workdir: '/project' });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('ONE\ntwo\n');
    expect(await fs.readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('created\n');
  });

  it('preserves CRLF exactly around native patch updates', async () => {
    const file = path.join(dir, 'crlf.txt');
    await fs.writeFile(file, 'one\r\ntwo\r\nthree\r\n');
    await readTool(roots, { filePath: '/project/crlf.txt' });
    const patchText = [
      '*** Begin Patch',
      '*** Update File: crlf.txt',
      '@@',
      ' one',
      '-two',
      '+TWO',
      ' three',
      '*** End Patch'
    ].join('\n');
    await patchTool(roots, { patchText, workdir: '/project' });
    expect(await fs.readFile(file, 'utf8')).toBe('one\r\nTWO\r\nthree\r\n');
  });

  it('makes preserve-and-infer the raw apply_patch default, not only a tool-adapter option', async () => {
    const file = path.join(dir, 'raw-default.txt');
    await fs.writeFile(file, 'one\r\ntwo\r\n');
    const stdout = { text: '' };
    const stderr = { text: '' };
    await applyCodexPatch([
      '*** Begin Patch',
      '*** Update File: raw-default.txt',
      '@@',
      '-one',
      '+ONE',
      ' two',
      '*** End Patch'
    ].join('\n'), dir, stdout, stderr);
    expect(stderr.text).toBe('');
    expect(await fs.readFile(file, 'utf8')).toBe('ONE\r\ntwo\r\n');
  });

  it('auto-heals whole-file Add File overwrites instead of flattening existing mixed endings', async () => {
    const file = path.join(dir, 'raw-write-overwrite.txt');
    await fs.writeFile(file, 'one\r\ntwo\nthree\r\n');
    const stdout = { text: '' };
    const stderr = { text: '' };
    await applyCodexPatch([
      '*** Begin Patch',
      '*** Add File: raw-write-overwrite.txt',
      '+ONE',
      '+two',
      '+THREE',
      '*** End Patch'
    ].join('\n'), dir, stdout, stderr);
    expect(stderr.text).toBe('');
    expect(await fs.readFile(file, 'utf8')).toBe('ONE\r\ntwo\nTHREE\r\n');
  });

  it('infers inserted native-patch line endings from the local mixed-ending neighborhood', async () => {
    const file = path.join(dir, 'mixed.txt');
    // LF is globally dominant, but the insertion site is inside a CRLF island. Local context must
    // win so a surgical patch cannot drag the file's global majority style into this region.
    await fs.writeFile(file, 'one\r\ntwo\r\nthree\nfour\nfive\n');
    await readTool(roots, { filePath: '/project/mixed.txt' });
    const patchText = [
      '*** Begin Patch',
      '*** Update File: mixed.txt',
      '@@',
      ' one',
      '+inserted',
      ' two',
      '*** End Patch'
    ].join('\n');
    await patchTool(roots, { patchText, workdir: '/project' });
    expect(await fs.readFile(file, 'utf8')).toBe('one\r\ninserted\r\ntwo\r\nthree\nfour\nfive\n');
  });

  it('gives an unterminated former EOF line the surrounding style when native patch appends after it', async () => {
    const file = path.join(dir, 'append-after-unterminated.txt');
    await fs.writeFile(file, 'one\r\ntwo');
    await readTool(roots, { filePath: '/project/append-after-unterminated.txt' });
    const patchText = [
      '*** Begin Patch',
      '*** Update File: append-after-unterminated.txt',
      '@@',
      ' one',
      ' two',
      '+three',
      '*** End Patch'
    ].join('\n');
    await patchTool(roots, { patchText, workdir: '/project' });
    expect(await fs.readFile(file, 'utf8')).toBe('one\r\ntwo\r\nthree');
  });

  it('preserves an existing missing final newline when a native patch edits an earlier line', async () => {
    const file = path.join(dir, 'no-final-newline.txt');
    await fs.writeFile(file, 'one\r\ntwo');
    await readTool(roots, { filePath: '/project/no-final-newline.txt' });
    const patchText = [
      '*** Begin Patch',
      '*** Update File: no-final-newline.txt',
      '@@',
      '-one',
      '+ONE',
      ' two',
      '*** End Patch'
    ].join('\n');
    await patchTool(roots, { patchText, workdir: '/project' });
    expect(await fs.readFile(file, 'utf8')).toBe('ONE\r\ntwo');
  });

  it('accepts a clean git-style unified diff through the same patch executor', async () => {
    const file = path.join(dir, 'gitdiff.txt');
    await fs.writeFile(file, 'old\n');
    await readTool(roots, { filePath: '/project/gitdiff.txt' });
    const result = await patchTool(roots, {
      format: 'git',
      workdir: '/project',
      patchText: ['--- a/gitdiff.txt', '+++ b/gitdiff.txt', '@@ -1,1 +1,1 @@', '-old', '+new', ''].join('\n')
    });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('new\n');
  });

  it('keeps uniform CRLF intact through the git-style patch path', async () => {
    const file = path.join(dir, 'gitdiff-crlf.txt');
    await fs.writeFile(file, 'old\r\nnext\r\n');
    await readTool(roots, { filePath: '/project/gitdiff-crlf.txt' });
    await patchTool(roots, {
      format: 'git',
      workdir: '/project',
      patchText: ['--- a/gitdiff-crlf.txt', '+++ b/gitdiff-crlf.txt', '@@ -1,2 +1,2 @@', '-old', '+new', ' next', ''].join('\n')
    });
    expect(await fs.readFile(file, 'utf8')).toBe('new\r\nnext\r\n');
  });

  it('auto-heals mixed line endings when a git-style patch must normalize to match context', async () => {
    const file = path.join(dir, 'gitdiff-mixed.txt');
    await fs.writeFile(file, 'one\r\ntwo\r\nthree\nfour\nfive\n');
    await readTool(roots, { filePath: '/project/gitdiff-mixed.txt' });
    const result = await patchTool(roots, {
      format: 'git',
      workdir: '/project',
      patchText: ['--- a/gitdiff-mixed.txt', '+++ b/gitdiff-mixed.txt', '@@ -1,3 +1,4 @@', ' one', '+inserted', ' two', ' three', ''].join('\n')
    });
    expect(result.isError).not.toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('one\r\ninserted\r\ntwo\r\nthree\nfour\nfive\n');
    expect(structured(result).lineEndingRepairs).toEqual(['/project/gitdiff-mixed.txt']);
  });

  it('never overwrites a concurrent external edit while restoring patch preimages', async () => {
    const file = path.join(dir, 'first.txt');
    await fs.writeFile(file, 'external-newer\n');
    const snapshot = new Map([[file, { bytes: Buffer.from('first-old\n') }]]);
    const expectedPost = new Map([[file, Buffer.from('first-patched\n') as Buffer | null]]);

    await expect(restoreCapturedPreimages(snapshot, expectedPost)).rejects.toThrow(/newer contents were preserved/i);
    expect(await fs.readFile(file, 'utf8')).toBe('external-newer\n');
  });

  it('provides typed git status without shell-string git invocation', async () => {
    await run('git', ['init', '-q'], dir);
    await fs.writeFile(path.join(dir, 'tracked.txt'), 'x\n');
    const result = await gitTool(roots, { mode: 'status', workdir: '/project' });
    const first = result.content[0];
    expect(first?.type === 'text' ? first.text : '').toContain('tracked.txt');
    expect(String(structured(result).text)).toContain('tracked.txt');
  });

  it('yields long live commands and drains the same session with write_stdin', async () => {
    const result = await execTool(roots, {
      cmd: `node -e "setTimeout(() => console.log('done'), 900)"`,
      workdir: '/project',
      yield_time_ms: 250
    });
    const id = Number(structured(result).session_id);
    expect(id).toBeGreaterThan(0);
    let polled = await writeStdinTool({ session_id: id, yield_time_ms: 5000 });
    const first = polled.content[0];
    expect(first?.type === 'text' ? first.text : '').toContain('done');
    while (structured(polled).session_id !== undefined) {
      polled = await writeStdinTool({ session_id: id, yield_time_ms: 5000 });
    }
    expect(structured(polled).exit_code).toBe(0);
  });

  it('persists background output and exposes byte-cursor polling', async () => {
    const started = await shellTool(roots, {
      command: `node -e "setTimeout(() => console.log('background-done'), 350)"`,
      workdir: '/project',
      background: true,
      id: 'testjob'
    });
    expect(structured(started).id).toBe('testjob');
    const waited = await backgroundJobs.action({ action: 'wait', id: 'testjob', offset: 0, timeoutMs: 5000 });
    const first = waited.content[0];
    expect(first?.type === 'text' ? first.text : '').toContain('background-done');
    expect(String(structured(waited).text)).toContain('background-done');
    expect(Number(structured(waited).nextOffset)).toBeGreaterThan(0);
  });
});
