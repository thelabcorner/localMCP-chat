# localMCP-chat architecture and contributor map

Read this before changing the repository.

## Engineering rules

1. **One source of truth.** Rewrite an affected subsystem around the correct invariant instead of stacking compatibility branches around a bad design.
2. **Do not touch unrelated dirty work.** This tree may be shared with the user or other agents. Never `reset`, `clean`, broad-format, or overwrite unrelated changes.
3. **Batch operations.** Prefer one multi-file patch/read/command batch where the targets are already known. This applies both to model-facing tools and development work in this repository.
4. **Fail closed at authority boundaries.** Discovery/schema caching is not enforcement. Recheck permissions, roots, and process ownership at the operation itself.
5. **Preserve newer local data.** Recovery/rollback may restore only state proven to still be ours. A concurrent external edit wins.
6. **Keep the MCP surface compact.** Add capability to an existing coherent tool before adding another permanently exposed tool.
7. **Prefer structured high-frequency tools over shell choreography.** `project`, `symbols`, `test`, `typecheck`, `archive`, `json`, and `skill` exist to collapse repeated low-level calls into bounded operations. Specialized tools with large schemas should remain optional/lazy unless they justify permanent exposure.

## Product boundary

`localMCP-chat` is a local MCP capability router for ChatGPT. It is **not** a chat client and does not automate the ChatGPT webpage.

```text
ChatGPT / MCP client
       │
       ▼
Secure MCP Tunnel / HTTPS transport
       │
       ▼
tokenized loopback MCP endpoint
       │
       ├── built-in coding tools
       │     ├── approved-root filesystem
       │     ├── read freshness cache
       │     ├── edit / patch / git
       │     └── live + durable process managers
       │
       └── enabled external MCP servers

Electron control window
       └── roots / permissions / tunnel / plugins / diagnostics
```

Explicitly removed/out of scope: Chrome/Edge companion extension; ChatGPT DOM/Fiber observation; browser tab control; local conversation/session recording; worker agents; Goal/Loop/compaction/handoff orchestration; computer-use; per-conversation implicit workspaces; macOS packaging/support.

Do not depend on sibling workstation repositories or machine-specific paths. Architectural references must be represented by code, tests, or documentation checked into this repository.

## Source map

- `src/clean/main/index.ts`: Electron startup/shutdown, single-instance lock, tray/window/autostart wiring, and service lifetimes.
- `src/clean/main/state.ts`: per-machine connector identity, approved roots, seven permissions, one tunnel configuration, desktop preferences.
- `src/clean/main/deployment.ts`: strict versioned YAML/JSON deployment parser, root canonicalization and one-shot CLI flags for unattended installs.
- `src/clean/main/window.ts`: control-window creation, caption-overlay decision, close-to-tray, and guarded renderer broadcast.
- `src/clean/main/tray.ts`: status tray icon and context menu. Degrades to no tray rather than failing startup.
- `src/clean/main/autostart.ts`: login-item registration. The OS is the source of truth; a preference the OS rejects is cleared.
- `src/clean/main/connection.ts`: exactly one MCP endpoint/tunnel lifecycle, plus auto-connect retry that defers to the tunnel's own recovery.
- `src/clean/main/mcp.ts`: stateless Streamable HTTP adapter, tokenized loopback route, built-in/plugin projection, live permission recheck.
- `src/clean/main/metrics.ts`: bounded per-run tool-call and endpoint-request counters recorded at the `tools/call` dispatch boundary.
- `src/clean/main/ipc.ts`: narrow control-window IPC, event-pushed rather than polled. Never return plaintext credentials.
- `src/clean/main/tools/read.ts`: batched streaming reads plus paginated grep/around/outline/tail; records freshness.
- `src/clean/main/tools/edit.ts`: precise single-file mutation and atomic `edits[]` batch.
- `src/clean/main/tools/patch.ts`: multi-file patching, preflight, bounded rollback, compare-before-restore.
- `src/clean/main/tools/git.ts`: typed argv-only git modes and confirmations for broad writes.
- `src/clean/main/tools/exec.ts`: live/yielded process sessions.
- `src/clean/main/tools/background.ts`: durable named jobs and byte-cursor log polling.
- `src/clean/main/tools/archive.ts`, `archive/**`: bounded archive inspection, creation, extraction, decompression, and traversal defenses.
- `src/clean/main/tools/json.ts`, `json/**`: JSON-family parsing, structure/query/search/schema/diff and dry-run mutation.
- `src/clean/main/tools/skill.ts`: approved-root skill discovery and progressive instruction loading.
- `src/clean/main/tools/project.ts`: manifest-only project orientation plus bounded file metadata/toolchain probes.
- `src/clean/main/tools/symbols.ts`: TypeScript-compiler AST symbol search/outline/usages with honest attribution.
- `src/clean/main/tools/test.ts`, `test-scope.ts`: harness detection, read-only listing, focused execution, reporter parsing, timeout/process-tree cleanup.
- `src/clean/main/tools/typecheck.ts`: approved-root-constrained TypeScript compiler host and scoped diagnostics.
- `src/clean/main/tools/file-transfer.ts`, `src/main/files/**`: FILE_TRANSFER bridge for ChatGPT-native ingress and public OpenAI Files API upload/download with streaming bytes and atomic local publication.
- `src/clean/main/tools/registry.ts`: public schemas/descriptions, permission-sensitive tool projection, plugin name reservation, and live dispatch.
- `src/main/sandbox.ts`, `src/main/rawfs.ts`: canonicalization and approved-root containment.
- `src/main/codex/`: retained Codex-derived filesystem/patch/shell/unified-exec foundations.
- `src/main/tunnel/`: tunnel lifecycle and health.
- `src/main/secrets.ts`: OS-backed OpenAI/plugin credential storage plus explicitly runtime-only OpenAI key sources for unattended/headless deployments.
- `src/main/plugins/`: external MCP installation/auth/lifecycle/tool projection.
- `src/main/logger.ts`: bounded redacted diagnostics with monotonic sequence numbers.
- `src/shared/types.ts`, `src/shared/plugins.ts`: remaining shared contracts.

