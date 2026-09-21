import { createHash } from 'node:crypto';
import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { pluginManager } from '../../../main/plugins/manager.js';
import type { LocalMcpConfig } from '../state.js';
import { errorText, fail } from './common.js';
import { editTool, type EditInput } from './edit.js';
import { execTool, type ExecInput, type WriteStdinInput, writeStdinTool } from './exec.js';
import { gitTool, type GitInput } from './git.js';
import { patchTool, type PatchInput } from './patch.js';
import { findTool, type FindInput, readTool, type ReadInput } from './read.js';
import { backgroundJobs, shellTool, type BackgroundInput, type ShellInput } from './background.js';
import { archiveTool, type ArchiveInput } from './archive.js';
import { jsonTool, type JsonInput } from './json.js';
import { skillTool, type SkillInput } from './skill.js';
import { projectTool, type ProjectInput } from './project.js';
import { symbolsTool, type SymbolsInput } from './symbols.js';
import { testTool, type TestInput } from './test.js';
import { typecheckTool, type TypecheckInput } from './typecheck.js';
import { fileTransferTool, type FileTransferAction, type FileTransferInput } from './file-transfer.js';
import { integrationTool, type IntegrationInput } from './integration.js';

type JsonSchema = Record<string, unknown>;

function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

type ToolExtras = Partial<Pick<Tool, 'title' | 'annotations' | '_meta'>>;

function tool(name: string, description: string, inputSchema: JsonSchema, extras: ToolExtras = {}): Tool {
  return { name, description, inputSchema: inputSchema as Tool['inputSchema'], ...extras };
}

const FILE_TRANSFER_TOOL_NAME = 'file_transfer';
const INTEGRATION_TOOL_NAME = 'integration';
const FILE_TRANSFER_DESCRIPTION =
  'Move files between ChatGPT/OpenAI file storage and approved local folders without shell or base64. ' +
  'save_chatgpt_file saves a ChatGPT-native source_file to the computer; upload_openai_file uploads an approved local file to the OpenAI Files API; ' +
  'download_openai_file saves a Files API file_id locally; get/list resolve Files API metadata. Never invent source_file values, signed URLs, or file IDs.';

/** FILE_TRANSFER: generate only actions that the current permission combination can actually perform. */
export function fileTransferDefinition(config: LocalMcpConfig): Tool | null {
  const actions: FileTransferAction[] = [];
  const hasLocalRoot = config.roots.length > 0;
  const canSave = config.permissions.filesReceive && config.permissions.write && hasLocalRoot;
  const canUpload = config.permissions.filesSend && config.permissions.read && hasLocalRoot;
  if (canSave) actions.push('save_chatgpt_file', 'download_openai_file');
  if (canUpload) actions.push('upload_openai_file');
  if (config.permissions.filesReceive || config.permissions.filesSend) actions.push('get_openai_file', 'list_openai_files');
  if (!actions.length) return null;

  const properties: Record<string, JsonSchema> = {
    action: { type: 'string', enum: actions },
    source: { type: 'string', description: 'Approved local source path for upload_openai_file.' },
    destination: { type: 'string', description: 'Approved local destination path for save/download. Existing files are never overwritten.' },
    file_id: { type: 'string', description: 'OpenAI Files API file-* identifier for download/get.' },
    purpose: { type: 'string', enum: ['assistants', 'batch', 'fine-tune', 'vision', 'user_data', 'evals'], description: 'OpenAI file purpose. Upload defaults to user_data; list may filter by purpose.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'list_openai_files result bound; defaults to 20.' },
    after: { type: 'string', description: 'Optional OpenAI file cursor/id for list pagination.' },
  };
  if (canSave) {
    properties.source_file = objectSchema({
      download_url: { type: 'string' },
      file_id: { type: 'string' },
      mime_type: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      file_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    }, ['download_url', 'file_id']);
  }
  return tool(
    FILE_TRANSFER_TOOL_NAME,
    FILE_TRANSFER_DESCRIPTION,
    objectSchema(properties, ['action']),
    {
      title: 'Transfer files',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      ...(canSave ? { _meta: { 'openai/fileParams': ['source_file'] } } : {}),
    },
  );
}

const READ_TOOL = tool(
  'read',
  'Read or inspect approved local files. ECONOMY: batch known text targets in filePaths[] or reads[] in ONE call. reads[] supports independent offset/limit windows. Large text files are streamed instead of rejected by file size. For one file, action can be read, tail, grep, around, or outline; grep/outline offset paginates matches. Line-number prefixes are display metadata, not file content.',
  objectSchema({
    filePath: { type: 'string', description: 'Single target path. Relative paths are allowed only when exactly one root is approved.' },
    file_path: { type: 'string', description: 'Alias for filePath.' },
    filePaths: { oneOf: [{ type: 'array', items: { type: 'string' }, minItems: 1 }, { type: 'string' }], description: 'Batch known targets sharing top-level offset/limit.' },
    reads: { type: 'array', minItems: 1, items: objectSchema({ filePath: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 1, description: 'Continue an unusually long line; use with limit=1.' } }, ['filePath']) },
    offset: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, description: 'Requested line/result page size; output remains byte-bounded.' },
    column: { type: 'integer', minimum: 1, description: '1-based continuation offset within the first requested line; action=read with limit=1.' },
    action: { type: 'string', enum: ['read', 'tail', 'grep', 'around', 'outline'] },
    pattern: { type: 'string', description: 'Regex/literal pattern for grep; implies grep when action is omitted.' },
    symbol: { type: 'string', description: 'Symbol to jump around; implies around when action is omitted.' }
  })
);

