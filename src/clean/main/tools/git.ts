import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { childEnv, terminateProcessTree } from '../../../main/exec.js';
import { isContained } from '../../../main/sandbox.js';
import { ok, resolveDirectory, truncateUtf8 } from './common.js';

const GIT_PREFIX = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'color.ui=false',
  '-c', 'core.quotepath=false',
  '-c', 'core.autocrlf=false'
];

const READONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'describe', 'remote', 'config',
  'show-ref', 'for-each-ref', 'name-rev', 'merge-base', 'cat-file', 'check-ignore', 'blame', 'shortlog'
]);

const FORBIDDEN_SHELL_ARGS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--force', '--force-with-lease', '--hard', '--delete', '-d', '-D',
  '--remove', '-m', '--amend', '--reset', '--checkout', '--merge', '--rebase', '--clean'
]);

export interface GitInput {
  mode?: 'help' | 'status' | 'summary' | 'diff' | 'log' | 'show' | 'stage' | 'unstage' | 'restore' | 'commit' | 'shell';
  workdir?: string;
  paths?: string[];
  ref?: string;
  staged?: boolean;
  maxBytes?: number;
  maxCount?: number;
  contextLines?: number;
  message?: string;
  dryRun?: boolean;
  confirm?: 'STAGE_ALL' | 'UNSTAGE_ALL' | 'RESTORE_WORKTREE' | 'RESTORE_BOTH' | 'RESTORE_ALL' | 'COMMIT';
  allowEmpty?: boolean;
  sign?: boolean;
  restoreTarget?: 'worktree' | 'staged' | 'both';
  argv?: string[];
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

async function runGit(args: string[], cwd: string, maxBytes = 80_000, timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...GIT_PREFIX, ...args], {
      cwd,
      env: {
        ...childEnv(),
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_LITERAL_PATHSPECS: '1'
      },
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (kind: 'out' | 'err', value: Buffer) => {
      const current = kind === 'out' ? stdout : stderr;
      const other = kind === 'out' ? stderr : stdout;
      const room = Math.max(0, maxBytes - Buffer.byteLength(other, 'utf8'));
      const next = truncateUtf8(current + value.toString('utf8'), room);
      if (kind === 'out') stdout = next.text; else stderr = next.text;
      truncated ||= next.truncated;
    };
    child.stdout.on('data', (chunk: Buffer) => append('out', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('err', chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void terminateProcessTree(child.pid, true);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: `${stderr}${stderr ? '\n' : ''}${error.message}`, truncated });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr: `${stderr}${timedOut ? '\n(git command timed out)' : ''}`.trim(), truncated });
    });
  });
}

function requireConfirm(expected: GitInput['confirm'], actual: GitInput['confirm'], what: string): void {
  if (actual !== expected) throw new Error(`${what} requires confirm:${JSON.stringify(expected)}`);
}

