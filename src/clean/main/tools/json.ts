import fs from 'node:fs/promises';
import type { Root } from '../../../shared/types.js';
import { healTextLineEndings } from '../../../shared/text-eol.js';
import { ok, resolveToolPath, truncateUtf8 } from './common.js';
import * as Core from './json/core.js';

export type JsonMode = 'validate' | 'scaffold' | 'query' | 'search' | 'schema' | 'format' | 'patch' | 'diff' | 'stats';

export interface JsonInput {
  mode?: JsonMode;
  filePath?: string;
  jsonText?: string;
  compareFilePath?: string;
  compareJsonText?: string;
  path?: string;
  query?: string;
  type?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  patch?: unknown[];
  indent?: number;
  sortKeys?: boolean;
  dryRun?: boolean;
  maxBytes?: number;
  maxDepth?: number;
  maxObjectKeys?: number;
  maxArrayItems?: number;
  maxNodes?: number;
  maxResults?: number;
}

type LoadedJson = {
  raw: Buffer;
  source: string;
  real?: string;
  virtual?: string;
  fileHint?: string;
};

function boundedInt(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

function preview(text: string, maxBytes = 120_000): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  const clipped = truncateUtf8(text, maxBytes);
  return {
    text: clipped.text + (clipped.truncated ? `\n… truncated at ${maxBytes} bytes` : ''),
    truncated: clipped.truncated,
    bytes
  };
}

async function loadJsonInput(
  roots: readonly Root[],
  filePath: string | undefined,
  jsonText: string | undefined,
  maxBytes: number,
  label: string
): Promise<LoadedJson> {
  if (filePath !== undefined && jsonText !== undefined) throw new Error(`${label}: choose filePath or jsonText, not both`);
  if (jsonText !== undefined) {
    const raw = Buffer.from(jsonText, 'utf8');
    if (raw.length > maxBytes) throw new Error(`${label}: JSON text exceeds maxBytes (${raw.length} > ${maxBytes})`);
    return { raw, source: 'jsonText' };
  }
  if (!filePath) throw new Error(`${label}: either filePath or jsonText is required`);
  const resolved = await resolveToolPath(roots, filePath);
  const stat = await fs.stat(resolved.real);
  if (!stat.isFile()) throw new Error(`${label}: not a file: ${resolved.virtual}`);
  if (stat.size > maxBytes) throw new Error(`${label}: file exceeds maxBytes (${stat.size} > ${maxBytes}): ${resolved.virtual}`);
  const raw = await fs.readFile(resolved.real);
  return { raw, source: resolved.virtual, real: resolved.real, virtual: resolved.virtual, fileHint: resolved.real };
}

async function writeChecked(input: LoadedJson, before: Buffer, after: Buffer | string, writeAllowed: boolean): Promise<void> {
  if (!input.real || !input.virtual) throw new Error('jsonText input cannot be written to disk');
  if (!writeAllowed) throw new Error('TOOL_DISABLED: JSON format/patch writes require write access in localMCP-chat.');
  const current = await fs.readFile(input.real);
  if (!current.equals(before)) {
    throw new Error(`${input.virtual} changed on disk after the JSON operation read it; refusing to overwrite newer contents.`);
  }
  await fs.writeFile(input.real, after);
}