const FIND_TOOL = tool(
  'find',
  'Bounded project discovery across approved roots. Search names, file contents, or both instead of trial-opening candidate files. Use include to narrow file types and regex=true only when literal search is insufficient.',
  objectSchema({
    query: { type: 'string', minLength: 1, maxLength: 2048 },
    path: { type: 'string' },
    mode: { type: 'string', enum: ['name', 'text', 'both'] },
    regex: { type: 'boolean' },
    caseSensitive: { type: 'boolean' },
    include: { type: 'string', description: 'Filename glob such as *.ts or *.tsx.' },
    maxResults: { type: 'integer', minimum: 1, description: 'Per-page result target; output remains byte-bounded.' },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based match offset for continuing a truncated search.' }
  }, ['query'])
);

const EDIT_PROPERTIES: Record<string, JsonSchema> = {
  filePath: { type: 'string', description: 'File to modify for single-file strategies.' },
  file_path: { type: 'string', description: 'Alias for filePath.' },
  oldString: { type: 'string', description: 'Exact text to replace. Single-hunk path; for multiple files/hunks use patchText.' },
  newString: { type: 'string' },
  newText: { type: 'string' },
  replaceAll: { type: 'boolean' },
  line: { type: 'integer', minimum: 1 },
  oldText: { type: 'string', description: 'Verification text for line/range/insert/nearText strategies.' },
  startLine: { type: 'integer', minimum: 1 },
  endLine: { type: 'integer', minimum: 1 },
  insertAt: { type: 'integer', minimum: 0 },
  insertAfter: { type: 'integer', minimum: 1, description: 'Alias for insertAt.' },
  appendFile: { type: 'boolean' },
  nearText: { type: 'string' },
  occurrence: { type: 'integer', minimum: 1 },
  delete: { type: 'boolean' },
  edits: {
    type: 'array', minItems: 1,
    description: 'Atomic single-file batch. All operations resolve against original coordinates; overlaps are refused.',
    items: {
      oneOf: [
        objectSchema({ oldString: { type: 'string' }, newString: { type: 'string' } }, ['oldString', 'newString']),
        objectSchema({ line: { type: 'integer', minimum: 1 }, newText: { type: 'string' }, oldText: { type: 'string' } }, ['line', 'newText']),
        objectSchema({ startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, newText: { type: 'string' }, oldText: { type: 'string' }, delete: { type: 'boolean' } }, ['startLine', 'endLine'])
      ]
    }
  },
  patchText: { type: 'string', description: 'BULK PATHWAY: multi-file or multi-hunk patch. Batch all known related mutations into ONE call instead of looping edit. Supports opencode/Codex patch format and git unified diff.' },
  workdir: { type: 'string', description: 'Base directory for paths inside patchText.' },
  apply: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['if-clean'] }] },
  format: { type: 'string', enum: ['auto', 'opencode', 'git'] },
  showDiff: { type: 'boolean' }
};

