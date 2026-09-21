import { promises as fs } from 'node:fs';
import path from 'node:path';
import { applyPatch as applyUnifiedDiff, parsePatch as parseUnifiedDiff } from 'diff';
import type { Root } from '../../../shared/types.js';
import { healTextLineEndings, needsEolAwarePatchFallback, normalizeTextEolsToLf } from '../../../shared/text-eol.js';
import { resolvePath } from '../../../main/sandbox.js';
import {
  ApplyPatchFailure,
  DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE,
  applyPatchWithMode,
  parsePatch,
  verifyApplyPatchArgs,
  type AppliedPatchDelta,
  type Hunk
} from '../../../main/codex/apply-patch/index.js';
import { ok, readCache, resolveDirectory, truncateUtf8 } from './common.js';

export interface PatchInput {
  patchText?: string;
  patch?: string;
  workdir?: string;
  apply?: boolean | 'if-clean';
  format?: 'auto' | 'opencode' | 'git';
  showDiff?: boolean;
}

export interface Snapshot { bytes: Buffer | null; }
const MAX_ROLLBACK_BYTES = 64 * 1024 * 1024;

async function readOptional(file: string): Promise<Buffer | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`patch target is not a regular file: ${file}`);
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function snapshots(paths: Iterable<string>): Promise<Map<string, Snapshot>> {
  const result = new Map<string, Snapshot>();
  let total = 0;
  for (const file of new Set(paths)) {
    const bytes = await readOptional(file);
    total += bytes?.length ?? 0;
    if (total > MAX_ROLLBACK_BYTES) throw new Error(`patch rollback preimages exceed ${MAX_ROLLBACK_BYTES} bytes; split the patch`);
    result.set(file, { bytes });
  }
  return result;
}

