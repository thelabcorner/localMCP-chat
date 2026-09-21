import fs from 'node:fs/promises';
import path from 'node:path';
import type { Dirent } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Root } from '../../../shared/types.js';
import { MAX_MODEL_OUTPUT_BYTES, ok, resolveToolPath, truncateUtf8 } from './common.js';

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_SKILL_FILES = 10;
const DISCOVERY_CACHE_MS = 15_000;
const SKILL_MD_CANDIDATES = ['SKILL.md', 'skill.md', 'Skill.md'];
const SKILL_DIR_CANDIDATES = [
  'skills',
  'skill',
  'agent-skills',
  'agent_skills',
  '.skills',
  '.agent-skills',
  'custom-skills',
  '.opencode/skill',
  '.opencode/skills',
  '.agents/skills',
  '.claude/skills',
  '.codex/skills'
];
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', '.cache', 'release', 'out']);

export interface SkillInput {
  mode?: 'load' | 'list' | 'search';
  name?: string;
  names?: string[];
  filePath?: string;
  query?: string;
  tags?: string[];
  offset?: number;
  limit?: number;
}

interface SkillInfo {
  name: string;
  description?: string;
  realLocation: string;
  virtualLocation: string;
  realBase: string;
  virtualBase: string;
  content: string;
  source: 'discovery' | 'path';
}

interface DiscoveryCache {
  key: string;
  at: number;
  skills: SkillInfo[];
}

let discoveryCache: DiscoveryCache | undefined;
const imported = new Map<string, SkillInfo>();

async function currentImports(roots: readonly Root[]): Promise<SkillInfo[]> {
  const active: SkillInfo[] = [];
  for (const [key, info] of imported) {
    try {
      const resolved = await resolveToolPath(roots, info.realLocation);
      if (path.resolve(resolved.real) !== path.resolve(info.realLocation)) continue;
      active.push(info);
    } catch {
      imported.delete(key);
    }
  }
  return active;
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function displayName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'imported-skill';
}

function looksLikePath(value: string): boolean {
  const text = value.trim();
  return text.startsWith('/') || text.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(text) || text.includes('/') || text.includes('\\') || /\.md$/i.test(text);
}

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rootCacheKey(roots: readonly Root[]): string {
  return roots.map((root) => `${root.name}:${root.path}`).sort().join('|');
}

