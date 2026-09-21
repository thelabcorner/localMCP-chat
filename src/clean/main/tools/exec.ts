import type { Root } from '../../../shared/types.js';
import { childEnv } from '../../../main/exec.js';
import {
  UnifiedExecError,
  UnifiedExecProcessManager,
  applyUnifiedExecEnv,
  execCommandResponseText,
  execCommandStructuredOutput
} from '../../../main/codex/unified-exec.js';
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
  DEFAULT_TTY
} from '../../../main/codex/unified-exec-constants.js';
import { defaultUserShell, deriveExecArgs, getShellByModelProvidedPath, shlexJoin } from '../../../main/codex/shell.js';
import { ok, resolveDirectory } from './common.js';
import { catastrophicDeleteReason } from './shell-safety.js';

const EXEC_TRUNCATION = { kind: 'tokens' as const, tokens: 10_000 };
export const unifiedExecManager = new UnifiedExecProcessManager(300_000);

export interface ExecInput {
  cmd?: string;
  cmds?: string[];
  workdir?: string;
  tty?: boolean;
  yield_time_ms?: number;
  max_output_tokens?: number;
  shell?: string;
  login?: boolean;
}

export interface WriteStdinInput {
  session_id: number;
  chars?: string;
  yield_time_ms?: number;
  max_output_tokens?: number;
}

function batchScript(commands: string[], shell: ReturnType<typeof defaultUserShell>): string {
  const labels = commands.map((command, index) => ({ command, label: `--- command ${index + 1}/${commands.length} ---` }));
  if (shell.shellType === 'powershell') {
    const parts = ['$__localMcpExit = 0'];
    for (const item of labels) {
      parts.push(`Write-Output ${JSON.stringify(item.label)}`);
      parts.push(`& { ${item.command} }`);
      parts.push(`$__c = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } elseif ($?) { 0 } else { 1 }`);
      parts.push(`Write-Output ("--- exit code " + $__c + " ---")`);
      parts.push(`if ($__localMcpExit -eq 0 -and $__c -ne 0) { $__localMcpExit = $__c }`);
    }
    parts.push('exit $__localMcpExit');
    return parts.join('; ');
  }
  if (shell.shellType === 'cmd') {
    return commands.map((command, index) => `echo ${labels[index]!.label} & ${command} & echo --- exit code %errorlevel% ---`).join(' & ');
  }
  const parts = ['__localmcp_exit=0'];
  for (const item of labels) {
    parts.push(`printf '%s\\n' ${JSON.stringify(item.label)}`);
    parts.push(`{ ${item.command}; }`);
    parts.push('__c=$?');
    parts.push(`printf '%s\\n' "--- exit code $__c ---"`);
    parts.push('[ "$__localmcp_exit" -eq 0 ] && [ "$__c" -ne 0 ] && __localmcp_exit=$__c || true');
  }
  parts.push('exit $__localmcp_exit');
  return parts.join('; ');
}

export async function execTool(roots: readonly Root[], input: ExecInput) {
  if ((input.cmd === undefined) === (input.cmds === undefined)) throw new Error('exec_command requires exactly one of cmd or cmds');
  const commands = input.cmds ?? [input.cmd!];
  if (commands.length < 1 || commands.some((command) => typeof command !== 'string' || !command.trim())) {
    throw new Error('cmds must contain at least one non-empty command');
  }
  const dir = await resolveDirectory(roots, input.workdir);
  const shell = input.shell ? getShellByModelProvidedPath(input.shell, dir.real) : defaultUserShell();
  if (!shell) throw new Error(`requested shell ${JSON.stringify(input.shell)} could not be resolved`);
  for (const command of commands) {
    const blocked = catastrophicDeleteReason(command, shell.shellType, dir.real);
    if (blocked) throw new Error(blocked);
  }
  const script = input.cmds ? batchScript(commands, shell) : commands[0]!;
  const useLogin = input.login ?? process.platform !== 'win32';
  const argv = deriveExecArgs(shell, script, useLogin);
  const processId = unifiedExecManager.allocateProcessId();
  try {
    const output = await unifiedExecManager.execCommand({
      command: argv,
      shellType: shell.shellType,
      hookCommand: input.cmds ? `[batch ${commands.length}] ${commands.join(' ; ')}` : commands[0]!,
      processId,
      yieldTimeMs: input.yield_time_ms ?? DEFAULT_EXEC_YIELD_TIME_MS,
      maxOutputTokens: undefined,
      truncationPolicy: EXEC_TRUNCATION,
      cwd: dir.real,
      displayCwd: dir.virtual,
      env: applyUnifiedExecEnv(childEnv()),
      tty: input.tty ?? DEFAULT_TTY
    });
    return ok(execCommandResponseText(output), execCommandStructuredOutput(output));
  } catch (error) {
    const detail = error instanceof UnifiedExecError ? error.debug() : error instanceof Error ? error.message : String(error);
    throw new Error(`exec_command failed for ${shlexJoin(argv)}: ${detail}`);
  }
}

export async function writeStdinTool(input: WriteStdinInput) {
  if (!Number.isSafeInteger(input.session_id) || input.session_id < 1) throw new Error('session_id must be a positive integer');
  try {
    const output = await unifiedExecManager.writeStdin({
      processId: input.session_id,
      input: input.chars ?? '',
      yieldTimeMs: input.yield_time_ms ?? DEFAULT_WRITE_STDIN_YIELD_TIME_MS,
      maxOutputTokens: undefined,
      truncationPolicy: EXEC_TRUNCATION
    });
    return ok(execCommandResponseText(output), execCommandStructuredOutput(output));
  } catch (error) {
    const retry = error instanceof UnifiedExecError && error.kind === 'write_to_stdin'
      ? ` Retry this same session_id (${input.session_id}); do not replace it with a new command.`
      : '';
    throw new Error(`write_stdin failed: ${error instanceof Error ? error.message : String(error)}${retry}`);
  }
}