const EDIT_TOOL = tool(
  'edit',
  'High-precision text mutation. Use one exact/line/range/insert/append/nearText strategy for one file, edits[] for multiple non-overlapping changes in one file, or patchText for multi-file/multi-hunk bulk work. ECONOMY: once 2+ related mutation sites are known, do not loop edit calls; batch them with edits[] or patchText.',
  objectSchema(EDIT_PROPERTIES)
);

const PATCH_TOOL = tool(
  'patch',
  'Preferred bulk mutation tool for 2+ known hunks or files. Accepts Codex/opencode *** Begin Patch format or git unified diff, preflights the complete change set before writing, rejects stale known reads, and rolls back captured preimages if commit fails. Use apply:false for a dry-run plan.',
  objectSchema({
    patchText: { type: 'string', minLength: 1, description: 'Complete multi-file patch.' },
    patch: { type: 'string', minLength: 1, description: 'Alias for patchText.' },
    workdir: { type: 'string', description: 'Base directory for relative paths in the patch.' },
    apply: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['if-clean'] }] },
    format: { type: 'string', enum: ['auto', 'opencode', 'git'] },
    showDiff: { type: 'boolean' }
  })
);

const GIT_TOOL = tool(
  'git',
  'Typed git operations for the approved repository. Prefer status/summary/diff/log/show over shelling out. Write modes are stage, unstage, restore, commit; broad/destructive operations require the confirm token named by the error. shell mode accepts only a restricted read-only git argv.',
  objectSchema({
    mode: { type: 'string', enum: ['help', 'status', 'summary', 'diff', 'log', 'show', 'stage', 'unstage', 'restore', 'commit', 'shell'] },
    workdir: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    ref: { type: 'string' }, staged: { type: 'boolean' },
    maxBytes: { type: 'integer', minimum: 2000, maximum: 500000 },
    maxCount: { type: 'integer', minimum: 1 },
    contextLines: { type: 'integer', minimum: 0 },
    message: { type: 'string' }, dryRun: { type: 'boolean' },
    confirm: { type: 'string', enum: ['STAGE_ALL', 'UNSTAGE_ALL', 'RESTORE_WORKTREE', 'RESTORE_BOTH', 'RESTORE_ALL', 'COMMIT'] },
    allowEmpty: { type: 'boolean' }, sign: { type: 'boolean' },
    restoreTarget: { type: 'string', enum: ['worktree', 'staged', 'both'] },
    argv: { type: 'array', items: { type: 'string' }, minItems: 1 }
  })
);

const EXEC_TOOL = tool(
  'exec_command',
  'Run a command in an approved working directory with Codex-style managed process semantics. Long-running commands yield a session_id; keep polling that SAME session with write_stdin until terminal completion. ECONOMY: use cmds:[...] for related sequential checks in one tool call instead of separate exec_command calls. tty=true keeps interactive stdin available.',
  objectSchema({
    cmd: { type: 'string' },
    cmds: { type: 'array', items: { type: 'string' }, minItems: 1 },
    workdir: { type: 'string' }, tty: { type: 'boolean' },
    yield_time_ms: { type: 'integer', minimum: 0 },
    max_output_tokens: { type: 'integer', minimum: 0, description: 'Accepted for cached-schema compatibility and ignored.' },
    shell: { type: 'string' }, login: { type: 'boolean' }
  })
);