function parseFrontmatter(text: string, fallbackName: string): { name: string; description?: string; content: string } {
  const normalized = text.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { name: displayName(fallbackName), content: normalized };
  const firstNewline = normalized.indexOf('\n');
  if (firstNewline < 0) return { name: displayName(fallbackName), content: normalized };
  const close = normalized.slice(firstNewline + 1).search(/^---\s*$/m);
  if (close < 0) return { name: displayName(fallbackName), content: normalized };
  const closeStart = firstNewline + 1 + close;
  const closeEnd = normalized.indexOf('\n', closeStart);
  const yamlText = normalized.slice(firstNewline + 1, closeStart);
  let data: unknown;
  try {
    data = parseYaml(yamlText);
  } catch (error) {
    throw new Error(`Invalid skill frontmatter: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : displayName(fallbackName);
  const description = typeof record.description === 'string' && record.description.trim() ? record.description.trim() : undefined;
  const content = closeEnd < 0 ? '' : normalized.slice(closeEnd + 1);
  return { name, description, content };
}

async function loadSkillFile(realFile: string, virtualFile: string, source: SkillInfo['source']): Promise<SkillInfo> {
  const stat = await fs.stat(realFile);
  if (!stat.isFile()) throw new Error(`Skill markdown is not a file: ${virtualFile}`);
  if (stat.size > MAX_SKILL_BYTES) throw new Error(`Skill markdown is too large (${stat.size} bytes; limit ${MAX_SKILL_BYTES}): ${virtualFile}`);
  const text = await fs.readFile(realFile, 'utf8');
  const fallback = SKILL_MD_CANDIDATES.some((candidate) => candidate.toLowerCase() === path.basename(realFile).toLowerCase())
    ? path.basename(path.dirname(realFile))
    : path.basename(realFile, path.extname(realFile));
  const parsed = parseFrontmatter(text, fallback);
  return {
    name: parsed.name,
    description: parsed.description,
    realLocation: realFile,
    virtualLocation: virtualFile,
    realBase: path.dirname(realFile),
    virtualBase: path.posix.dirname(virtualFile.replace(/\\/g, '/')),
    content: parsed.content,
    source
  };
}

async function resolveSkillMarkdown(roots: readonly Root[], input: string): Promise<{ real: string; virtual: string }> {
  const resolved = await resolveToolPath(roots, input);
  const stat = await fs.stat(resolved.real);
  if (stat.isFile()) {
    if (!/\.(md|markdown)$/i.test(resolved.real)) throw new Error(`Skill path must be markdown: ${resolved.virtual}`);
    return { real: resolved.real, virtual: resolved.virtual };
  }
  if (!stat.isDirectory()) throw new Error(`Skill path is neither a markdown file nor directory: ${resolved.virtual}`);
  for (const candidate of SKILL_MD_CANDIDATES) {
    const real = path.join(resolved.real, candidate);
    try {
      if ((await fs.stat(real)).isFile()) return { real, virtual: `${resolved.virtual}/${candidate}`.replace(/\/{2,}/g, '/') };
    } catch {}
  }
  const markdown = (await fs.readdir(resolved.real, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(md|markdown)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (markdown) return { real: path.join(resolved.real, markdown.name), virtual: `${resolved.virtual}/${markdown.name}`.replace(/\/{2,}/g, '/') };
  throw new Error(`No SKILL.md or other markdown skill file in directory: ${resolved.virtual}`);
}

async function scanSkillDirectory(realRoot: string, virtualRoot: string, out: Map<string, SkillInfo>): Promise<void> {
  const stack = [{ real: realRoot, virtual: virtualRoot }];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir.real, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const real = path.join(dir.real, entry.name);
      const virtual = `${dir.virtual}/${entry.name}`.replace(/\/{2,}/g, '/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push({ real, virtual });
        continue;
      }
      if (!entry.isFile() || !SKILL_MD_CANDIDATES.some((candidate) => candidate.toLowerCase() === entry.name.toLowerCase())) continue;
      try {
        const info = await loadSkillFile(real, virtual, 'discovery');
        const key = normalizedName(info.name);
        if (!out.has(key)) out.set(key, info);
      } catch {}
    }
  }
}

async function discover(roots: readonly Root[]): Promise<SkillInfo[]> {
  const key = rootCacheKey(roots);
  if (discoveryCache && discoveryCache.key === key && Date.now() - discoveryCache.at < DISCOVERY_CACHE_MS) {
    const combined = new Map(discoveryCache.skills.map((info) => [normalizedName(info.name), info]));
    for (const info of await currentImports(roots)) combined.set(normalizedName(info.name), info);
    return [...combined.values()];
  }
  const found = new Map<string, SkillInfo>();
  for (const root of roots) {
    const rootResolved = await resolveToolPath(roots, `/${root.name}`);
    for (const candidate of SKILL_MD_CANDIDATES) {
      const real = path.join(rootResolved.real, candidate);
      try {
        if ((await fs.stat(real)).isFile()) {
          const info = await loadSkillFile(real, `/${root.name}/${candidate}`, 'discovery');
          found.set(normalizedName(info.name), info);
          break;
        }
      } catch {}
    }
    for (const relative of SKILL_DIR_CANDIDATES) {
      const real = path.join(rootResolved.real, ...relative.split('/'));
      try {
        if (!(await fs.stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
      await scanSkillDirectory(real, `/${root.name}/${relative}`.replace(/\/{2,}/g, '/'), found);
    }
  }
  discoveryCache = { key, at: Date.now(), skills: [...found.values()] };
  const combined = new Map(found);
  for (const info of await currentImports(roots)) combined.set(normalizedName(info.name), info);
  return [...combined.values()];
}

function tagsMatch(info: SkillInfo, tags: readonly string[] | undefined): boolean {
  if (!tags?.length) return true;
  const haystack = `${info.name} ${info.description ?? ''}`.toLowerCase();
  return tags.every((tag) => haystack.includes(tag.toLowerCase()));
}

function describe(info: SkillInfo): string {
  return `- ${info.name}: ${info.description ?? 'No description.'}`;
}

async function sampleFiles(info: SkillInfo): Promise<string[]> {
  const files: string[] = [];
  const stack = [{ real: info.realBase, virtual: info.virtualBase }];
  let dirs = 0;
  while (stack.length && files.length < MAX_SKILL_FILES && dirs < 200) {
    const dir = stack.pop()!;
    dirs++;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir.real, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const real = path.join(dir.real, entry.name);
      const virtual = `${dir.virtual}/${entry.name}`.replace(/\/{2,}/g, '/');
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push({ real, virtual });
      } else if (entry.isFile() && real !== info.realLocation) {
        files.push(virtual);
        if (files.length >= MAX_SKILL_FILES) break;
      }
    }
  }
  return files;
}

async function renderSkill(info: SkillInfo): Promise<string> {
  const files = await sampleFiles(info);
  const output = [
    `<skill_content name="${xml(info.name)}">`,
    `# Skill: ${info.name}`,
    '',
    info.content.trim(),
    '',
    `Base directory for this skill: ${info.virtualBase}`,
    'Relative paths in this skill (for example scripts/ or references/) are relative to this base directory.',
    'Use the localMCP-chat read tool on those virtual paths when more detail is needed. The file list below is sampled.',
    '',
    '<skill_files>',
    ...files.map((file) => `  <file>${xml(file)}</file>`),
    '</skill_files>',
    '</skill_content>'
  ].join('\n');
  const bounded = truncateUtf8(output, 128 * 1024);
  return bounded.text + (bounded.truncated ? '\n<note>Skill content truncated; read the SKILL.md directly for the remainder.</note>' : '');
}

function findRegistered(all: SkillInfo[], raw: string): SkillInfo | undefined {
  const target = normalizedName(raw);
  const exact = all.find((info) => normalizedName(info.name) === target);
  if (exact) return exact;
  const partial = all.filter((info) => normalizedName(info.name).includes(target) || target.includes(normalizedName(info.name)));
  return partial.length === 1 ? partial[0] : undefined;
}

async function loadOne(roots: readonly Root[], target: string): Promise<SkillInfo> {
  const trimmed = target.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed) throw new Error('Skill name/path is empty');
  if (looksLikePath(trimmed)) {
    const resolved = await resolveSkillMarkdown(roots, trimmed);
    const info = await loadSkillFile(resolved.real, resolved.virtual, 'path');
    imported.set(normalizedName(info.name), info);
    return info;
  }
  const all = await discover(roots);
  const info = findRegistered(all, trimmed);
  if (info) {
    const resolved = await resolveToolPath(roots, info.realLocation);
    return loadSkillFile(resolved.real, resolved.virtual, info.source);
  }
  const suggestions = all
    .filter((candidate) => normalizedName(candidate.name).includes(normalizedName(trimmed).slice(0, 4)))
    .slice(0, 12)
    .map(describe)
    .join('\n');
  throw new Error(
    `Skill "${trimmed}" not found in approved roots or this process's imported skill registry.` +
    `\n${suggestions ? `Closest available skills:\n${suggestions}\n` : ''}` +
    'Use skill({mode:"list"}) or pass filePath to a SKILL.md / skill folder inside an approved root.'
  );
}

