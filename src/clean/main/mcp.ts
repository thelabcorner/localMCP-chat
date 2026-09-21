import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Tool } from '@modelcontextprotocol/client';
import { getConfig, type LocalMcpConfig } from './state.js';
import { callTool, toolProjectionFingerprint, toolSurfaceFingerprint, toolsFor } from './tools/registry.js';
import { logError, logInfo, logWarn } from '../../main/logger.js';
import { recordRequest, recordRequestOutcome, recordToolCall } from './metrics.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** MCP list pagination is byte-budgeted, never tool-count-budgeted. */
const TOOL_LIST_PAGE_BYTES = 2 * 1024 * 1024;
const PRODUCT_NAME = 'localMCP-chat';
const VERSION = '0.1.0';
let seenAt: number | null = null;
let toolAt: number | null = null;

export interface McpEndpoint {
  port: number;
  url: string;
  toolSurfaceFingerprint: string;
  stop: (options?: { forceAfterMs?: number }) => Promise<void>;
}

/** The text a failed tool put in its result, for the control window's per-tool error column. */
function firstText(result: { content?: Array<{ type?: string; text?: string }> }): string | null {
  const entry = result.content?.find((item) => item.type === 'text' && typeof item.text === 'string');
  return entry?.text ?? null;
}

export function lastRequestAt(): number | null { return seenAt; }
export function lastToolCallAt(): number | null { return toolAt; }

interface ToolListCursor {
  v: 1;
  offset: number;
  fingerprint: string;
}

function encodeToolListCursor(cursor: ToolListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeToolListCursor(value: string | undefined, fingerprint: string, length: number): number {
  if (value === undefined) return 0;
  // A legitimate cursor is ~150 bytes. Bound hostile decode work by representation size rather
  // than by how many pages/tools exist.
  if (value.length > 1024) throw new Error('Invalid tools/list cursor');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ToolListCursor>;
    if (
      parsed.v !== 1 ||
      parsed.fingerprint !== fingerprint ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset ?? -1) < 0 ||
      (parsed.offset ?? 0) > length
    ) {
      throw new Error('stale');
    }
    return parsed.offset!;
  } catch {
    throw new Error('Invalid or stale tools/list cursor; restart discovery from the first page');
  }
}

/**
 * MCP supports cursor pagination, so large plugin catalogs should be paged by serialized resource
 * cost instead of hiding the Nth tool. `byteBudget` is injectable only for deterministic tests.
 */