const WRITE_STDIN_TOOL = tool(
  'write_stdin',
  'Poll or interact with an existing exec_command session. Empty chars polls and returns as soon as new output arrives; non-empty chars writes to a PTY session. Output is draining, so each successful poll returns new bytes rather than repeating old output. Retry the same session_id after transient failures.',
  objectSchema({
    session_id: { type: 'integer', minimum: 1 }, chars: { type: 'string' },
    yield_time_ms: { type: 'integer', minimum: 0 }, max_output_tokens: { type: 'integer', minimum: 0 }
  }, ['session_id'])
);

const INTEGRATION_TOOL = tool(
  INTEGRATION_TOOL_NAME,
  'Stable gateway for installed localMCP integrations. list discovers integrations and compact tool names, inspect returns one exact tool schema, and call invokes it. Use this for dynamic third-party MCPs so installing/updating a plugin does not require ChatGPT to refresh its top-level tool schema. Bundled native integrations such as OpenCode Control also keep their fixed direct tools.',
  objectSchema({
    action: { type: 'string', enum: ['list', 'inspect', 'call'] },
    plugin: { type: 'string', description: 'Optional exact integration id, name, or catalog id. Use to disambiguate inspect/call.' },
    tool: { type: 'string', description: 'Integration tool name for inspect/call.' },
    arguments: { type: 'object', additionalProperties: true, description: 'Arguments passed to the selected integration tool for call.' },
    query: { type: 'string', description: 'Optional list filter over integration ids/names/catalog ids/tool names/descriptions.' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  })
);

const SHELL_TOOL = tool(
  'shell',
  'Higher-level shell launcher. Foreground mode uses exec_command semantics. background:true creates a named persistent-output job and returns a job id; manage it with background. Use background jobs for servers/watchers/long tasks whose full output should remain readable by byte cursor.',
  objectSchema({
    command: { type: 'string', minLength: 1 }, workdir: { type: 'string' }, background: { type: 'boolean' },
    id: { type: 'string' }, timeout: { type: 'integer', minimum: 1000 }, tty: { type: 'boolean' },
    shell: { type: 'string' }, login: { type: 'boolean' }, yield_time_ms: { type: 'integer', minimum: 0 }
  }, ['command'])
);

const BACKGROUND_TOOL = tool(
  'background',
  'Manage shell(background:true) jobs. list/status are metadata-only; read uses byte offsets and returns nextOffset; wait blocks until output grows, the job exits, or timeout; send writes stdin; kill terminates the owned process tree; remove deletes a finished job record and log.',
  objectSchema({
    action: { type: 'string', enum: ['list', 'status', 'read', 'wait', 'send', 'kill', 'remove'] },
    id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, description: 'Page size for background list; defaults to 100.' }, maxBytes: { type: 'integer', minimum: 1024, maximum: 262144 },
    timeoutMs: { type: 'integer', minimum: 250, maximum: 30000 }, chars: { type: 'string' }
  })
);

function archiveDefinition(writeAllowed: boolean): Tool {
  const actions = writeAllowed ? ['list', 'read', 'extract', 'create'] : ['list', 'read'];
  return tool(
    'archive',
    'Inspect and manipulate archives without shell choreography. list shows entries without extracting; read opens one text entry; extract/create require write permission. Supports ZIP, tar, gzip/brotli/bzip2/zstd and system-backed 7z/rar/xz. Extraction blocks traversal/unsafe paths. Prefer list/read before extracting large archives.',
    objectSchema({
      action: { type: 'string', enum: actions },
      path: { type: 'string', description: 'Archive path. For create, destination archive path; must be inside an approved root.' },
      destination: { type: 'string', description: 'Extract destination. Defaults beside the archive.' },
      entries: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Glob/exact filters for list/extract.' },
      entry: { type: 'string', description: 'Exact path or glob for read.' },
      source: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Files/directories for create.' },
      overwrite: { type: 'boolean' },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1 }
    }, ['action', 'path'])
  );
}

const ARCHIVE_TOOL = archiveDefinition(true);
const ARCHIVE_READONLY_TOOL = archiveDefinition(false);

