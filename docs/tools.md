# Built-in tool contracts

`localMCP-chat` exposes one connector and a compact set of structured local tools. This file documents the intended model-facing contract. Runtime enforcement lives in code, not in this document.

## Permission projection

The seven user-facing capability switches are Read, Write, Receive files, Send files to OpenAI, Shell, Git, and Plugins. `filesSend` is deliberate network-egress authority and defaults off.

| Tool | Required authority |
| --- | --- |
| `read`, `find`, `json`, `skill`, `project`, `symbols`, `typecheck` | Read |
| `archive` list/read | Read |
| `archive` extract/create | Read + Write |
| `edit`, `patch` | Write |
| `git` | Git |
| `exec_command`, `write_stdin`, `shell`, `background` | Shell |
| `test` list | Read |
| `test` run | Read + Shell |
| `file_transfer.save_chatgpt_file`, `download_openai_file` | Receive files + Write |
| `file_transfer.upload_openai_file` | Send files to OpenAI + Read |
| `file_transfer.get_openai_file`, `list_openai_files` | Receive files or Send files to OpenAI |
| `integration` gateway and external MCP calls | Plugins plus the external server's own authority |

Tool schemas are intentionally stable for native integrations and the dynamic-integration gateway. Cached schemas are never trusted as permission decisions; every call checks the current configuration again. Permission/runtime state should change execution admission rather than remove a fixed declaration from ChatGPT's cached custom-app action surface.

## Economy rules

- Batch 2 to 8 known file reads with `read.filePaths[]` or `read.reads[]`.
- Use `find`, `read.grep`, or `read.around` for discovery instead of opening candidate files one by one.
- Use `edit.edits[]` for several changes in one file and `patch` for multi-file or multi-hunk work.
- Poll the same `exec_command` session or durable background job instead of launching equivalent work again.
- Use `project` before broad code reading when the question is repository orientation.
- Use `symbols` instead of textual grep when the question is declaration/outline/usage semantics.
- Use `json` scaffold/query/search rather than reading a large structured file in full.
- Use `archive` list/read rather than extracting merely to inspect contents.
- Use `file_transfer` for real file movement instead of shell, curl, base64, or manually copied signed URLs.
- Use `skill` list/search before loading instructions; discovery is paginated and already-known skill names can be batched in one call.
- Use `test` with a focused path/name pattern and `typecheck` with the narrowest useful scope.

## Archive

Actions: `list`, `read`, `extract`, `create`.

The implementation supports pure in-process ZIP, tar, gzip, Brotli, bzip2, and zstd paths plus bounded system fallbacks for formats such as 7z/rar/xz when the host tool exists. Extraction rejects path traversal, absolute archive entries, and writes through symlinks. Large entries and total extraction/create sizes are capped.

When Write is disabled, the advertised action enum contains only `list` and `read`.

## JSON

Modes: `validate`, `scaffold`, `query`, `search`, `schema`, `format`, `patch`, `diff`, `stats`.

Supported input families include JSON, JSONC, JSONL, and BSON. `format` and RFC6902 `patch` are dry-run by default. Applying to a file requires `dryRun:false` plus live Write permission. Inline `jsonText` supports analysis without touching disk.

## File transfer

Actions: `save_chatgpt_file`, `upload_openai_file`, `download_openai_file`, `get_openai_file`, `list_openai_files`.

The advertised action enum is permission-sensitive. ChatGPT-native ingress uses the host-mediated top-level `source_file` parameter declared through `_meta["openai/fileParams"]`; localMCP never sends its API key to that signed file URL. Public OpenAI Files API actions use the protected local OpenAI credential and the fixed `api.openai.com` origin. Bulk bytes are streamed, destinations never overwrite, receive-side publication is atomic, and uploads are not blindly retried after an ambiguous connection failure.

`upload_openai_file` creates a public OpenAI Files API object. It does not claim to attach that object to the currently running ChatGPT conversation.

## Skill

Modes: `list`, `search`, `load`.

Skills are discovered from `SKILL.md` files inside approved roots. `list` and `search` return paginated compact metadata; `load` returns instructions plus a bounded resource list. `names[]` batches known skills without an arbitrary item-count ceiling. Explicit file/directory loads and remembered ad-hoc skills are revalidated against the current root set before use.

## Limit policy

Cardinality is not an authority boundary. Valid roots, command batches, edit operations, Git path operands, plugin/tool catalogs, persisted background jobs, skill discovery, symbol scans, project inventory, and selected typecheck files must not disappear merely because they occur after an arbitrary Nth item.

Large result sets use continuation instead of inaccessibility: background jobs, archives, skills, symbols, test discovery/failures, recent project files, and typecheck diagnostics expose offsets or cursors. Large text files are streamed and model-visible output remains byte-bounded. Completed `exec_command` sessions are compacted out of the live-process table while their unread terminal result remains drainable by the same `session_id`.

Hard limits remain only where they protect a concrete resource or trust boundary, such as request/response bytes, archive-bomb expansion, secret/image sizes, bounded model-visible output, or truly simultaneous live OS processes. Prefer byte/time/concurrency budgets plus pagination over silent item-count truncation.

## Project

Actions: `snapshot`, `summary`, `recent`, `toolchain`.