Control-window renderer (no framework, no runtime dependencies):

- `src/clean/renderer/style.css`: hand-written shadcn new-york/zinc tokens and dense component styles.
- `src/clean/renderer/dom.ts`: `el`, keyed `reconcile`, `setValueIfIdle`, inline icons.
- `src/clean/renderer/ui.ts`: card/button/badge/toggle/stat primitives.
- `src/clean/renderer/views.ts`: the six views and their update-in-place row builders.
- `src/clean/renderer/log-store.ts`, `log-pane.ts`: pure log merge/filter/highlight, and the one pane implementation shared by the console drawer and the Activity view.
- `src/clean/renderer/app.ts`: shell, navigation, drawer, command palette, shortcuts, caption-area reservation.
- `src/clean/renderer/bridge.ts`, `types.ts`, `main.ts`, `index.html`: preload bridge binding, renderer-side contracts, entry point, and the CSP-bearing document.

## Authority invariants

### Files

- The model uses virtual paths such as `/project/src/a.ts`.
- Resolve/canonicalize every operation through approved roots.
- Symlink targets outside the approved root are not authorized by the symlink's location.
- A known stale read blocks mutation until reread; absence of a prior read is only a warning when current context validates.

### Patch rollback

- Capture bounded preimages before commit.
- Track exact post-state for writes already committed.
- Restore a preimage only when current contents equal that exact post-state or already equal the preimage.
- If current contents differ, preserve them and report incomplete rollback.

### Processes

- `exec_command`/`write_stdin` own live interactive/yielded sessions.
- `shell(background:true)`/`background` own durable named jobs.
- Poll existing work instead of relaunching equivalent processes.
- Teardown terminates owned process trees.
- A persisted PID alone is never enough authority to adopt/kill a process after restart.

### MCP

- Built-in names are reserved from plugins.
- Tool list projection may be cached; live permissions remain authoritative.
- There is exactly one local connector per process/machine profile. Its persisted identity is configurable (`localMCP-chat` by default) and must be re-advertised by reconnecting when it changes.
- No request is associated with or authorized by a ChatGPT conversation id.
- Permission-sensitive schemas should hide impossible actions when practical. Example: `archive` advertises only list/read when Write is disabled; `test` advertises only list when Shell is disabled. Runtime checks remain authoritative even if a client cached an older schema.
- `file_transfer`: Receive and Send are distinct authorities. Receiving bytes still requires Write for local publication; sending local bytes still requires Read and explicit `filesSend` network-egress permission. ChatGPT-native signed URLs never receive the local OpenAI API key.

### Structured coding tools