export async function jsonTool(roots: readonly Root[], params: JsonInput, writeAllowed: boolean) {
  const limits: Core.Limits = {
    ...Core.DEFAULT_LIMITS,
    maxBytes: boundedInt(params.maxBytes, Core.DEFAULT_LIMITS.maxBytes, 1, 256 * 1024 * 1024, 'maxBytes'),
    maxDepth: boundedInt(params.maxDepth, Core.DEFAULT_LIMITS.maxDepth, 1, 100, 'maxDepth'),
    maxObjectKeys: boundedInt(params.maxObjectKeys, Core.DEFAULT_LIMITS.maxObjectKeys, 1, 10_000, 'maxObjectKeys'),
    maxArrayItems: boundedInt(params.maxArrayItems, Core.DEFAULT_LIMITS.maxArrayItems, 1, 10_000, 'maxArrayItems'),
    maxNodes: boundedInt(params.maxNodes, Core.DEFAULT_LIMITS.maxNodes, 1, 100_000, 'maxNodes'),
    maxSearchResults: boundedInt(params.maxResults, Core.DEFAULT_LIMITS.maxSearchResults, 1, 5000, 'maxResults')
  };
  const mode: JsonMode = params.mode ?? 'scaffold';
  const input = await loadJsonInput(roots, params.filePath, params.jsonText, limits.maxBytes, 'input');
  const beforeHash = Core.hashText(input.raw);
  const parsed = Core.parseJsonWithDiagnostics(input.raw, input.fileHint);

  if (!parsed.ok) {
    const output = Core.validationXml(parsed, input.source);
    return ok(output, { mode: 'validate', source: input.source, ok: false, bytes: parsed.bytes, beforeHash });
  }

  const value = parsed.value;
  const inputFormat = parsed.format;

  if (mode === 'validate') {
    const output = Core.validationXml(parsed, input.source);
    return ok(output, { mode, source: input.source, ok: true, bytes: parsed.bytes, beforeHash });
  }

  if (mode === 'scaffold') {
    const scaffold = Core.buildScaffold(value, limits);
    const output = Core.scaffoldToXml(scaffold, { source: input.source, bytes: parsed.bytes, parseMs: parsed.parseMs });
    return ok(output, { mode, source: input.source, nodes: scaffold.stats.nodes, truncated: scaffold.stats.truncatedNodes > 0, beforeHash });
  }

  if (mode === 'stats') {
    const scaffold = Core.buildScaffold(value, { ...limits, maxDepth: Math.min(limits.maxDepth, 6), maxNodes: Math.min(limits.maxNodes, 500) });
    const output = [
      `<json-stats source="${Core.escapeXml(input.source)}" bytes="${parsed.bytes}" parseMs="${parsed.parseMs.toFixed(3)}" hash="${beforeHash}">`,
      `  <root type="${Core.typeOfJson(value)}" />`,
      `  <nodes total="${scaffold.stats.nodes}" objects="${scaffold.stats.objects}" arrays="${scaffold.stats.arrays}" primitives="${scaffold.stats.primitives}" maxDepth="${scaffold.stats.maxDepthSeen}" truncated="${scaffold.stats.truncatedNodes}" />`,
      '</json-stats>'
    ].join('\n');
    return ok(output, { mode, source: input.source, nodes: scaffold.stats.nodes, beforeHash });
  }

  if (mode === 'query') {
    const jsonPath = params.path ?? '$';
    const hit = Core.getAtPath(value, jsonPath);
    if (!hit.found) {
      const output = `<json-query path="${Core.escapeXml(jsonPath)}" found="false" />`;
      return ok(output, { mode, source: input.source, found: false, beforeHash });
    }
    const resultPreview = preview(JSON.stringify(hit.value, null, 2));
    const output = [
      `<json-query path="${Core.escapeXml(jsonPath)}" found="true" type="${Core.typeOfJson(hit.value)}" bytes="${resultPreview.bytes}" truncated="${resultPreview.truncated}">`,
      `<value>\n${Core.escapeXml(resultPreview.text)}\n</value>`,
      '</json-query>'
    ].join('\n');
    return ok(output, { mode, source: input.source, found: true, truncated: resultPreview.truncated, beforeHash });
  }

  if (mode === 'search') {
    const results = Core.searchJson(value, params.query ?? '', { type: params.type, maxResults: limits.maxSearchResults });
    const output = Core.searchResultsToXml(results, params.query ?? params.type ?? '');
    return ok(output, { mode, source: input.source, count: results.length, beforeHash });
  }

  if (mode === 'schema') {
    const schema = Core.inferJsonSchema(value, { maxArrayItems: limits.maxArrayItems * 4, maxObjectKeys: limits.maxObjectKeys * 4 });
    const text = Core.stableStringify(schema, 2, true);
    const output = `<json-schema source="${Core.escapeXml(input.source)}">\n${Core.escapeXml(text)}\n</json-schema>`;
    return ok(output, { mode, source: input.source, beforeHash });
  }

  if (mode === 'format') {
    const indent = params.indent === 0 ? 0 : boundedInt(params.indent, 2, 0, 16, 'indent');
    const binary = inputFormat === 'bson';
    const serialized = Core.stringifyForFormat(value, inputFormat, indent, Boolean(params.sortKeys));
    const nextContent = binary ? serialized : healTextLineEndings(input.raw.toString('utf8'), serialized);
    const nextForWrite = binary ? Core.bsonSerialize(value) : nextContent;
    const afterHash = Core.hashText(nextForWrite);
    const written = Boolean(input.real && params.dryRun === false);
    if (written) await writeChecked(input, input.raw, nextForWrite, writeAllowed);
    const shown = preview(binary ? `[binary BSON, ${(nextForWrite as Buffer).length} bytes]` : nextContent);
    const note = input.real
      ? written ? 'applied to file' : 'dry run; no file was written. Re-run with dryRun:false to apply.'
      : 'jsonText input; no file write possible';
    const output = [
      `<json-format source="${Core.escapeXml(input.source)}" written="${written}" beforeHash="${beforeHash}" afterHash="${afterHash}" bytes="${shown.bytes}" truncated="${shown.truncated}">`,
      `  <note>${Core.escapeXml(note)}</note>`,
      `  <preview>\n${Core.escapeXml(shown.text)}\n  </preview>`,
      '</json-format>'
    ].join('\n');
    return ok(output, { mode, source: input.source, written, beforeHash, afterHash, truncated: shown.truncated });
  }

  if (mode === 'patch') {
    const ops = params.patch ?? [];
    if (!ops.length) throw new Error('patch mode requires a non-empty patch array');
    const nextValue = Core.applyJsonPatch(value, ops);
    const indent = boundedInt(params.indent, 2, 0, 16, 'indent');
    const binary = inputFormat === 'bson';
    const serialized = Core.stringifyForFormat(nextValue, inputFormat, indent, Boolean(params.sortKeys));
    const nextContent = binary ? serialized : healTextLineEndings(input.raw.toString('utf8'), serialized);
    const nextForWrite = binary ? Core.bsonSerialize(nextValue) : nextContent;
    const afterHash = Core.hashText(nextForWrite);
    const written = Boolean(input.real && params.dryRun === false);
    if (written) await writeChecked(input, input.raw, nextForWrite, writeAllowed);
    const note = input.real
      ? written ? 'applied to file' : 'dry run; no file was written. Re-run with dryRun:false to apply.'
      : 'jsonText input; no file write possible';
    const output = [
      `<json-patch source="${Core.escapeXml(input.source)}" ops="${ops.length}" written="${written}" beforeHash="${beforeHash}" afterHash="${afterHash}">`,
      `  <note>${Core.escapeXml(note)}</note>`,
      ...ops.slice(0, 200).map((op, index) => {
        const row = op as { op?: unknown; path?: unknown };
        return `  <op index="${index + 1}" kind="${Core.escapeXml(row.op)}" path="${Core.escapeXml(row.path)}" />`;
      }),
      ops.length > 200 ? `  <note>${ops.length - 200} additional operations omitted from preview</note>` : '',
      '</json-patch>'
    ].filter(Boolean).join('\n');
    return ok(output, { mode, source: input.source, ops: ops.length, written, beforeHash, afterHash });
  }

  if (mode === 'diff') {
    const other = await loadJsonInput(roots, params.compareFilePath, params.compareJsonText, limits.maxBytes, 'compare input');
    const otherParsed = Core.parseJsonWithDiagnostics(other.raw, other.fileHint);
    if (!otherParsed.ok) {
      const output = Core.validationXml(otherParsed, other.source);
      return ok(output, { mode, source: input.source, compareSource: other.source, ok: false, beforeHash });
    }
    const diffs = Core.diffJson(value, otherParsed.value, { maxDiffs: limits.maxDiffs });
    const output = Core.diffToXml(diffs);
    return ok(output, { mode, source: input.source, compareSource: other.source, count: diffs.length, beforeHash });
  }

  throw new Error(`Unsupported JSON mode: ${mode}`);
}