Snapshot tiers are `summary`, `structure`, and `full`. The tool reads only a small manifest/config allowlist such as `package.json`, `pyproject.toml`, `Cargo.toml`, and `go.mod`, plus file metadata and optional Git inventory/status. Arbitrary source bodies are not opened by the project-orientation path.

## Symbols

Actions: `search`, `outline`, `usages` for TS/TSX/JS/JSX-family files.

The parser uses a pinned TypeScript compiler API. Symbol extraction is AST-based, so comments and string contents are not reported as identifiers. Usage analysis separates confidently attributed references from an explicit `unattributed` bucket for same-name or unresolved-import matches.

## Test

Actions: `list`, `run`.

Harness detection covers Bun test, Vitest, Jest, `node:test`, Mocha, Ava, and Playwright. `list` does not execute code and remains available without Shell. `run` requires Shell, maps path/name filters to the selected harness, captures bounded output, parses reporter results, and terminates the owned process tree on timeout.

## Typecheck

Modes: `file`, `files`, `folder`, `changed`, `bottomUp`, `full`, `explain`.

The compiler host reads only current approved roots plus the bundled TypeScript standard-library directory. It does not hand the compiler unrestricted host filesystem access. Diagnostics are classified into P0 through P3 categories with concise suggestions and clustered repeated failures. `full` requires a reason and remains bounded.

## Specialized tools

The OpenCode fork also contains custom `sqlite`, `sympy`, and `refactor` tools. They are intentionally not part of the permanent default schema surface yet because their schemas and runtime dependencies are comparatively large. The preferred future design is a lazy/optional specialized-tool capability so these remain available without taxing every coding conversation.

## Dynamic integration gateway

`integration` is the fixed discovery/call boundary for arbitrary installed MCP integrations whose live tool catalogs are not suitable as permanent ChatGPT custom-app actions.

Actions:

- `list` returns compact installed-integration/tool inventory;
- `inspect` loads one live tool definition/schema on demand;
- `call` invokes one installed integration tool with runtime arguments.

The purpose is schema stability, not only convenience. ChatGPT maintains a custom-app action snapshot above the live MCP transport, so adding/removing top-level tool definitions for every plugin lifecycle event can leave conversations on stale declarations. Dynamic plugin state therefore belongs behind this fixed gateway. The implementation may preserve execution compatibility for direct external tool names cached by older ChatGPT snapshots, but new plugin availability must not depend on top-level schema churn.

Do not solve this with ChatGPT settings-UI automation or private web endpoints. Deliberate top-level schema changes may require one manual **Refresh / Scan actions**; ordinary integration lifecycle must remain behind the fixed gateway.

## Native OpenCode Control integration

The first-party `OpenCode Control` integration has four stable declarations under the Plugins capability. They are prepublished by the build rather than appearing only after runtime installation/configuration, and remain present while OpenCode is offline, reconnecting, or otherwise unavailable. Runtime policy rejects unavailable/disabled calls without mutating the provider-visible schema.

| Tool | Main actions |
| --- | --- |
| `opencode_info` | `status`, `capabilities`, `providers`, `models`, `agents`, `limits`, `usage` |
| `opencode_session` | `list`, `get`, `messages`, `children`, `selection`, `set_selection`, `send`, `turn`, `pause`, `resume`, `abort`, `background_subagents` |
| `opencode_worker` | standalone `start/list/get/wait/result/continue/cancel` plus `swarm_start/swarm_list/swarm_get/swarm_wait/swarm_cancel/swarm_continue` |
| `opencode_request` | `list`, `reply_permission`, `answer_question`, `reject_question` |

The live OpenCode provider catalog is the authority for models and reasoning variants. Model resolution understands OpenCode Go/Zen aliases, exact IDs, display names, account-qualified routes such as WorkBuddy, and the cross-provider family cases used by the OpenSwarm resolver. Ambiguous multi-account matches fail instead of guessing. A human phrase such as `extra high` maps to `xhigh` only if the selected model actually publishes `xhigh`. `opencode_info(models)` supports provider/tier/search/capability filters, cheapest-capable ranking, and bounded `offset` pagination so even large multi-account catalogs remain fully enumerable without dumping the entire catalog into one model turn.

Every localMCP-created OpenCode session is tagged as delegated automation and receives a hard `swarm_* = deny` OpenCode permission rule. This prevents recursive ChatGPT -> localMCP -> OpenSwarm swarm cascades. LocalMCP swarms use OpenCode session groups as durable ownership/membership state and do not use the OpenSwarm database. Existing OpenSwarm member sessions remain controllable through `opencode_session` when they are inside approved roots, and are never silently adopted into localMCP ownership.

`swarm_*` actions in `opencode_worker` are intentionally a batch-management convenience, not a second autonomous swarm runtime. They are the MCP analogue of issuing several independent OpenCode `task` calls: ChatGPT supplies complete standalone assignments, localMCP starts the OpenCode sessions concurrently, and ChatGPT later pulls aggregate or per-member state/results. Members do not receive peer rosters, mailboxes, task DAGs, or shared-memory machinery. Batch identity lives in OpenCode metadata/session groups for recovery and aggregate wait/cancel/continue operations, not in each model's prompt.

Existing-session prompt/resume operations require localMCP Write and Shell authority because an existing OpenCode session can carry broader native permissions. Read-only inspection, pause, and abort retain narrower safety semantics. All returned session directories are canonicalized against localMCP approved roots before any transcript or control result is exposed.