- `archive`: every archive/source/destination path must resolve through approved roots. Extraction must reject traversal, absolute entries, and symlink write-through.
- `json`: file-backed writes are dry-run by default and require Write at call time. Inline `jsonText` needs no filesystem permission beyond the tool being exposed.
- `skill`: discovery and explicit loads may only use currently approved roots. Cached/ad-hoc skill registrations must be revalidated before reuse.
- `project`: source bodies are not part of the orientation contract. Read manifests/config allowlists plus file metadata only.
- `symbols`: parse only approved-root JS/TS-family files; comments/strings are not symbol usages; ambiguous same-name matches must remain explicitly unattributed.
- `test`: listing is read-only. Execution requires Shell and uses owned child processes with hard timeout cleanup.
- `typecheck`: compiler resolution must not become a filesystem escape hatch. Compiler hosts may read approved roots plus the bundled compiler standard-library directory only.

### Secrets/logs

- Never return API/plugin secret values over IPC or MCP.
- Reject insecure secret-storage fallbacks.
- Redact log messages before they enter memory or disk.
- Deployment files are secret-free. `--store-openai-key-from-env` may persist a process-only OpenAI key only through the ordinary protected secret store. Runtime `LOCALMCP_OPENAI_API_KEY[_FILE]` values must never be copied into config/log output.

### Deployment

- `deploy/windows/AGENT_SETUP.md` is intended to be sufficient as a standalone handoff to an execution agent on a Windows target.
- Deployment schema version `1` is strict: reject unknown fields, malformed connector names, duplicate/reserved roots, missing/non-directory roots, overlaps, and malformed OpenAI tunnel IDs.
- Root validation during deployment must use the same canonicalization/containment code as the control window, never a parallel path policy.
- A deployment apply is a one-shot operation. It must not silently start plugins/tunnels after mutating config; normal startup owns service lifetime.
- Verify an installer before stopping a healthy existing instance. A bad download must cause zero avoidable downtime.
- One Windows machine still runs one localMCP-chat instance. Machine-specific connector names distinguish separate hosts; they are not multi-profile support inside one process.

### Desktop shell

- Every desktop preference is opt-in. An unreadable or malformed config yields the defaults, never a previous load's values.
- The OS decides whether the app starts at login. Report the registration that actually exists, and clear a stored preference the OS refused. Never register a login item from an unpackaged dev run.
- The tray, the caption overlay and the login item are all optional. Missing any of them degrades the UI; it must not block startup or trap the app with no way to quit.
- Auto-connect only retries when no tunnel handle exists. Never retry an authentication or configuration failure.
- Renderer state is pushed on change, not polled, and views update in place. Never rebuild a subtree that holds focus, caret, selection or scroll.
- Everything the renderer accumulates is bounded: the log ring, the pending push buffer, the per-tool metrics table, and stored error strings.
- Metrics count what the MCP dispatch boundary saw. A tool reports failure in-band with `isError`; an absent exception is not success.

## Tests and verification

Primary focused suites: `src/clean/main/tools/tools.test.ts` and `src/clean/main/tools/advanced-tools.test.ts`.

```sh
npm run typecheck
npm test
npm run build
npm run verify
```

For packaging changes, smoke the actual package. Windows x64 example:

```sh
npm run dist:dir:x64
node scripts/smoke-packaged-runtime.mjs --platform win32 --arch x64
```

Windows is the primary release target. Linux remains in the build graph. Do not reintroduce macOS resources/jobs without an explicit product decision.

## Packaging and legal files

- `electron-builder.yml`: Windows/Linux resources only.
- `scripts/fetch-tunnel-client.mjs`, `fetch-ripgrep.mjs`: pinned/checksummed assets.
- `scripts/prepare-packaging-native.mjs`: target node-pty payload.
- `scripts/smoke-packaged-runtime.mjs`: packaged native-runtime proof.
- `deploy/windows/`: agent runbook, strict example deployment, and reusable Windows bootstrap helper. These files also ship as app resources.
- `docs/licenses/**`, `LICENSE`, `THIRD-PARTY-NOTICES.txt`: compliance material. Never bulk-delete them as stale docs.

`LICENSE` intentionally preserves upstream MIT attribution. Renaming the product does not erase upstream copyright.

## Before finishing

- Inspect `git diff` for unrelated changes.
- Search the affected subsystem for stale product assumptions.
- Add deterministic tests for changed behavior.
- Run focused tests, then `npm run verify`.
- For packaging changes, test packaged bytes/runtime rather than only source bundles.