const JSON_TOOL = tool(
  'json',
  'Structure-aware JSON/JSONC/JSONL/BSON analysis and mutation. ECONOMY: use scaffold to understand large JSON, query for one JSONPath, search for keys/values/types, schema/stats for shape, and diff for structural comparison. format and RFC6902 patch are dry-run by default; dryRun:false writes only with write permission.',
  objectSchema({
    mode: { type: 'string', enum: ['validate', 'scaffold', 'query', 'search', 'schema', 'format', 'patch', 'diff', 'stats'] },
    filePath: { type: 'string', description: 'Approved-root JSON/JSONC/JSONL/BSON file. Use either filePath or jsonText.' },
    jsonText: { type: 'string', description: 'Inline JSON-family text for small inputs.' },
    compareFilePath: { type: 'string', description: 'Second file for diff.' },
    compareJsonText: { type: 'string', description: 'Second inline document for diff.' },
    path: { type: 'string', description: 'JSONPath for query, e.g. $.users[0].name.' },
    query: { type: 'string', description: 'Key/value substring for search.' },
    type: { type: 'string', enum: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
    patch: { type: 'array', minItems: 1, items: {}, description: 'RFC6902 operations: add/replace/remove/copy/move/test.' },
    indent: { type: 'integer', minimum: 0, maximum: 16 },
    sortKeys: { type: 'boolean' },
    dryRun: { type: 'boolean', description: 'format/patch default true. false applies to filePath when write permission is enabled.' },
    maxBytes: { type: 'integer', minimum: 1, maximum: 268435456 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 100 },
    maxObjectKeys: { type: 'integer', minimum: 1, maximum: 10000 },
    maxArrayItems: { type: 'integer', minimum: 1, maximum: 10000 },
    maxNodes: { type: 'integer', minimum: 1, maximum: 100000 },
    maxResults: { type: 'integer', minimum: 1, maximum: 5000 }
  })
);

const SKILL_TOOL = tool(
  'skill',
  'Progressively discover and load agent skills from approved roots. list/search returns paginated names/descriptions; load injects the matching SKILL.md instructions plus a small sampled resource list. ECONOMY: batch known skills with names[]. filePath may point to a SKILL.md or skill directory but never outside approved roots.',
  objectSchema({
    mode: { type: 'string', enum: ['load', 'list', 'search'] },
    name: { type: 'string', description: 'Registered skill name or an approved-root path.' },
    names: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Batch known skill names/paths.' },
    filePath: { type: 'string', description: 'Explicit SKILL.md/markdown file or containing directory inside an approved root.' },
    query: { type: 'string', description: 'list/search substring across name and description.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'All tag words must occur in name/description.' },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based list/search page offset.' },
    limit: { type: 'integer', minimum: 1, description: 'List/search page size; defaults to 100.' }
  })
);

const PROJECT_TOOL = tool(
  'project',
  'Bounded repo orientation without opening arbitrary source bodies. Use snapshot/summary before several exploratory reads; structure adds a compact tree, recent shows recently modified files, and toolchain probes installed runtimes. Uses manifests plus git metadata when git permission is enabled.',
  objectSchema({
    action: { type: 'string', enum: ['snapshot', 'summary', 'recent', 'toolchain'] },
    tier: { type: 'string', enum: ['summary', 'structure', 'full'] },
    path: { type: 'string', description: 'Project directory inside an approved root.' },
    workdir: { type: 'string', description: 'Alias-style project directory input.' },
    depth: { type: 'integer', minimum: 1 },
    maxEntries: { type: 'integer', minimum: 1, description: 'Tree rendering target; final model output remains byte-bounded.' },
    recent: { type: 'integer', minimum: 1, description: 'Recent-file page size.' },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based offset for action=recent pagination.' }
  })
);

const SYMBOLS_TOOL = tool(
  'symbols',
  'AST code intelligence for TS/TSX/JS/JSX. search finds declarations, outline summarizes one file, and usages separates resolved references from honest unattributed same-name matches. Prefer this over grep when you need definitions/usages rather than raw text.',
  objectSchema({
    action: { type: 'string', enum: ['search', 'outline', 'usages'] },
    query: { type: 'string' },
    file: { type: 'string', description: 'Required for outline; with line can identify the usage symbol.' },
    line: { type: 'integer', minimum: 1 },
    path: { type: 'string', description: 'Directory/file scope. Required for search/usages when multiple roots are approved.' },
    kind: { type: 'string', enum: ['function', 'class', 'interface', 'type', 'variable', 'const', 'enum', 'method', 'property', 'parameter', 'import', 'module'] },
    lang: { type: 'string', enum: ['ts', 'tsx', 'js', 'jsx'] },
    maxResults: { type: 'integer', minimum: 1, maximum: 500, description: 'Per-page result count; use offset to continue.' },
    offset: { type: 'integer', minimum: 0, description: 'Zero-based result-page offset.' },
    definitionOffset: { type: 'integer', minimum: 0, description: 'Zero-based definition-page offset for usages.' }
  })
);

function testDefinition(shellAllowed: boolean): Tool {
  return tool(
    'test',
    shellAllowed
      ? 'Harness-aware test runner/listing. Detects bun/vitest/jest/node:test/mocha/ava/playwright, maps path/name filters, parses failures, and kills timed-out child process trees. Use list for cheap discovery and run for focused verification.'
      : 'Read-only harness-aware test discovery. Shell permission is off, so only action=list is available; enable shell permission to run tests.',
    objectSchema({
      action: { type: 'string', enum: shellAllowed ? ['run', 'list'] : ['list'] },
      workdir: { type: 'string', description: 'Project/package directory inside an approved root.' },
      path: { type: 'string', description: 'Optional relative/approved-root test file or directory filter.' },
      testNamePattern: { type: 'string', maxLength: 500 },
      runtime: { type: 'string', enum: ['auto', 'bun', 'node'] },
      timeoutMs: { type: 'integer', minimum: 1000 },
      full: { type: 'boolean', description: 'Include a larger bounded output tail.' },
      offset: { type: 'integer', minimum: 0, description: 'Zero-based action=list page offset.' },
      limit: { type: 'integer', minimum: 1, description: 'action=list page size; defaults to 500.' },
      failureOffset: { type: 'integer', minimum: 0, description: 'Zero-based failed-test page offset for run results.' }
    })
  );
}

const TEST_TOOL = testDefinition(true);
const TEST_READONLY_TOOL = testDefinition(false);

function typecheckDefinition(gitAllowed: boolean): Tool {
  const modes = gitAllowed
    ? ['file', 'files', 'folder', 'changed', 'bottomUp', 'full', 'explain']
    : ['file', 'files', 'folder', 'bottomUp', 'full', 'explain'];
  return tool(
    'typecheck',
    'Scoped TypeScript/JavaScript diagnostics with an approved-root-filtered compiler host. Prefer file/files/folder over full; changed selects git changes when git permission is enabled. explain gives triage for one TS error code. No emit or source writes.',
    objectSchema({
      mode: { type: 'string', enum: modes },
      workdir: { type: 'string', description: 'Project directory containing the relevant tsconfig.' },
      filePath: { type: 'string', description: 'Target file, or TS error code for explain.' },
      files: { type: 'array', items: { type: 'string' }, minItems: 1 },
      folder: { type: 'string' },
      tsconfig: { type: 'string' },
      maxErrors: { type: 'integer', minimum: 1, maximum: 500, description: 'Per-page diagnostics; use errorOffset to continue.' },
      errorOffset: { type: 'integer', minimum: 0, description: 'Zero-based diagnostic page offset.' },
      maxFiles: { type: 'integer', minimum: 1, description: 'Optional caller-selected scope bound; omitted means all selected files.' },
      includeTests: { type: 'boolean' },
      includeUntracked: { type: 'boolean' },
      reason: { type: 'string', maxLength: 1000, description: 'Optional context for a full check.' }
    })
  );
}

const TYPECHECK_TOOL = typecheckDefinition(true);
const TYPECHECK_NO_GIT_TOOL = typecheckDefinition(false);

const BUILTINS = new Map<string, Tool>([
  [READ_TOOL.name, READ_TOOL], [FIND_TOOL.name, FIND_TOOL], [EDIT_TOOL.name, EDIT_TOOL], [PATCH_TOOL.name, PATCH_TOOL],
  [GIT_TOOL.name, GIT_TOOL], [EXEC_TOOL.name, EXEC_TOOL], [WRITE_STDIN_TOOL.name, WRITE_STDIN_TOOL],
  [SHELL_TOOL.name, SHELL_TOOL], [BACKGROUND_TOOL.name, BACKGROUND_TOOL], [ARCHIVE_TOOL.name, ARCHIVE_TOOL],
  [JSON_TOOL.name, JSON_TOOL], [SKILL_TOOL.name, SKILL_TOOL], [PROJECT_TOOL.name, PROJECT_TOOL],
  [SYMBOLS_TOOL.name, SYMBOLS_TOOL], [TEST_TOOL.name, TEST_TOOL], [TYPECHECK_TOOL.name, TYPECHECK_TOOL],
  [INTEGRATION_TOOL.name, INTEGRATION_TOOL]
]);

function permittedBuiltins(config: LocalMcpConfig): Tool[] {
  const out: Tool[] = [];
  if (config.permissions.read) {
    out.push(
      READ_TOOL,
      FIND_TOOL,
      config.permissions.write ? ARCHIVE_TOOL : ARCHIVE_READONLY_TOOL,
      JSON_TOOL,
      SKILL_TOOL,
      PROJECT_TOOL,
      SYMBOLS_TOOL,
      config.permissions.shell ? TEST_TOOL : TEST_READONLY_TOOL,
      config.permissions.git ? TYPECHECK_TOOL : TYPECHECK_NO_GIT_TOOL
    );
  }
  if (config.permissions.write) out.push(EDIT_TOOL, PATCH_TOOL);
  if (config.permissions.git) out.push(GIT_TOOL);
  if (config.permissions.shell) out.push(EXEC_TOOL, WRITE_STDIN_TOOL, SHELL_TOOL, BACKGROUND_TOOL);
  const fileTransfer = fileTransferDefinition(config);
  if (fileTransfer) out.push(fileTransfer);
  return out;
}

export function toolsFor(config: LocalMcpConfig): Tool[] {
  const builtins = permittedBuiltins(config);
  // Integration discovery is deliberately stable. Runtime permission is enforced in callTool;
  // hiding this gateway or bundled native tools when a toggle/plugin changes would invalidate
  // ChatGPT's frozen custom-app snapshot for a policy change rather than a contract change.
  const stablePlugins = [INTEGRATION_TOOL, ...pluginManager.stableTools()];
  const reserved = new Set([...BUILTINS.keys(), FILE_TRANSFER_TOOL_NAME]);
  return [...builtins, ...stablePlugins.filter((candidate) => !reserved.has(candidate.name) || candidate.name === INTEGRATION_TOOL_NAME)];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]));
}

