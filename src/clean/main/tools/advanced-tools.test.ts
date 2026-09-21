import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Root } from '../../../shared/types.js';
import { archiveTool } from './archive.js';
import { ZipFile } from './archive/zipfile.js';
import { jsonTool } from './json.js';
import { skillTool } from './skill.js';
import { projectTool } from './project.js';
import { symbolsTool } from './symbols.js';
import { testTool } from './test.js';
import { remapCompilerLibPath, resolveCompilerLibDir, typecheckTool } from './typecheck.js';

let dir = '';
let roots: Root[] = [];

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text ?? '' : '';
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent as Record<string, unknown>
    : {};
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-advanced-'));
  roots = [{ name: 'project', path: await fs.realpath(dir) }];
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('archive tool', () => {
  it('creates, lists, reads and safely extracts a ZIP inside approved roots', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello archive\nline two\n', 'utf8');
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, 'nested', 'b.txt'), 'nested content\n', 'utf8');

    const created = await archiveTool(roots, {
      action: 'create',
      path: '/project/bundle.zip',
      source: ['/project/a.txt', '/project/nested']
    }, true);
    expect(resultText(created)).toContain('bundle.zip');
    expect(structured(created).format).toBe('ZIP');

    const listed = await archiveTool(roots, { action: 'list', path: '/project/bundle.zip' }, true);
    expect(resultText(listed)).toContain('a.txt');
    expect(resultText(listed)).toContain('nested/b.txt');
    expect(String(structured(listed).text)).toContain('nested/b.txt');

    const read = await archiveTool(roots, { action: 'read', path: '/project/bundle.zip', entry: 'a.txt' }, true);
    expect(resultText(read)).toContain('hello archive');
    expect(resultText(read)).toContain('End of entry');

    const extracted = await archiveTool(roots, {
      action: 'extract',
      path: '/project/bundle.zip',
      destination: '/project/extracted'
    }, true);
    expect(resultText(extracted)).toContain('Extracted 2 files');
    expect(await fs.readFile(path.join(dir, 'extracted', 'nested', 'b.txt'), 'utf8')).toBe('nested content\n');
  });

  it('blocks traversal entries and never writes outside the extraction destination', async () => {
    const bytes = await ZipFile.zipToBuffer([
      { name: '../evil.txt', data: new TextEncoder().encode('pwned'), date: new Date() },
      { name: 'ok.txt', data: new TextEncoder().encode('fine'), date: new Date() }
    ]);
    await fs.writeFile(path.join(dir, 'malicious.zip'), bytes);

    const result = await archiveTool(roots, {
      action: 'extract',
      path: '/project/malicious.zip',
      destination: '/project/out'
    }, true);
    expect(resultText(result)).toContain('1 unsafe paths');
    expect(await fs.readFile(path.join(dir, 'out', 'ok.txt'), 'utf8')).toBe('fine');
    await expect(fs.stat(path.join(dir, 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips tar.gz and refuses write actions when write permission is off', async () => {
    await fs.mkdir(path.join(dir, 'docs'));
    await fs.writeFile(path.join(dir, 'docs', 'readme.md'), '# Docs\n', 'utf8');
    await archiveTool(roots, {
      action: 'create',
      path: '/project/docs.tar.gz',
      source: ['/project/docs']
    }, true);
    const list = await archiveTool(roots, { action: 'list', path: '/project/docs.tar.gz' }, true);
    expect(structured(list).format).toBe('gzip (tar)');
    expect(resultText(list)).toContain('docs/readme.md');
    await archiveTool(roots, {
      action: 'extract',
      path: '/project/docs.tar.gz',
      destination: '/project/tgz-out'
    }, true);
    expect(await fs.readFile(path.join(dir, 'tgz-out', 'docs', 'readme.md'), 'utf8')).toBe('# Docs\n');

    await expect(archiveTool(roots, {
      action: 'create',
      path: '/project/refused.zip',
      source: ['/project/docs']
    }, false)).rejects.toThrow(/requires write access/i);
    await expect(archiveTool(roots, {
      action: 'extract',
      path: '/project/docs.tar.gz',
      destination: '/project/refused-out'
    }, false)).rejects.toThrow(/requires write access/i);
  });
});

describe('json tool', () => {
  const sample = `{
  "name": "acme",
  "version": "1.2.3",
  "users": [
    { "id": 1, "name": "alice", "active": true },
    { "id": 2, "name": "bob", "active": false }
  ]
}`;

  it('scaffolds, queries, searches and infers schema without whole-file tool choreography', async () => {
    await fs.writeFile(path.join(dir, 'app.json'), sample, 'utf8');
    const scaffold = await jsonTool(roots, { mode: 'scaffold', filePath: '/project/app.json' }, true);
    expect(resultText(scaffold)).toContain('<json-scaffold');
    expect(resultText(scaffold)).toContain('path=$.users[0].name');
    expect(resultText(scaffold)).toContain('ptr=/users/0/name');

    const query = await jsonTool(roots, { mode: 'query', filePath: '/project/app.json', path: '$.users[0].name' }, true);
    expect(resultText(query)).toContain('alice');
    expect(structured(query).found).toBe(true);

    const search = await jsonTool(roots, { mode: 'search', filePath: '/project/app.json', query: 'active' }, true);
    expect(resultText(search)).toContain('reason="key"');

    const schema = await jsonTool(roots, { mode: 'schema', filePath: '/project/app.json' }, true);
    expect(resultText(schema)).toContain('&quot;type&quot;: &quot;object&quot;');
    expect(resultText(schema)).toContain('users');
  });

  it('supports JSONC and JSONL plus inline jsonText', async () => {
    await fs.writeFile(path.join(dir, 'config.jsonc'), '{\n // note\n "a": 1,\n}\n', 'utf8');
    const jsonc = await jsonTool(roots, { mode: 'query', filePath: '/project/config.jsonc', path: '$.a' }, true);
    expect(resultText(jsonc)).toContain('\n1\n');

    await fs.writeFile(path.join(dir, 'rows.jsonl'), '{"id":1}\n{"id":2}\n', 'utf8');
    const jsonl = await jsonTool(roots, { mode: 'query', filePath: '/project/rows.jsonl', path: '$[1].id' }, true);
    expect(resultText(jsonl)).toContain('\n2\n');

    const inline = await jsonTool(roots, { mode: 'query', jsonText: '{"a":{"b":[10,20]}}', path: '$.a.b[1]' }, false);
    expect(resultText(inline)).toContain('20');
  });

  it('keeps format/patch dry-run by default, applies verified writes, and honors write permission', async () => {
    const file = path.join(dir, 'app.json');
    await fs.writeFile(file, sample, 'utf8');
    const ops = [
      { op: 'replace', path: '/version', value: '2.0.0' },
      { op: 'add', path: '/users/-', value: { id: 3, name: 'carol', active: true } }
    ];

    const dry = await jsonTool(roots, { mode: 'patch', filePath: '/project/app.json', patch: ops }, true);
    expect(resultText(dry)).toContain('written="false"');
    expect(await fs.readFile(file, 'utf8')).toBe(sample);

    const applied = await jsonTool(roots, { mode: 'patch', filePath: '/project/app.json', patch: ops, dryRun: false }, true);
    expect(resultText(applied)).toContain('written="true"');
    const next = JSON.parse(await fs.readFile(file, 'utf8')) as { version: string; users: unknown[] };
    expect(next.version).toBe('2.0.0');
    expect(next.users).toHaveLength(3);

    await expect(jsonTool(roots, { mode: 'format', filePath: '/project/app.json', indent: 0, dryRun: false }, false))
      .rejects.toThrow(/require write access/i);
  });

  it('preserves CRLF when JSON format/patch rewrites a text document', async () => {
    const file = path.join(dir, 'crlf.json');
    await fs.writeFile(file, '{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n', 'utf8');
    await jsonTool(roots, {
      mode: 'patch',
      filePath: '/project/crlf.json',
      patch: [{ op: 'replace', path: '/a', value: 3 }],
      dryRun: false
    }, true);
    const next = await fs.readFile(file, 'utf8');
    expect(JSON.parse(next)).toEqual({ a: 3, b: 2 });
    expect(next).toContain('\r\n');
    expect(next.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('preserves mixed local line-ending topology across whole-file JSON rewrites', async () => {
    const file = path.join(dir, 'mixed-eol.json');
    await fs.writeFile(file, '{\r\n  "a": 1,\n  "b": 2\r\n}\n', 'utf8');
    await jsonTool(roots, {
      mode: 'patch',
      filePath: '/project/mixed-eol.json',
      patch: [{ op: 'replace', path: '/a', value: 3 }],
      dryRun: false
    }, true);
    expect(await fs.readFile(file, 'utf8')).toBe('{\r\n  "a": 3,\n  "b": 2\r\n}\n');
  });

  it('structurally diffs two JSON documents', async () => {
    await fs.writeFile(path.join(dir, 'a.json'), '{"x":1,"keep":true}', 'utf8');
    await fs.writeFile(path.join(dir, 'b.json'), '{"x":2,"keep":true,"new":5}', 'utf8');
    const result = await jsonTool(roots, { mode: 'diff', filePath: '/project/a.json', compareFilePath: '/project/b.json' }, true);
    expect(resultText(result)).toContain('<json-diff changes="2"');
    expect(resultText(result)).toContain('kind="changed"');
    expect(resultText(result)).toContain('kind="added"');
  });
});

describe('skill tool', () => {
  it('progressively lists/searches and loads discovered skills with virtual resource paths', async () => {
    const skillDir = path.join(dir, 'skills', 'tool-skill');
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: tool-skill',
      'description: Skill for local MCP tests.',
      '---',
      '',
      '# Tool Skill',
      '',
      'Use this skill carefully.'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(skillDir, 'scripts', 'demo.txt'), 'demo', 'utf8');

    const list = await skillTool(roots, { mode: 'list' });
    expect(resultText(list)).toContain('tool-skill');
    expect(resultText(list)).not.toContain('Use this skill carefully.');

    const search = await skillTool(roots, { mode: 'search', query: 'local MCP' });
    expect(resultText(search)).toContain('tool-skill');

    const loaded = await skillTool(roots, { name: 'tool_skill' });
    expect(resultText(loaded)).toContain('<skill_content name="tool-skill">');
    expect(resultText(loaded)).toContain('Use this skill carefully.');
    expect(resultText(loaded)).toContain('Base directory for this skill: /project/skills/tool-skill');
    expect(resultText(loaded)).toContain('/project/skills/tool-skill/scripts/demo.txt');
    expect(structured(loaded).names).toEqual(['tool-skill']);
  });

  it('loads an approved ad-hoc skill path, retains it by name, and batches known skills', async () => {
    const adhoc = path.join(dir, 'misc', 'adhoc');
    const second = path.join(dir, 'skills', 'second');
    await fs.mkdir(adhoc, { recursive: true });
    await fs.mkdir(second, { recursive: true });
    await fs.writeFile(path.join(adhoc, 'SKILL.md'), '---\nname: adhoc-skill\ndescription: Imported explicitly.\n---\n\nAdhoc instructions.\n', 'utf8');
    await fs.writeFile(path.join(second, 'SKILL.md'), '---\nname: second-skill\ndescription: Second skill.\n---\n\nSecond instructions.\n', 'utf8');

    const direct = await skillTool(roots, { filePath: '/project/misc/adhoc' });
    expect(resultText(direct)).toContain('Adhoc instructions.');
    const byName = await skillTool(roots, { name: 'adhoc-skill' });
    expect(resultText(byName)).toContain('Adhoc instructions.');

    const batch = await skillTool(roots, { names: ['adhoc-skill', 'second-skill'] });
    expect(resultText(batch)).toContain('Adhoc instructions.');
    expect(resultText(batch)).toContain('Second instructions.');
    expect(structured(batch).count).toBe(2);
  });

  it('refuses a skill path outside approved roots', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-outside-skill-'));
    try {
      await fs.writeFile(path.join(outside, 'SKILL.md'), '---\nname: outside\n---\nsecret instructions\n', 'utf8');
      await expect(skillTool(roots, { filePath: path.join(outside, 'SKILL.md') })).rejects.toThrow(/not inside an approved folder/i);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('project tool', () => {
  it('maps stack, scripts, entry points and structure without source-body reads', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.mkdir(path.join(dir, 'node_modules', 'ignored-package'), { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      packageManager: 'npm@10.9.8',
      scripts: { test: 'vitest run', build: 'vite build' },
      dependencies: { react: '^19.0.0' },
      devDependencies: { typescript: '^5.9.0', vitest: '^4.0.0', vite: '^7.0.0' }
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(dir, 'src', 'index.ts'), 'export const SOURCE_SECRET = "must-not-be-rendered";\n', 'utf8');
    await fs.writeFile(path.join(dir, 'node_modules', 'ignored-package', 'index.js'), 'ignored', 'utf8');

    const summary = await projectTool(roots, { action: 'summary' }, false);
    const rendered = resultText(summary);
    expect(rendered).toContain('ecosystem="node"');
    expect(rendered).toContain('frameworks="React, Vite, TypeScript, Vitest"');
    expect(rendered).toContain('<script name="test">vitest run</script>');
    expect(rendered).toContain('<file>src/index.ts</file>');
    expect(rendered).not.toContain('SOURCE_SECRET');
    expect(structured(summary).files).toBe(2);

    const structure = await projectTool(roots, { tier: 'structure', depth: 3 }, false);
    expect(resultText(structure)).toContain('<tree depth="3"');
    expect(resultText(structure)).toContain('src/');
    expect(resultText(structure)).not.toContain('node_modules');
  });

  it('reports recently modified files with a bounded count', async () => {
    await fs.writeFile(path.join(dir, 'older.txt'), 'old', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 12));
    await fs.writeFile(path.join(dir, 'newer.txt'), 'new', 'utf8');
    const recent = await projectTool(roots, { action: 'recent', recent: 1 }, false);
    expect(resultText(recent)).toContain('newer.txt');
    expect(resultText(recent)).not.toContain('older.txt');
    expect(structured(recent).recent).toBe(1);
  });
});

describe('symbols tool', () => {
  it('finds definitions, outlines files, and separates attributed from unrelated usages', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'def.ts'), [
      'export function target(value: number) {',
      '  return value + 1;',
      '}',
      'export class Box {',
      '  target(value: number) { return value; }',
      '}'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(dir, 'src', 'use.ts'), [
      "import { target } from './def';",
      'export const answer = target(41);'
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(dir, 'src', 'unrelated.ts'), [
      'const target = 3;',
      'export const other = target + 1;'
    ].join('\n'), 'utf8');

    const search = await symbolsTool(roots, { action: 'search', query: 'target', path: '/project/src' });
    expect(resultText(search)).toContain('name="target" kind="function"');
    expect(structured(search).results).toBeGreaterThan(0);

    const outline = await symbolsTool(roots, { action: 'outline', file: '/project/src/def.ts' });
    expect(resultText(outline)).toContain('<group kind="function">');
    expect(resultText(outline)).toContain('name="Box.target"');

    const usages = await symbolsTool(roots, { action: 'usages', query: 'target', path: '/project/src' });
    expect(resultText(usages)).toContain('<ref file="/project/src/use.ts"');
    expect(resultText(usages)).toContain('<match file="/project/src/unrelated.ts"');
    expect(Number(structured(usages).refs)).toBeGreaterThan(0);
    expect(Number(structured(usages).unattributed)).toBeGreaterThan(0);
  });
});

describe('test tool', () => {
  it('lists node:test files without shell permission and gates execution', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
    await fs.writeFile(path.join(dir, 'math.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('adds', () => assert.equal(1 + 1, 2));"
    ].join('\n'), 'utf8');

    const listed = await testTool(roots, { action: 'list' }, false);
    expect(resultText(listed)).toContain('harness="node"');
    expect(resultText(listed)).toContain('math.test.js');
    await expect(testTool(roots, { action: 'run' }, false)).rejects.toThrow(/requires shell access/i);
  });

  it('runs a focused node:test file and returns parsed counts', async () => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8');
    await fs.writeFile(path.join(dir, 'math.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('adds', () => assert.equal(1 + 1, 2));"
    ].join('\n'), 'utf8');

    const run = await testTool(roots, { action: 'run', path: 'math.test.js', runtime: 'node', timeoutMs: 10_000 }, true);
    expect(resultText(run)).toContain('status="passed"');
    expect(structured(run).passed).toBe(1);
    expect(structured(run).failed).toBe(0);
    expect(structured(run).parsed).toBe(true);
  });
});

describe('typecheck tool', () => {
  it('selects only a complete compiler standard-library directory and fails fast otherwise', async () => {
    const incomplete = path.join(dir, 'compiler-lib-incomplete');
    const complete = path.join(dir, 'compiler-lib-complete');
    await fs.mkdir(incomplete);
    await fs.mkdir(complete);
    for (const name of ['lib.d.ts', 'lib.es5.d.ts', 'lib.dom.d.ts', 'lib.esnext.full.d.ts']) {
      await fs.writeFile(path.join(complete, name), '', 'utf8');
    }

    expect(resolveCompilerLibDir([incomplete, complete])).toBe(path.resolve(complete));
    expect(() => resolveCompilerLibDir([incomplete])).toThrow(/TypeScript standard library is unavailable/);
  });

  it('remaps only TypeScript stdlib declarations away from the packaged compiler directory', () => {
    const runtimeLib = path.join(dir, 'resources', 'app.asar', 'node_modules', 'typescript-compiler', 'lib');
    const packagedLib = path.join(dir, 'resources', 'typescript-compiler-lib');
    expect(remapCompilerLibPath(path.join(runtimeLib, 'lib.dom.d.ts'), runtimeLib, packagedLib))
      .toBe(path.join(packagedLib, 'lib.dom.d.ts'));
    expect(remapCompilerLibPath(path.join(runtimeLib, 'lib.es2023.d.ts'), runtimeLib, packagedLib))
      .toBe(path.join(packagedLib, 'lib.es2023.d.ts'));
    expect(remapCompilerLibPath(path.join(runtimeLib, 'typescript.d.ts'), runtimeLib, packagedLib))
      .toBe(path.join(runtimeLib, 'typescript.d.ts'));
    expect(remapCompilerLibPath(path.join(dir, 'other', 'lib.dom.d.ts'), runtimeLib, packagedLib))
      .toBe(path.join(dir, 'other', 'lib.dom.d.ts'));
  });

  it('reports scoped TypeScript diagnostics and classifies their severity', async () => {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: 'ES2022',
        module: 'CommonJS',
        lib: ['ES2022', 'DOM']
      },
      include: ['src/**/*.ts']
    }), 'utf8');
    await fs.writeFile(path.join(dir, 'src', 'bad.ts'), 'const value: string = 123;\nconsole.log(value);\n', 'utf8');

    const result = await typecheckTool(roots, { mode: 'file', filePath: '/project/src/bad.ts' });
    expect(resultText(result)).not.toContain('code="TS6053"');
    expect(resultText(result)).not.toContain('Cannot find global type');
    expect(resultText(result)).toContain('code="TS2322"');
    expect(resultText(result)).toContain('severity="P1"');
    expect(structured(result).status).toBe('failed');
    expect(Number(structured(result).errors)).toBeGreaterThan(0);
  });

  it('explains a diagnostic without filesystem access', async () => {
    const result = await typecheckTool([], { mode: 'explain', filePath: 'TS2307' });
    expect(resultText(result)).toContain('code="TS2307"');
    expect(resultText(result)).toContain('category="import-resolution"');
    expect(structured(result).status).toBe('passed');
  });
});
