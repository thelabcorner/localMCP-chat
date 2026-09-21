import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { instructions, paginateToolList, startMcpServer } from './mcp.js';
import { DEFAULT_CONFIG, initConfig, saveConfig } from './state.js';
import { toolSurfaceFingerprint } from './tools/registry.js';
import { ZipFile } from './tools/archive/zipfile.js';

describe('tools/list pagination', () => {
  it('pages by serialized bytes without making later tools unreachable', () => {
    const tools = Array.from({ length: 120 }, (_, index) => ({
      name: `tool_${index}`,
      description: `description-${index}-${'x'.repeat(80)}`,
      inputSchema: { type: 'object' as const, properties: { value: { type: 'string' } } },
    }));
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = paginateToolList(tools, cursor, 1024);
      names.push(...page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(names).toEqual(tools.map((tool) => tool.name));
  });

  it('rejects a cursor after the tool projection changes instead of silently skipping tools', () => {
    const tools = Array.from({ length: 10 }, (_, index) => ({
      name: `tool_${index}`,
      inputSchema: { type: 'object' as const, properties: {} },
    }));
    const first = paginateToolList(tools, undefined, 150);
    expect(first.nextCursor).toBeDefined();
    expect(() => paginateToolList([...tools, { name: 'new_tool', inputSchema: { type: 'object' as const, properties: {} } }], first.nextCursor, 150))
      .toThrow(/stale tools\/list cursor/i);
  });
});

describe('model-facing authority instructions', () => {
  it('prevents invented localMCP safety refusals while preserving real authority boundaries', () => {
    const text = instructions({
      ...DEFAULT_CONFIG,
      roots: [{ name: 'project', path: process.cwd() }],
      permissions: { read: true, write: true, shell: true, git: true, plugins: false, filesReceive: false, filesSend: false },
    });
    expect(text).toMatch(/Do not invent or infer a localMCP "safety layer"/i);
    expect(text).toMatch(/creating disposable test accounts/i);
    expect(text).toMatch(/temporary session cookies\/tokens/i);
    expect(text).toMatch(/does not authorize capture or reuse of unrelated third-party or ChatGPT browser credentials/i);
    expect(text).toMatch(/attribute that boundary to the model\/platform rather than localMCP/i);
  });
});

describe('localMCP-chat MCP transport', () => {
  it('preserves model-facing text when ChatGPT consumes structured tool results', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-mcp-root-'));
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-mcp-state-'));
    const canonical = await fs.realpath(root);
    await fs.writeFile(path.join(canonical, 'sample.txt'), 'transport-visible-text\n', 'utf8');
    await fs.mkdir(path.join(canonical, 'src'), { recursive: true });
    await fs.mkdir(path.join(canonical, 'tests'), { recursive: true });
    await fs.mkdir(path.join(canonical, 'skills', 'demo-skill'), { recursive: true });
    await fs.writeFile(path.join(canonical, 'package.json'), JSON.stringify({
      name: 'transport-fixture',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.1.11', typescript: '^5.9.3' }
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(canonical, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', skipLibCheck: true },
      include: ['src/**/*.ts']
    }, null, 2), 'utf8');
    await fs.writeFile(path.join(canonical, 'src', 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n', 'utf8');
    await fs.writeFile(path.join(canonical, 'tests', 'math.test.ts'), "import { describe, expect, it } from 'vitest';\ndescribe('math', () => it('adds', () => expect(1 + 1).toBe(2)));\n", 'utf8');
    await fs.writeFile(path.join(canonical, 'data.json'), '{"users":[{"name":"alice"}]}\n', 'utf8');
    await fs.writeFile(path.join(canonical, 'skills', 'demo-skill', 'SKILL.md'), [
      '---',
      'name: demo-skill',
      'description: MCP transport skill fixture.',
      '---',
      '',
      'Use the transport fixture.'
    ].join('\n'), 'utf8');
    const zip = await ZipFile.zipToBuffer([
      { name: 'inside.txt', data: new TextEncoder().encode('archive-visible-text\n'), date: new Date() }
    ]);
    await fs.writeFile(path.join(canonical, 'fixture.zip'), zip);

    await initConfig(state);
    await saveConfig({
      connectorName: 'localMCP-transport-test',
      roots: [{ name: 'project', path: canonical }],
      permissions: { read: true, write: false, shell: false, git: false, plugins: false, filesReceive: false, filesSend: false },
      tunnel: { ...DEFAULT_CONFIG.tunnel },
      preferences: { ...DEFAULT_CONFIG.preferences }
    });

    const endpoint = await startMcpServer();
    const client = new Client({ name: 'localmcp-chat-smoke', version: '1.0.0' });
    try {
      const endpointUrl = new URL(endpoint.url);
      const metadataUrl = new URL(`/.well-known/oauth-protected-resource${endpointUrl.pathname}`, endpointUrl.origin);
      const metadataResponse = await fetch(metadataUrl);
      expect(metadataResponse.ok).toBe(true);
      const metadata = await metadataResponse.json() as { resource_name?: string };
      expect(metadata.resource_name).toBe('localMCP-transport-test');

      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      expect(client.getServerVersion()?.name).toBe('localMCP-transport-test');
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'read', 'find', 'archive', 'json', 'skill', 'project', 'symbols', 'test', 'typecheck',
        'integration', 'opencode_info', 'opencode_session', 'opencode_worker', 'opencode_request'
      ]);
      const deniedIntegration = await client.callTool({ name: 'integration', arguments: { action: 'list' } });
      expect(deniedIntegration.isError).toBe(true);
      expect(deniedIntegration.content?.[0]?.type === 'text' ? deniedIntegration.content[0].text : '').toMatch(/integrations are disabled/i);
      const archive = listed.tools.find((tool) => tool.name === 'archive');
      const action = (archive?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.action;
      expect(action?.enum).toEqual(['list', 'read']);
      const testTool = listed.tools.find((tool) => tool.name === 'test');
      const testAction = (testTool?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.action;
      expect(testAction?.enum).toEqual(['list']);
      const typecheck = listed.tools.find((tool) => tool.name === 'typecheck');
      const typecheckMode = (typecheck?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined)?.mode;
      expect(typecheckMode?.enum).not.toContain('changed');

      const result = await client.callTool({ name: 'read', arguments: { filePath: '/project/sample.txt' } });
      const first = result.content?.[0];
      expect(first?.type === 'text' ? first.text : '').toContain('transport-visible-text');
      expect(String((result.structuredContent as Record<string, unknown> | undefined)?.text ?? ''))
        .toContain('transport-visible-text');

      const calls: Array<{ name: string; arguments: Record<string, unknown>; contains: string }> = [
        { name: 'archive', arguments: { action: 'list', path: '/project/fixture.zip' }, contains: 'inside.txt' },
        { name: 'json', arguments: { mode: 'query', filePath: '/project/data.json', path: '$.users[0].name' }, contains: 'alice' },
        { name: 'skill', arguments: { mode: 'list' }, contains: 'demo-skill' },
        { name: 'project', arguments: { action: 'summary', workdir: '/project' }, contains: 'frameworks="TypeScript, Vitest"' },
        { name: 'symbols', arguments: { action: 'outline', file: '/project/src/math.ts' }, contains: 'add' },
        { name: 'test', arguments: { action: 'list', workdir: '/project' }, contains: 'tests/math.test.ts' },
        { name: 'typecheck', arguments: { mode: 'file', workdir: '/project', filePath: '/project/src/math.ts' }, contains: 'status="passed"' }
      ];
      for (const call of calls) {
        const toolResult = await client.callTool({ name: call.name, arguments: call.arguments });
        const toolText = toolResult.content?.find((item) => item.type === 'text');
        expect(toolText?.type === 'text' ? toolText.text : '', call.name).toContain(call.contains);
        expect(String((toolResult.structuredContent as Record<string, unknown> | undefined)?.text ?? ''), call.name)
          .toContain(call.contains);
      }
    } finally {
      await client.close().catch(() => undefined);
      await endpoint.stop({ forceAfterMs: 1000 });
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(state, { recursive: true, force: true })
      ]);
    }
  });

  it('advertises listChanged and fingerprints the model-facing tool projection', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-mcp-surface-root-'));
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-mcp-surface-state-'));
    const canonical = await fs.realpath(root);
    await initConfig(state);
    await saveConfig({
      connectorName: 'localMCP-chat',
      roots: [{ name: 'project', path: canonical }],
      permissions: { read: true, write: false, shell: false, git: false, plugins: false, filesReceive: false, filesSend: false },
      tunnel: { ...DEFAULT_CONFIG.tunnel },
      preferences: { ...DEFAULT_CONFIG.preferences }
    });
    const endpoint = await startMcpServer();
    const client = new Client({ name: 'localmcp-chat-list-change', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      const initial = endpoint.toolSurfaceFingerprint;
      expect(initial).toMatch(/^[a-f0-9]{64}$/);
      await saveConfig({
        connectorName: 'localMCP-chat',
        roots: [{ name: 'project', path: canonical }],
        permissions: { read: true, write: true, shell: false, git: false, plugins: false, filesReceive: false, filesSend: false },
        tunnel: { ...DEFAULT_CONFIG.tunnel },
      preferences: { ...DEFAULT_CONFIG.preferences }
      });
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('edit');
      expect(endpoint.toolSurfaceFingerprint).toBe(initial);
    } finally {
      await client.close().catch(() => undefined);
      await endpoint.stop({ forceAfterMs: 1000 });
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(state, { recursive: true, force: true })
      ]);
    }
  });

  it('publishes the permission-scoped file_transfer schema and ChatGPT native file metadata', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-file-surface-root-'));
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'localmcp-chat-file-surface-state-'));
    const canonical = await fs.realpath(root);
    await initConfig(state);
    const activeConfig = await saveConfig({
      connectorName: 'localMCP-file-transfer-test',
      roots: [{ name: 'project', path: canonical }],
      permissions: {
        read: true,
        write: true,
        shell: false,
        git: false,
        plugins: false,
        filesReceive: true,
        filesSend: false,
      },
      tunnel: { ...DEFAULT_CONFIG.tunnel },
      preferences: { ...DEFAULT_CONFIG.preferences },
    });
    expect(toolSurfaceFingerprint(activeConfig)).not.toBe(toolSurfaceFingerprint({
      ...activeConfig,
      permissions: { ...activeConfig.permissions, filesReceive: false },
    }));
    const endpoint = await startMcpServer();
    const client = new Client({ name: 'localmcp-chat-file-surface', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      let transfer = (await client.listTools()).tools.find((entry) => entry.name === 'file_transfer');
      expect(transfer).toBeDefined();
      const properties = transfer?.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(properties.action?.enum).toEqual([
        'save_chatgpt_file',
        'download_openai_file',
        'get_openai_file',
        'list_openai_files',
      ]);
      expect(properties.source_file).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['download_url', 'file_id'],
      });
      expect(Object.keys((properties.source_file?.properties ?? {}) as Record<string, unknown>).sort()).toEqual([
        'download_url', 'file_id', 'file_name', 'mime_type',
      ]);
      expect((transfer as ToolWithMeta)._meta?.['openai/fileParams']).toEqual(['source_file']);

      await saveConfig({
        connectorName: 'localMCP-file-transfer-test',
        roots: [{ name: 'project', path: canonical }],
        permissions: {
          read: true,
          write: false,
          shell: false,
          git: false,
          plugins: false,
          filesReceive: true,
          filesSend: false,
        },
        tunnel: { ...DEFAULT_CONFIG.tunnel },
        preferences: { ...DEFAULT_CONFIG.preferences },
      });
      transfer = (await client.listTools()).tools.find((entry) => entry.name === 'file_transfer');
      expect(((transfer?.inputSchema.properties as Record<string, Record<string, unknown>>)?.action?.enum)).toEqual([
        'get_openai_file', 'list_openai_files',
      ]);
      expect((transfer as ToolWithMeta | undefined)?._meta?.['openai/fileParams']).toBeUndefined();

      await saveConfig({
        connectorName: 'localMCP-file-transfer-test',
        roots: [{ name: 'project', path: canonical }],
        permissions: {
          read: true,
          write: false,
          shell: false,
          git: false,
          plugins: false,
          filesReceive: false,
          filesSend: true,
        },
        tunnel: { ...DEFAULT_CONFIG.tunnel },
        preferences: { ...DEFAULT_CONFIG.preferences },
      });
      transfer = (await client.listTools()).tools.find((entry) => entry.name === 'file_transfer');
      expect(((transfer?.inputSchema.properties as Record<string, Record<string, unknown>>)?.action?.enum)).toEqual([
        'upload_openai_file', 'get_openai_file', 'list_openai_files',
      ]);

      await saveConfig({
        connectorName: 'localMCP-file-transfer-test',
        roots: [{ name: 'project', path: canonical }],
        permissions: {
          read: true,
          write: true,
          shell: false,
          git: false,
          plugins: false,
          filesReceive: false,
          filesSend: false,
        },
        tunnel: { ...DEFAULT_CONFIG.tunnel },
        preferences: { ...DEFAULT_CONFIG.preferences },
      });
      expect((await client.listTools()).tools.some((entry) => entry.name === 'file_transfer')).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await endpoint.stop({ forceAfterMs: 1000 });
      await Promise.all([
        fs.rm(root, { recursive: true, force: true }),
        fs.rm(state, { recursive: true, force: true }),
      ]);
    }
  });
});

interface ToolWithMeta {
  _meta?: Record<string, unknown>;
}