function sameBytes(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

/**
 * Restore captured preimages only while the path still contains either its original bytes or the
 * exact post-state this patch is known to have committed. A concurrent external edit wins: we
 * report an incomplete rollback instead of overwriting newer data with a stale preimage.
 */
export async function restoreCapturedPreimages(snapshot: Map<string, Snapshot>, expectedPost: Map<string, Buffer | null>): Promise<void> {
  const failures: string[] = [];
  for (const [file, entry] of [...snapshot.entries()].reverse()) {
    try {
      const current = await readOptional(file);
      if (sameBytes(current, entry.bytes)) continue;
      const expected = expectedPost.get(file);
      if (!expectedPost.has(file) || !sameBytes(current, expected ?? null)) {
        failures.push(`${file}: changed after the patch wrote it; newer contents were preserved`);
        continue;
      }
      if (entry.bytes === null) await fs.rm(file, { force: true });
      else {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, entry.bytes);
      }
    } catch (error) { failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`patch failed and rollback was incomplete: ${failures.join('; ')}`);
}

function expectedPostFromDelta(delta: AppliedPatchDelta | undefined): Map<string, Buffer | null> {
  const expected = new Map<string, Buffer | null>();
  for (const item of delta?.changes ?? []) {
    const change = item.change;
    if (change.kind === 'add') {
      expected.set(item.path, Buffer.from(change.content, 'utf8'));
    } else if (change.kind === 'delete') {
      expected.set(item.path, null);
    } else if (change.movePath) {
      expected.set(item.path, null);
      expected.set(change.movePath, Buffer.from(change.newContent, 'utf8'));
    } else {
      expected.set(item.path, Buffer.from(change.newContent, 'utf8'));
    }
  }
  return expected;
}

function nativePaths(hunks: readonly Hunk[]): string[] {
  const out: string[] = [];
  for (const hunk of hunks) {
    out.push(hunk.path);
    if (hunk.kind === 'update_file' && hunk.movePath) out.push(hunk.movePath);
  }
  return out;
}

async function resolveNativePaths(roots: readonly Root[], baseVirtual: string, hunks: readonly Hunk[]) {
  const map = new Map<string, { real: string; virtual: string }>();
  for (const hunk of hunks) {
    const source = await resolvePath(roots, hunk.path, { base: baseVirtual, allowMissing: hunk.kind === 'add_file' });
    map.set(hunk.path, source);
    if (hunk.kind === 'update_file' && hunk.movePath) {
      map.set(hunk.movePath, await resolvePath(roots, hunk.movePath, { base: baseVirtual, allowMissing: true }));
    }
  }
  return map;
}

async function checkFresh(paths: Iterable<string>): Promise<string[]> {
  const warnings: string[] = [];
  for (const file of new Set(paths)) {
    if ((await readOptional(file)) === null) continue;
    const fresh = await readCache.freshness(file);
    if (fresh.stale) throw new Error(`Patch target ${file} changed after it was last read. Re-read before patching.`);
    if (fresh.missing) warnings.push(`${file}: no prior read record; patch context is still verified against current contents`);
  }
  return warnings;
}

async function refreshReadCache(paths: Iterable<string>): Promise<void> {
  for (const file of new Set(paths)) {
    try {
      const stat = await fs.stat(file);
      if (stat.isFile()) readCache.record(file, stat);
    } catch {}
  }
}

async function nativePatch(roots: readonly Root[], input: PatchInput, patchText: string) {
  const dir = await resolveDirectory(roots, input.workdir);
  const parsed = parsePatch(patchText);
  if (parsed.environmentId !== null) throw new Error('patch environment selection is not supported');
  const resolved = await resolveNativePaths(roots, dir.virtual, parsed.hunks);
  const realPaths = nativePaths(parsed.hunks).map((spelled) => resolved.get(spelled)!.real);
  const warnings = await checkFresh(realPaths);
  const resolver = (spelled: string): string => {
    const found = resolved.get(spelled);
    if (!found) throw new Error(`unresolved patch path: ${spelled}`);
    return found.real;
  };
  await verifyApplyPatchArgs(parsed, dir.real, DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE, resolver);
  const plan = parsed.hunks.map((hunk) => {
    const source = resolved.get(hunk.path)!;
    if (hunk.kind === 'add_file') return `A ${source.virtual}`;
    if (hunk.kind === 'delete_file') return `D ${source.virtual}`;
    if (hunk.movePath) return `R ${source.virtual} -> ${resolved.get(hunk.movePath)!.virtual}`;
    return `M ${source.virtual}`;
  });
  if (input.apply === false) {
    return ok(`Patch plan (${plan.length} operations):\n${plan.join('\n')}${warnings.length ? `\n\nWarnings:\n${warnings.join('\n')}` : ''}${input.showDiff ? `\n\n${patchText}` : ''}`, {
      applied: false, format: 'opencode', files: plan.length, warnings
    });
  }
  const snap = await snapshots(realPaths);
  const stdout = { text: '' };
  const stderr = { text: '' };
  let delta: AppliedPatchDelta | undefined;
  try {
    delta = await applyPatchWithMode(patchText, DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE, dir.real, stdout, stderr, resolver);
  } catch (error) {
    if (error instanceof ApplyPatchFailure) delta = error.delta;
    try {
      await restoreCapturedPreimages(snap, expectedPostFromDelta(delta));
    } catch (rollbackError) {
      throw new Error(
        `patch failed and rollback could not safely restore every path. ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} Original failure: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw new Error(`patch failed; committed patch writes were safely rolled back. ${error instanceof Error ? error.message : String(error)}`);
  }
  await refreshReadCache(realPaths);
  const summary = truncateUtf8(`${stdout.text}${stderr.text}`.trim() || `Applied ${delta.changes.length} patch changes.`, 96 * 1024).text;
  return ok(`${summary}${warnings.length ? `\n\nWarnings:\n${warnings.join('\n')}` : ''}`, {
    applied: true, format: 'opencode', files: delta.changes.length, warnings
  });
}

function cleanDiffPath(value: string | undefined): string | null {
  if (!value || value === '/dev/null') return null;
  return value.replace(/^[ab]\//, '');
}

interface GitPlan {
  type: 'add' | 'update' | 'delete' | 'move';
  sourceReal?: string;
  sourceVirtual?: string;
  destReal?: string;
  destVirtual?: string;
  after: string | null;
}

async function gitPatch(roots: readonly Root[], input: PatchInput, patchText: string) {
  const dir = await resolveDirectory(roots, input.workdir);
  const parsed = parseUnifiedDiff(patchText);
  if (!parsed.length) throw new Error('git-style diff contains no file patches');
  const plans: GitPlan[] = [];
  const affected: string[] = [];
  const lineEndingRepairs: string[] = [];
  for (const filePatch of parsed) {
    const oldPath = cleanDiffPath(filePatch.oldFileName);
    const newPath = cleanDiffPath(filePatch.newFileName);
    if (!oldPath && !newPath) throw new Error('invalid /dev/null -> /dev/null patch');
    const source = oldPath ? await resolvePath(roots, oldPath, { base: dir.virtual }) : null;
    const dest = newPath ? await resolvePath(roots, newPath, { base: dir.virtual, allowMissing: true }) : null;
    const before = source ? await fs.readFile(source.real, 'utf8') : '';
    if (before.slice(0, 1024).includes('\0')) throw new Error(`binary file cannot be patched as text: ${source?.virtual}`);
    let applied = applyUnifiedDiff(before, filePatch);
    if (applied === false && source && needsEolAwarePatchFallback(before)) {
      const normalized = applyUnifiedDiff(normalizeTextEolsToLf(before), filePatch);
      if (normalized !== false) {
        applied = healTextLineEndings(before, normalized);
        lineEndingRepairs.push(source.virtual);
      }
    } else if (applied !== false && source && needsEolAwarePatchFallback(before)) {
      const rehydrated = healTextLineEndings(before, applied);
      if (rehydrated !== applied) lineEndingRepairs.push(source.virtual);
      applied = rehydrated;
    }
    if (applied === false) throw new Error(`git diff context did not apply cleanly to ${source?.virtual ?? dest?.virtual}`);
    const type: GitPlan['type'] = !source ? 'add' : !dest ? 'delete' : source.real !== dest.real ? 'move' : 'update';
    plans.push({
      type,
      sourceReal: source?.real,
      sourceVirtual: source?.virtual,
      destReal: dest?.real,
      destVirtual: dest?.virtual,
      after: type === 'delete' ? null : applied
    });
    if (source) affected.push(source.real);
    if (dest) affected.push(dest.real);
  }
  const warnings = await checkFresh(plans.flatMap((plan) => plan.sourceReal ? [plan.sourceReal] : []));
  const planText = plans.map((plan) => plan.type === 'move'
    ? `R ${plan.sourceVirtual} -> ${plan.destVirtual}`
    : `${plan.type === 'add' ? 'A' : plan.type === 'delete' ? 'D' : 'M'} ${plan.destVirtual ?? plan.sourceVirtual}`);
  if (input.apply === false) {
    return ok(`Patch plan (${planText.length} operations):\n${planText.join('\n')}${lineEndingRepairs.length ? `\n\nLine endings will be auto-healed in:\n${lineEndingRepairs.join('\n')}` : ''}${input.showDiff ? `\n\n${patchText}` : ''}`, {
      applied: false, format: 'git', files: planText.length, warnings, lineEndingRepairs
    });
  }
  const snap = await snapshots(affected);
  const expectedPost = new Map<string, Buffer | null>();
  try {
    for (const plan of plans) {
      if (plan.type === 'delete') {
        await fs.rm(plan.sourceReal!, { force: true });
        expectedPost.set(plan.sourceReal!, null);
        continue;
      }
      await fs.mkdir(path.dirname(plan.destReal!), { recursive: true });
      await fs.writeFile(plan.destReal!, plan.after ?? '', 'utf8');
      expectedPost.set(plan.destReal!, Buffer.from(plan.after ?? '', 'utf8'));
      if (plan.type === 'move' && plan.sourceReal !== plan.destReal) {
        await fs.rm(plan.sourceReal!, { force: true });
        expectedPost.set(plan.sourceReal!, null);
      }
    }
  } catch (error) {
    try {
      await restoreCapturedPreimages(snap, expectedPost);
    } catch (rollbackError) {
      throw new Error(
        `git-style patch failed and rollback could not safely restore every path. ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)} Original failure: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    throw new Error(`git-style patch failed; committed patch writes were safely rolled back. ${error instanceof Error ? error.message : String(error)}`);
  }
  await refreshReadCache(affected);
  return ok(`Applied ${plans.length} git-style patch operation${plans.length === 1 ? '' : 's'}:\n${planText.join('\n')}${lineEndingRepairs.length ? `\n\nAuto-healed line endings:\n${lineEndingRepairs.join('\n')}` : ''}${warnings.length ? `\n\nWarnings:\n${warnings.join('\n')}` : ''}`, {
    applied: true, format: 'git', files: plans.length, warnings, lineEndingRepairs
  });
}

export async function patchTool(roots: readonly Root[], input: PatchInput) {
  const patchText = input.patchText ?? input.patch;
  if (!patchText?.trim()) throw new Error('patchText (or patch alias) is required');
  const format = input.format === 'auto' || input.format === undefined
    ? patchText.trimStart().startsWith('*** Begin Patch') ? 'opencode' : 'git'
    : input.format;
  return format === 'opencode' ? nativePatch(roots, input, patchText) : gitPatch(roots, input, patchText);
}
