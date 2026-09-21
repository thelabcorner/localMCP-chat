import { afterEach, describe, expect, it } from 'vitest';
import {
  UnifiedExecProcessManager,
  type ExecCommandRequest,
  type WriteStdinRequest
} from '../../../main/codex/unified-exec.js';

const managers: UnifiedExecProcessManager[] = [];

function request(manager: UnifiedExecProcessManager, script: string, yieldTimeMs = 250): ExecCommandRequest {
  return {
    command: [process.execPath, '-e', script],
    shellType: 'sh',
    hookCommand: `node -e ${JSON.stringify(script)}`,
    processId: manager.allocateProcessId(),
    yieldTimeMs,
    maxOutputTokens: undefined,
    truncationPolicy: { kind: 'tokens', tokens: 10_000 },
    cwd: process.cwd(),
    displayCwd: process.cwd(),
    env: process.env,
    tty: false
  };
}

function poll(processId: number): WriteStdinRequest {
  return {
    processId,
    input: '',
    yieldTimeMs: 250,
    maxOutputTokens: undefined,
    truncationPolicy: { kind: 'tokens', tokens: 10_000 }
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.terminateAllProcesses()));
});

describe('unified exec capacity hardening', () => {
  it('does not let completed unread sessions consume live process capacity', async () => {
    const manager = new UnifiedExecProcessManager(5_000, { maxLiveProcesses: 1 });
    managers.push(manager);

    const firstRequest = request(
      manager,
      `setTimeout(() => { console.log('first-complete'); }, 420)`
    );
    const first = await manager.execCommand(firstRequest);
    expect(first.processId).toBe(firstRequest.processId);

    // The first call returned a live session, then exited without being drained. Historically
    // that stale row still consumed the one available slot forever.
    await sleep(300);

    const secondRequest = request(manager, `console.log('second-ran')`);
    const second = await manager.execCommand(secondRequest);
    expect(second.exitCode).toBe(0);
    expect(second.rawOutput.toString('utf8')).toContain('second-ran');

    // Reaping for admission must not discard the old session's final output/status.
    const drainedFirst = await manager.writeStdin(poll(firstRequest.processId));
    expect(drainedFirst.processId).toBeNull();
    expect(drainedFirst.exitCode).toBe(0);
    expect(drainedFirst.rawOutput.toString('utf8')).toContain('first-complete');
  });

  it('keeps the limit as a circuit breaker for genuinely concurrent live processes', async () => {
    const manager = new UnifiedExecProcessManager(5_000, { maxLiveProcesses: 1 });
    managers.push(manager);

    const firstRequest = request(manager, `setTimeout(() => {}, 10_000)`);
    const first = await manager.execCommand(firstRequest);
    expect(first.processId).toBe(firstRequest.processId);

    const secondRequest = request(manager, `console.log('must-not-run')`);
    await expect(manager.execCommand(secondRequest)).rejects.toMatchObject({
      kind: 'create_process'
    });
    await expect(manager.writeStdin(poll(firstRequest.processId))).resolves.toMatchObject({
      processId: firstRequest.processId
    });
  });

  it('sheds completed output by bytes without losing terminal status', async () => {
    const manager = new UnifiedExecProcessManager(5_000, {
      maxLiveProcesses: 1,
      completedOutputBudgetBytes: 0
    });
    managers.push(manager);

    const firstRequest = request(manager, `setTimeout(() => { console.log('payload-to-shed'); }, 420)`);
    const first = await manager.execCommand(firstRequest);
    expect(first.processId).toBe(firstRequest.processId);
    await sleep(300);

    // Starting another command triggers compaction of the completed first session.
    await manager.execCommand(request(manager, `console.log('trigger-reap')`));
    const drained = await manager.writeStdin(poll(firstRequest.processId));
    expect(drained.processId).toBeNull();
    expect(drained.exitCode).toBe(0);
    expect(drained.rawOutput.length).toBe(0);
    expect(drained.outputOmittedBytes).toBeGreaterThan(0);
  });
});
