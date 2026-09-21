import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { childEnv, terminateProcessTree } from '../../../main/exec.js';
import { defaultUserShell, deriveExecArgs, getShellByModelProvidedPath } from '../../../main/codex/shell.js';
import { ok, resolveDirectory, truncateUtf8 } from './common.js';
import { catastrophicDeleteReason } from './shell-safety.js';
import { execTool } from './exec.js';

type JobState = 'running' | 'completed' | 'error' | 'cancelled';

interface PersistedJob {
  id: string;
  command: string;
  cwd: string;
  displayCwd: string;
  shell: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  state: JobState;
  timeoutMs?: number;
  error?: string;
  logPath: string;
}

interface LiveJob extends PersistedJob {
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  waiters: Set<() => void>;
}

export interface ShellInput {
  command: string;
  workdir?: string;
  background?: boolean;
  id?: string;
  timeout?: number;
  tty?: boolean;
  shell?: string;
  login?: boolean;
  yield_time_ms?: number;
}

export interface BackgroundInput {
  action?: 'list' | 'status' | 'read' | 'wait' | 'send' | 'kill' | 'remove';
  id?: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
  timeoutMs?: number;
  chars?: string;
}

class BackgroundJobManager {
  private root = '';
  private jobs = new Map<string, LiveJob>();