export async function skillTool(roots: readonly Root[], input: SkillInput) {
  const mode = input.mode ?? 'load';
  if (mode === 'list' || mode === 'search') {
    const query = input.query?.trim().toLowerCase();
    const all = (await discover(roots))
      .filter((info) => tagsMatch(info, input.tags))
      .filter((info) => !query || info.name.toLowerCase().includes(query) || (info.description ?? '').toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
    const offset = Number.isSafeInteger(input.offset) && (input.offset ?? 0) >= 0 ? input.offset! : 0;
    const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? input.limit! : 100;
    const shown = all.slice(offset, offset + limit);
    const nextOffset = offset + shown.length < all.length ? offset + shown.length : null;
    const output = [
      `<skills mode="${mode}" count="${all.length}" offset="${offset}" truncated="${nextOffset !== null}">`,
      ...shown.map((info) => `  ${describe(info)}`),
      '</skills>',
      nextOffset !== null ? `Continue with offset=${nextOffset}.` : all.length ? 'Load only the matching skill(s) you need; names[] batches known loads in one call.' : 'No skills matched inside the approved roots.'
    ].join('\n');
    return ok(output, { mode, count: all.length, names: shown.map((info) => info.name), offset, nextOffset, truncated: nextOffset !== null });
  }

  const targets = [
    ...(input.filePath ? [input.filePath] : []),
    ...(input.names ?? []),
    ...(input.name && !input.filePath ? [input.name] : [])
  ];
  if (targets.length === 0) {
    const all = (await discover(roots)).filter((info) => tagsMatch(info, input.tags)).sort((a, b) => a.name.localeCompare(b.name));
    const output = `No skill name or filePath provided.\n\nAvailable skills:\n${all.map(describe).join('\n') || '(none)'}\n\nUse mode:"list", a registered name, or filePath to a SKILL.md / skill folder inside an approved root.`;
    return ok(output, { mode: 'load', count: all.length, names: all.map((info) => info.name) });
  }
  const loaded: SkillInfo[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    try {
      loaded.push(await loadOne(roots, target));
    } catch (error) {
      failed.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!loaded.length) throw new Error(`No skills loaded:\n${failed.join('\n')}`);
  const bodies = await Promise.all(loaded.map(renderSkill));
  const output = bodies.join('\n\n') + (failed.length ? `\n\n<skill_load_errors>\n${failed.map((item) => `- ${item}`).join('\n')}\n</skill_load_errors>` : '');
  const bounded = truncateUtf8(output, MAX_MODEL_OUTPUT_BYTES);
  return ok(bounded.text + (bounded.truncated ? '\n<note>Combined skill output truncated by the model-output budget; load fewer skills or read their SKILL.md files directly.</note>' : ''), {
    mode: 'load',
    names: loaded.map((info) => info.name),
    count: loaded.length,
    missing: failed,
    bases: loaded.map((info) => info.virtualBase),
    truncated: bounded.truncated
  });
}