/** Hash the exact model-facing tool projection without depending on object key insertion order. */
export function toolProjectionFingerprint(tools: readonly Tool[]): string {
  return createHash('sha256').update(JSON.stringify(stable(tools))).digest('hex');
}

export function toolSurfaceFingerprint(config: LocalMcpConfig): string {
  return toolProjectionFingerprint(toolsFor(config));
}

export async function callTool(config: LocalMcpConfig, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    if (name === 'read') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: read access is disabled in localMCP-chat.');
      return await readTool(config.roots, args as unknown as ReadInput);
    }
    if (name === 'find') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: read/search access is disabled in localMCP-chat.');
      return await findTool(config.roots, args as unknown as FindInput);
    }
    if (name === 'edit') {
      if (!config.permissions.write) return fail('TOOL_DISABLED: file mutation is disabled in localMCP-chat.');
      const input = args as unknown as EditInput & PatchInput;
      if (input.patchText !== undefined) return await patchTool(config.roots, input);
      return await editTool(config.roots, input);
    }
    if (name === 'patch') {
      if (!config.permissions.write) return fail('TOOL_DISABLED: file mutation is disabled in localMCP-chat.');
      return await patchTool(config.roots, args as unknown as PatchInput);
    }
    if (name === 'git') {
      if (!config.permissions.git) return fail('TOOL_DISABLED: git access is disabled in localMCP-chat.');
      return await gitTool(config.roots, args as unknown as GitInput);
    }
    if (name === 'exec_command') {
      if (!config.permissions.shell) return fail('TOOL_DISABLED: shell access is disabled in localMCP-chat.');
      return await execTool(config.roots, args as unknown as ExecInput);
    }
    if (name === 'write_stdin') {
      if (!config.permissions.shell) return fail('TOOL_DISABLED: shell access is disabled in localMCP-chat.');
      return await writeStdinTool(args as unknown as WriteStdinInput);
    }
    if (name === 'shell') {
      if (!config.permissions.shell) return fail('TOOL_DISABLED: shell access is disabled in localMCP-chat.');
      return await shellTool(config.roots, args as unknown as ShellInput);
    }
    if (name === 'background') {
      if (!config.permissions.shell) return fail('TOOL_DISABLED: shell access is disabled in localMCP-chat.');
      return await backgroundJobs.action(args as unknown as BackgroundInput);
    }
    if (name === 'archive') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: archive access requires read access in localMCP-chat.');
      return await archiveTool(config.roots, args as unknown as ArchiveInput, config.permissions.write);
    }
    if (name === 'json') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: JSON access requires read access in localMCP-chat.');
      return await jsonTool(config.roots, args as unknown as JsonInput, config.permissions.write);
    }
    if (name === 'skill') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: skill access requires read access in localMCP-chat.');
      return await skillTool(config.roots, args as unknown as SkillInput);
    }
    if (name === 'project') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: project access requires read access in localMCP-chat.');
      return await projectTool(config.roots, args as unknown as ProjectInput, config.permissions.git);
    }
    if (name === 'symbols') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: symbols access requires read access in localMCP-chat.');
      return await symbolsTool(config.roots, args as unknown as SymbolsInput);
    }
    if (name === 'test') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: test discovery requires read access in localMCP-chat.');
      return await testTool(config.roots, args as unknown as TestInput, config.permissions.shell);
    }
    if (name === 'typecheck') {
      if (!config.permissions.read) return fail('TOOL_DISABLED: typecheck requires read access in localMCP-chat.');
      const input = args as unknown as TypecheckInput;
      if (input.mode === 'changed' && !config.permissions.git) return fail('TOOL_DISABLED: typecheck changed mode requires git access in localMCP-chat.');
      return await typecheckTool(config.roots, input);
    }
    if (name === FILE_TRANSFER_TOOL_NAME) {
      if (!fileTransferDefinition(config)) return fail('TOOL_DISABLED: file transfer is disabled in localMCP-chat.');
      return await fileTransferTool(config.roots, args as unknown as FileTransferInput, config.permissions);
    }
    if (name === INTEGRATION_TOOL_NAME) {
      if (!config.permissions.plugins) return fail('TOOL_DISABLED: integrations are disabled in localMCP-chat.');
      return await integrationTool(args as unknown as IntegrationInput, {
        roots: config.roots,
        connectorName: config.connectorName,
        permissions: {
          read: config.permissions.read,
          write: config.permissions.write,
          shell: config.permissions.shell,
          git: config.permissions.git,
        },
      });
    }
    if (!config.permissions.plugins) return fail('TOOL_DISABLED: integration tools are disabled in localMCP-chat.');
    if (BUILTINS.has(name) || name === FILE_TRANSFER_TOOL_NAME) return fail(`TOOL_DISABLED: ${name} is currently disabled in localMCP-chat.`);
    return await pluginManager.call(name, args, undefined, {
      roots: config.roots,
      connectorName: config.connectorName,
      permissions: {
        read: config.permissions.read,
        write: config.permissions.write,
        shell: config.permissions.shell,
        git: config.permissions.git,
      },
    });
  } catch (error) {
    return fail(errorText(error));
  }
}

export const BUILTIN_TOOL_NAMES = new Set([...BUILTINS.keys(), FILE_TRANSFER_TOOL_NAME]);