  async initialize(userDataDir: string): Promise<void> {
    this.root = path.join(userDataDir, 'job-output');
    await fs.mkdir(this.root, { recursive: true });
    const names = await fs.readdir(this.root).catch(() => [] as string[]);
    // Persisted jobs are durable by contract. Loading only an arbitrary last 200 made older
    // job ids become permanently "unknown" after restart. Metadata is tiny; payload bytes live
    // in separate log files and are not loaded here.
    for (const name of names.filter((item) => item.endsWith('.json'))) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.root, name), 'utf8')) as PersistedJob;
        if (!parsed?.id || !parsed.logPath || !['running', 'completed', 'error', 'cancelled'].includes(parsed.state)) continue;
        // A process from an earlier app instance is intentionally not adopted. Its historical
        // output remains readable, but ownership of an unknown live PID is never guessed.
        if (parsed.state === 'running') {
          parsed.state = 'error';
          parsed.error = 'localMCP-chat restarted before this background job reported completion; live process ownership was not reattached.';
          parsed.endedAt = Date.now();
        }
        this.jobs.set(parsed.id, { ...parsed, waiters: new Set() });
      } catch {}
    }
  }

  private metaPath(id: string): string { return path.join(this.root, `${id}.json`); }
  private logPath(id: string): string { return path.join(this.root, `${id}.log`); }

  private async save(job: LiveJob): Promise<void> {
    const { child: _child, timer: _timer, waiters: _waiters, ...persisted } = job;
    const temp = `${this.metaPath(job.id)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(persisted, null, 2), 'utf8');
    await fs.rename(temp, this.metaPath(job.id));
  }

  private wake(job: LiveJob): void {
    for (const waiter of job.waiters) waiter();
    job.waiters.clear();
  }

  private allocate(requested?: string): string {
    if (requested) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(requested)) throw new Error('background job id must match ^[A-Za-z0-9_-]{1,80}$');
      if (this.jobs.has(requested)) throw new Error(`background job id ${JSON.stringify(requested)} is already in use`);
      return requested;
    }
    for (;;) {
      const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      if (!this.jobs.has(id)) return id;
    }
  }

  async launch(roots: readonly Root[], input: ShellInput) {
    if (!input.command?.trim()) throw new Error('shell command is required');
    const dir = await resolveDirectory(roots, input.workdir);
    const shell = input.shell ? getShellByModelProvidedPath(input.shell, dir.real) : defaultUserShell();
    if (!shell) throw new Error(`requested shell ${JSON.stringify(input.shell)} could not be resolved`);
    const blocked = catastrophicDeleteReason(input.command, shell.shellType, dir.real);
    if (blocked) throw new Error(blocked);
    const id = this.allocate(input.id);
    const logPath = this.logPath(id);
    await fs.writeFile(logPath, '', 'utf8');
    const timeoutMs = input.timeout === undefined ? undefined : Math.max(Math.floor(input.timeout), 1000);
    const argv = deriveExecArgs(shell, input.command, input.login ?? process.platform !== 'win32');
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: dir.real,
      env: childEnv(),
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const job: LiveJob = {
      id,
      command: input.command,
      cwd: dir.real,
      displayCwd: dir.virtual,
      shell: shell.shellPath,
      startedAt: Date.now(),
      state: 'running',
      timeoutMs,
      logPath,
      child,
      waiters: new Set()
    };
    this.jobs.set(id, job);
    await this.save(job);
    const sink = createWriteStream(logPath, { flags: 'a' });
    const append = (chunk: Buffer) => { sink.write(chunk, () => this.wake(job)); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    let finishing = false;
    const finish = async (state: JobState, exitCode: number | null, error?: string) => {
      if (job.state !== 'running' || finishing) return;
      finishing = true;
      if (job.timer) clearTimeout(job.timer);
      // A completed job promises that all child output is readable from its persisted log.
      // Flush the stream before publishing the terminal state or waking waiters.
      await new Promise<void>((resolve) => sink.end(resolve));
      job.state = state;
      job.exitCode = exitCode;
      job.endedAt = Date.now();
      if (error) job.error = error;
      job.child = undefined;
      this.wake(job);
      await this.save(job).catch(() => undefined);
    };
    child.once('error', (error) => void finish('error', null, error.message));
    child.once('close', (code, signal) => void finish(code === 0 ? 'completed' : 'error', code, signal ? `terminated by ${signal}` : code === 0 ? undefined : `process exited ${code}`));
    if (timeoutMs) {
      job.timer = setTimeout(() => {
        if (job.child?.pid) void terminateProcessTree(job.child.pid, true);
        void finish('cancelled', null, `timed out after ${timeoutMs} ms`);
      }, timeoutMs);
      job.timer.unref?.();
    }
    return this.describe(job, await this.outputSize(job));
  }

  private async outputSize(job: LiveJob): Promise<number> {
    try { return (await fs.stat(job.logPath)).size; } catch { return 0; }
  }

  private describe(job: LiveJob, outputBytes: number) {
    return {
      id: job.id,
      state: job.state,
      command: job.command,
      workdir: job.displayCwd,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
      error: job.error,
      outputBytes,
      timeoutMs: job.timeoutMs
    };
  }

  async action(input: BackgroundInput) {
    const action = input.action ?? 'list';
    if (action === 'list') {
      const all = [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
      const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
      const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? input.limit! : 100;
      const selected = all.slice(offset, offset + limit);
      const rows = await Promise.all(selected.map(async (job) => this.describe(job, await this.outputSize(job))));
      const nextOffset = offset + rows.length < all.length ? offset + rows.length : null;
      const header = all.length ? `[jobs] total=${all.length} range=${offset}-${offset + rows.length}${nextOffset === null ? '' : ` nextOffset=${nextOffset}`}` : '';
      return ok(rows.length ? `${header}\n${rows.map((row) => `${row.id}\t${row.state}\t${row.outputBytes} B\t${row.command}`).join('\n')}` : '(no background jobs)', { jobs: rows, total: all.length, offset, nextOffset });
    }
    if (!input.id) throw new Error(`background action ${action} requires id`);
    const job = this.jobs.get(input.id);
    if (!job) throw new Error(`unknown background job: ${input.id}`);
    if (action === 'status') {
      const row = this.describe(job, await this.outputSize(job));
      return ok(JSON.stringify(row, null, 2), row as unknown as Record<string, unknown>);
    }
    if (action === 'read') return this.read(job, input.offset ?? 0, input.maxBytes ?? 64 * 1024);
    if (action === 'wait') {
      const before = await this.outputSize(job);
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 5000, 250), 30_000);
      const deadline = Date.now() + timeoutMs;
      while (job.state === 'running' && await this.outputSize(job) <= before) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise<void>((resolve) => {
          let timer: NodeJS.Timeout | undefined;
          const done = () => {
            if (timer) clearTimeout(timer);
            job.waiters.delete(done);
            resolve();
          };
          // Register before checking state again so an output/exit wake cannot be lost
          // between the loop predicate and waiter installation.
          job.waiters.add(done);
          timer = setTimeout(done, remaining);
          void this.outputSize(job).then((size) => {
            if (job.state !== 'running' || size > before) done();
          }, done);
        });
      }
      return this.read(job, input.offset ?? before, input.maxBytes ?? 64 * 1024);
    }
    if (action === 'send') {
      if (job.state !== 'running' || !job.child?.stdin) throw new Error('background job is not running or has no stdin');
      await new Promise<void>((resolve, reject) => job.child!.stdin!.write(input.chars ?? '', (error) => error ? reject(error) : resolve()));
      return ok(`Sent ${(input.chars ?? '').length} characters to ${job.id}.`);
    }
    if (action === 'kill') {
      if (job.state === 'running' && job.child?.pid) {
        await terminateProcessTree(job.child.pid, true);
        job.state = 'cancelled';
        job.endedAt = Date.now();
        job.error = 'killed by background tool';
        job.child = undefined;
        if (job.timer) clearTimeout(job.timer);
        this.wake(job);
        await this.save(job);
      }
      return ok(`Background job ${job.id} is ${job.state}.`);
    }
    if (action === 'remove') {
      if (job.state === 'running') throw new Error('kill a running job before removing its record');
      this.jobs.delete(job.id);
      await Promise.all([fs.rm(this.metaPath(job.id), { force: true }), fs.rm(job.logPath, { force: true })]);
      return ok(`Removed background job ${job.id}.`);
    }
    throw new Error(`unsupported background action: ${action}`);
  }

  private async read(job: LiveJob, rawOffset: number, rawMax: number) {
    const size = await this.outputSize(job);
    const offset = Math.min(Math.max(Math.floor(rawOffset), 0), size);
    const maxBytes = Math.min(Math.max(Math.floor(rawMax), 1024), 256 * 1024);
    const handle = await fs.open(job.logPath, 'r');
    try {
      const length = Math.min(maxBytes, size - offset);
      const buffer = Buffer.alloc(length);
      if (length) await handle.read(buffer, 0, length, offset);
      const text = truncateUtf8(buffer.toString('utf8'), maxBytes).text;
      const nextOffset = offset + Buffer.byteLength(text, 'utf8');
      const header = `[${job.id}] state=${job.state} bytes=${size} range=${offset}-${nextOffset}`;
      return ok(`${header}\n${text || '(no new output)'}`, {
        id: job.id,
        state: job.state,
        offset,
        nextOffset,
        outputBytes: size,
        exitCode: job.exitCode ?? null,
        done: job.state !== 'running'
      });
    } finally { await handle.close(); }
  }

  async close(): Promise<void> {
    await Promise.all([...this.jobs.values()].map(async (job) => {
      if (job.timer) clearTimeout(job.timer);
      if (job.state === 'running' && job.child?.pid) await terminateProcessTree(job.child.pid, true).catch(() => undefined);
    }));
  }
}

export const backgroundJobs = new BackgroundJobManager();

export async function shellTool(roots: readonly Root[], input: ShellInput) {
  if (input.background) {
    const row = await backgroundJobs.launch(roots, input);
    return ok(
      `Background job ${row.id} started in ${row.workdir}. Use background action=status/read/wait/send/kill with this id. Full output is persisted locally.`,
      row as unknown as Record<string, unknown>
    );
  }
  return execTool(roots, {
    cmd: input.command,
    workdir: input.workdir,
    tty: input.tty,
    shell: input.shell,
    login: input.login,
    yield_time_ms: input.yield_time_ms
  });
}