function pathInside(root: string, input: string): string {
  if (!input || input.includes('\0')) throw new Error('invalid git path');
  if (input.startsWith('-') || input.includes(':(') || input.startsWith(':/')) throw new Error(`unsafe git path: ${input}`);
  const absolute = path.isAbsolute(input) ? input : path.resolve(root, input);
  if (!isContained(root, absolute)) throw new Error(`git path escapes the repository: ${input}`);
  return path.relative(root, absolute).split(path.sep).join('/');
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function repositoryRoot(roots: readonly Root[], workdir?: string): Promise<string> {
  const dir = await resolveDirectory(roots, workdir);
  const top = await runGit(['rev-parse', '--show-toplevel'], dir.real, 4096, 5000);
  if (top.exitCode !== 0 || !top.stdout.trim()) throw new Error(`${dir.virtual} is not inside a git worktree`);
  const root = path.resolve(top.stdout.trim());
  const approvedRoot = roots.find((item) => isContained(item.path, root));
  if (!approvedRoot) throw new Error('the git worktree root is outside the approved folder boundary');
  return root;
}

async function status(root: string, paths: string[]): Promise<string> {
  const args = ['status', '--porcelain=v1', '--untracked-files=all', '--no-renames'];
  if (paths.length) args.push('--', ...paths);
  const result = await runGit(args, root);
  if (result.exitCode !== 0) throw new Error(result.stderr || 'git status failed');
  if (!result.stdout.trim()) return '<status clean="true" />\n(working tree clean)';
  const lines = result.stdout.trim().split(/\r?\n/);
  return `<status clean="false" entries="${lines.length}">\n${lines.map((line) => `  <entry>${xml(line)}</entry>`).join('\n')}\n</status>`;
}

export async function gitTool(roots: readonly Root[], input: GitInput) {
  const mode = input.mode ?? 'status';
  const root = await repositoryRoot(roots, input.workdir);
  // Never silently discard path operands. Request transport size and Git's argv/OS limits are
  // the real resource boundaries; an arbitrary first-500 slice can mutate the wrong subset.
  const paths = (input.paths ?? []).map((item) => pathInside(root, item));
  const maxBytes = Math.min(Math.max(input.maxBytes ?? 80_000, 2000), 500_000);
  const render = (text: string, extra: Record<string, unknown> = {}) => ok(text, { mode, ...extra });

  if (mode === 'help') return render('git modes: status, summary, diff, log, show, stage, unstage, restore, commit, shell');
  if (mode === 'status') return render(await status(root, paths));
  if (mode === 'summary') {
    const [branch, stat, recent] = await Promise.all([
      runGit(['branch', '--show-current'], root, 4096),
      status(root, paths),
      runGit(['log', '--oneline', '-n', String(Math.max(input.maxCount ?? 5, 1))], root, maxBytes)
    ]);
    return render(`<summary branch="${xml(branch.stdout.trim() || '(detached HEAD)')}">\n${stat}\n</summary>\n<recent>\n${xml(recent.stdout.trim() || '(none)')}\n</recent>`);
  }
  if (mode === 'diff') {
    const args = ['diff', '--no-ext-diff', '--no-renames', `--unified=${Math.max(input.contextLines ?? 3, 0)}`];
    if (input.staged) args.push('--cached');
    if (input.ref) args.push(input.ref);
    if (paths.length) args.push('--', ...paths);
    const result = await runGit(args, root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'git diff failed');
    return render(result.stdout.trim() || '(no diff)', { truncated: result.truncated });
  }
  if (mode === 'log') {
    const args = ['log', '--oneline', '--decorate', '-n', String(Math.max(input.maxCount ?? 20, 1))];
    if (input.ref) args.push(input.ref);
    const result = await runGit(args, root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'git log failed');
    return render(result.stdout.trim() || '(no commits)', { truncated: result.truncated });
  }
  if (mode === 'show') {
    if (!input.ref) throw new Error('show requires ref');
    const args = ['show', '--stat', input.ref];
    if (paths.length) args.push('--', ...paths);
    const result = await runGit(args, root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'git show failed');
    return render(result.stdout.trim() || '(nothing to show)', { truncated: result.truncated });
  }
  if (mode === 'stage') {
    if (!paths.length) requireConfirm('STAGE_ALL', input.confirm, 'Staging all changes');
    const result = await runGit(paths.length ? ['add', '--', ...paths] : ['add', '-A', '.'], root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'git add failed');
    return render(`<staged paths="${paths.length || 'all'}">\n${await status(root, [])}\n</staged>`, { changed: true });
  }
  if (mode === 'unstage') {
    if (!paths.length) requireConfirm('UNSTAGE_ALL', input.confirm, 'Unstaging all changes');
    const result = await runGit(['restore', '--staged', '--', ...(paths.length ? paths : ['.'])], root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'git restore --staged failed');
    return render(`<unstaged paths="${paths.length || 'all'}">\n${await status(root, [])}\n</unstaged>`, { changed: true });
  }
  if (mode === 'restore') {
    const target = input.restoreTarget ?? 'worktree';
    if (!paths.length) requireConfirm('RESTORE_ALL', input.confirm, 'Restoring all changes');
    else requireConfirm(target === 'both' ? 'RESTORE_BOTH' : 'RESTORE_WORKTREE', input.confirm, `Restoring ${target}`);
    const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U'], root, 4096);
    if (conflicts.stdout.trim()) throw new Error(`refusing restore while unmerged conflicts exist:\n${conflicts.stdout.trim()}`);
    const args = ['restore'];
    if (target === 'staged') args.push('--staged');
    if (target === 'both') args.push('--staged', '--worktree');
    args.push('--', ...(paths.length ? paths : ['.']));
    const result = await runGit(args, root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || 'git restore failed');
    return render(`<restored target="${target}">\n${await status(root, [])}\n</restored>`, { changed: true });
  }
  if (mode === 'commit') {
    if (!input.message) throw new Error('commit requires message');
    const conflicts = await runGit(['diff', '--name-only', '--diff-filter=U', '--cached'], root, 4096);
    if (conflicts.stdout.trim()) throw new Error(`refusing commit while unmerged files are staged:\n${conflicts.stdout.trim()}`);
    const preview = await runGit(['commit', '--dry-run'], root, maxBytes);
    if (input.dryRun !== false) return render(`${preview.stdout.trim() || preview.stderr.trim() || '(would commit staged changes)'}\nRe-run with dryRun:false and confirm:"COMMIT" to apply.`);
    requireConfirm('COMMIT', input.confirm, 'Commit');
    const args = ['commit', '-m', input.message];
    if (input.allowEmpty) args.push('--allow-empty');
    if (!input.sign) args.push('--no-gpg-sign');
    const result = await runGit(args, root, maxBytes);
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'git commit failed');
    const head = await runGit(['log', '-1', '--oneline'], root, 4096);
    return render(`<commit applied="true">${xml(head.stdout.trim())}</commit>\n${await status(root, [])}`, { changed: true, commit: head.stdout.trim() });
  }
  if (mode === 'shell') {
    const argv = input.argv ?? [];
    if (!argv.length) throw new Error('shell mode requires at least one argv item');
    if (!READONLY_SUBCOMMANDS.has(argv[0]!)) throw new Error(`git shell refuses write subcommand ${JSON.stringify(argv[0])}; use a typed mode`);
    for (const arg of argv) {
      if ([...FORBIDDEN_SHELL_ARGS].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) throw new Error(`git shell refuses argument ${arg}`);
    }
    const result = await runGit(argv, root, maxBytes);
    return render(result.stdout.trim() || result.stderr.trim() || '(no output)', { exitCode: result.exitCode, truncated: result.truncated });
  }
  throw new Error(`unsupported git mode: ${mode}`);
}