export function paginateToolList(
  tools: readonly Tool[],
  cursor?: string,
  byteBudget = TOOL_LIST_PAGE_BYTES
): { tools: Tool[]; nextCursor?: string } {
  const budget = Math.max(1, Math.floor(byteBudget));
  const fingerprint = toolProjectionFingerprint(tools);
  const offset = decodeToolListCursor(cursor, fingerprint, tools.length);
  const page: Tool[] = [];
  let bytes = 0;
  let index = offset;
  while (index < tools.length) {
    const tool = tools[index]!;
    const cost = Buffer.byteLength(JSON.stringify(tool), 'utf8') + 1;
    // One unusually large schema is still reachable. The budget controls page aggregation rather
    // than becoming a per-tool rejection threshold.
    if (page.length > 0 && bytes + cost > budget) break;
    page.push(tool);
    bytes += cost;
    index++;
  }
  return {
    tools: page,
    ...(index < tools.length
      ? { nextCursor: encodeToolListCursor({ v: 1, offset: index, fingerprint }) }
      : {})
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function instructions(config: LocalMcpConfig): string {
  const roots = config.roots.length ? config.roots.map((root) => `/${root.name}`).join(', ') : '(none approved)';
  const hasFileTransfer = toolsFor(config).some((entry) => entry.name === 'file_transfer');
  return [
    `${config.connectorName} is a local coding MCP tunnel powered by ${PRODUCT_NAME}. It has no browser/chat automation and no implicit conversation workspace.`,
    `Approved roots: ${roots}.`,
    'Paths under approved roots may be written as /<root>/path. Relative paths are deterministic only when exactly one root is approved; with multiple roots, name the root explicitly.',
    '',
    'Operation economy:',
    '- read: batch already-known targets with filePaths[] or reads[] rather than separate calls. Large files stream through bounded output windows. Use grep/around/outline instead of whole-file reads.',
    '- edit: use one precise single-file strategy; use edits[] for several non-overlapping edits in one file.',
    '- patch: for 2+ hunks/files/refactors, put the complete coherent change set in ONE patch call. It preflights before writing and rolls back captured preimages on commit failure.',
    '- exec_command: use cmds:[...] for related checks. A still-running command returns session_id; continue that same process with write_stdin until it terminates.',
    '- shell(background:true): for servers/watchers/long tasks with persistent output. Use background read/wait with nextOffset instead of relaunching or rereading old output.',
    '- git: prefer typed status/summary/diff/log/show/stage/restore/commit modes over shelling out.',
    '- archive: list/read archive contents directly instead of extracting or shelling out just to inspect them; extract/create only when the task actually needs filesystem output.',
    ...(hasFileTransfer ? [
      '- file_transfer: use for real file movement instead of shell/base64. save_chatgpt_file consumes only a ChatGPT-native source_file; upload_openai_file returns a public Files API file_id; download_openai_file saves that file_id locally. Never invent file references or signed URLs, and inspect remote state before retrying an ambiguous upload.'
    ] : []),
    '- json: use scaffold/query/search on large structured data instead of reading the entire file. format/patch are dry-run by default.',
    '- skill: list/search returns paginated compact metadata; load only the relevant skill instructions. Batch known skills with names[].',
    '- project: use one summary/structure snapshot before several exploratory reads; it inventories manifests/metadata without opening arbitrary source bodies.',
    '- symbols: use search/outline/usages for TS/JS definitions and references instead of grep when binding identity matters.',
    '- test: list cheaply before broad test execution; run a focused path/name filter when known. Test execution requires shell permission.',
    '- typecheck: prefer file/files/folder scoped diagnostics over full. changed is available only with git permission.',
    '',
    'Read line-number prefixes are display metadata and must never be copied into edits or patches.',
    'A known stale prior read is refused before edit/patch. No prior read is only a warning when the mutation has independent content verification.',
    'Authority provenance: localMCP enforces only its declared approved roots, configured permissions, tool-specific invariants, and explicit tool errors. Do not invent or infer a localMCP "safety layer" from task semantics. Say that localMCP blocked an operation only when a localMCP tool or permission result actually says so.',
    'First-party authentication testing: for software or services the user owns or is developing, ordinary test operations such as creating disposable test accounts, retaining that application\'s own temporary session cookies/tokens, and exercising authenticated HTTP or WebSocket flows are not generically blocked by localMCP when the required tool permissions are enabled. This does not authorize capture or reuse of unrelated third-party or ChatGPT browser credentials.',
    'If a higher-level model or platform policy prevents an otherwise tool-authorized action, attribute that boundary to the model/platform rather than localMCP, quote the actual boundary accurately, and continue with any permitted validation instead of inventing a localMCP refusal.',
    'Installed integrations are available through the stable integration gateway. Use integration list/inspect/call for dynamic third-party MCPs; bundled native integrations may also have fixed direct tools. Previously cached direct third-party tool names remain accepted for compatibility.',
    'After an ambiguous external-tool failure, inspect state before retrying a mutation because the remote operation may already have completed.'
  ].join('\n');
}

function buildServer(config: LocalMcpConfig): McpServer {
  const server = new McpServer(
    { name: config.connectorName, version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: instructions(config) }
  );
  server.server.setRequestHandler('tools/list', async (request) => {
    const listed = toolsFor(getConfig());
    return paginateToolList(listed, request.params?.cursor);
  });
  server.server.setRequestHandler('tools/call', async (request) => {
    toolAt = Date.now();
    const live = getConfig();
    const listed = toolsFor(live);
    const name = request.params.name;
    const definition = listed.find((item) => item.name === name);
    const started = Date.now();
    try {
      const result = await callTool(live, name, request.params.arguments ?? {});
      const projected = server.server.projectCallToolResult(result, definition?.outputSchema);
      recordToolCall({
        name,
        // Tools report a refusal or failure in-band with isError rather than by throwing, so
        // that flag — not the absence of an exception — is what "failed" means here.
        ok: result.isError !== true,
        durationMs: Date.now() - started,
        known: definition !== undefined,
        error: result.isError === true ? firstText(result) : null
      });
      return projected;
    } catch (error) {
      // A throw that escapes callTool's own handling, most likely from output projection.
      recordToolCall({
        name,
        ok: false,
        durationMs: Date.now() - started,
        known: definition !== undefined,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  });
  return server;
}

function jsonError(res: http.ServerResponse, status: number, error: string): void {
  const body = JSON.stringify({ error });
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function boundedBody(req: http.IncomingMessage): Promise<{ body?: unknown; error?: string }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) return { error: 'payload_too_large' };
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return { body: text ? JSON.parse(text) : undefined };
  } catch {
    return { error: 'invalid_json' };
  }
}

function resourceMetadata(resource: string, connectorName: string): string {
  return JSON.stringify({ resource, resource_name: connectorName, authorization_servers: [], scopes_supported: [] });
}

export async function startMcpServer(): Promise<McpEndpoint> {
  seenAt = null;
  toolAt = null;
  const token = randomBytes(32).toString('base64url');
  const basePath = `/mcp/${token}`;
  const metadataPath = `/.well-known/oauth-protected-resource${basePath}`;
  let endpointUrl = '';
  const nodeHandler = toNodeHandler(
    createMcpHandler(() => buildServer(getConfig())),
    { onerror: (error) => logError(`MCP handler error: ${error.message}`) }
  );
  const checkHost = localhostHostValidation();
  const checkOrigin = localhostOriginValidation();
  const sockets = new Set<import('node:net').Socket>();
  let stopping = false;

  const server = http.createServer((req, res) => {
    const pathOnly = (req.url ?? '').split('?')[0] ?? '';
    if (safeEqual(pathOnly, metadataPath)) {
      if (!checkHost(req, res) || !checkOrigin(req, res)) return;
      const body = resourceMetadata(endpointUrl, getConfig().connectorName);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (!safeEqual(pathOnly, basePath)) { jsonError(res, 404, 'not_found'); return; }
    if (!checkHost(req, res) || !checkOrigin(req, res)) return;
    seenAt = Date.now();
    recordRequest();
    const declared = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) { jsonError(res, 413, 'payload_too_large'); return; }
    const started = Date.now();
    res.once('finish', () => {
      const method = req.method ?? '?';
      const optional405 = res.statusCode === 405 && (method === 'GET' || method === 'DELETE');
      const line = `${method} mcp/${getConfig().connectorName} -> ${res.statusCode} in ${Date.now() - started}ms`;
      if (optional405 || res.statusCode < 400) logInfo(line);
      else { logWarn(line); recordRequestOutcome(res.statusCode); }
    });
    if (req.method === 'POST' && req.headers['content-length'] === undefined) {
      void boundedBody(req).then((parsed) => {
        if (parsed.error) { jsonError(res, parsed.error === 'payload_too_large' ? 413 : 400, parsed.error); return; }
        void nodeHandler(req, res, parsed.body);
      });
      return;
    }
    void nodeHandler(req, res);
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 300_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('MCP server did not bind a TCP port');
  endpointUrl = `http://127.0.0.1:${address.port}${basePath}`;
  logInfo(`local MCP server listening on 127.0.0.1:${address.port}`);

  return {
    port: address.port,
    url: endpointUrl,
    toolSurfaceFingerprint: toolSurfaceFingerprint(getConfig()),
    stop: async ({ forceAfterMs } = {}) => {
      if (stopping) return;
      stopping = true;
      await new Promise<void>((resolve) => {
        const force = forceAfterMs ? setTimeout(() => { for (const socket of sockets) socket.destroy(); resolve(); }, forceAfterMs) : null;
        server.close(() => { if (force) clearTimeout(force); resolve(); });
      });
    }
  };
}
