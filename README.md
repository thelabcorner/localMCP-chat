# localMCP-chat

**A local MCP capability router that gives ChatGPT controlled access to your own computer.**

[![CI](https://github.com/thelabcorner/localMCP-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/thelabcorner/localMCP-chat/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/thelabcorner/localMCP-chat)](https://github.com/thelabcorner/localMCP-chat/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`localMCP-chat` runs on your machine and exposes a deliberately compact set of local coding and file capabilities through MCP. You choose the approved folders, runtime permissions, tunnel, and per-machine connector identity.

The goal is direct local project access without granting a remote service unrestricted host authority. Windows is the primary platform; Linux x64/ARM64 is part of the official release matrix. macOS is intentionally unsupported.

## What it does

- Runs one loopback MCP server and connects it through OpenAI Secure MCP Tunnel, Cloudflare Tunnel, or a manual tunnel.
- Gives ChatGPT access only to folders you explicitly approve.
- Exposes OpenCode-inspired coding tools designed around batching, low token overhead, deterministic errors, and safe mutation semantics.
- Keeps live interactive shell sessions pollable instead of forcing a new process for every command.
- Supports durable background jobs with persistent logs and byte-cursor polling.
- Moves real files bidirectionally between ChatGPT/OpenAI file storage and approved local folders through one streaming `file_transfer` tool, without shell/base64 choreography.
- Aggregates enabled external MCP servers behind the same `localMCP-chat` connector.
- Stores API/plugin credentials through Electron `safeStorage`; plaintext secrets never enter the renderer or normal logs.
- Can start with Windows, start hidden in the tray, and connect on its own, with a tray icon that shows connection state.
- Streams a live redacted log to a console drawer and a full Activity view, and counts tool calls, failures and latency for the run.
- Supports strict YAML/JSON deployment files so another agent can configure a machine without hand-editing Electron AppData.

It does **not** automate ChatGPT's webpage or browser UI.

## Download

Use the [latest GitHub release](https://github.com/thelabcorner/localMCP-chat/releases/latest).

| Platform | Architecture | Artifact |
| --- | --- | --- |
| Windows | x64 | `localMCP-chat-Setup-x64.exe` |
| Windows | ARM64 | `localMCP-chat-Setup-arm64.exe` |
| Linux | x64 | `localMCP-chat-Linux-x64.AppImage` or `.deb` |
| Linux | ARM64 | `localMCP-chat-Linux-arm64.AppImage` or `.deb` |

Every official release includes `SHA256SUMS.txt`. Verify downloaded bytes before running them. On Linux, use `sha256sum -c SHA256SUMS.txt`; on Windows, compare `Get-FileHash <artifact> -Algorithm SHA256` with the published manifest.

Release binaries are currently unsigned. Windows SmartScreen or endpoint-security software may warn on first launch; use the published SHA-256 manifest as the integrity check and do not bypass a mismatched artifact.

## Tool surface

The built-in surface stays compact, but now includes the high-frequency structured tools from the OpenCode fork so ChatGPT does not have to reconstruct the same operations with repeated reads and shell commands:

| Tool | Purpose |
| --- | --- |
| `read` | Batch known targets in one call; large text files stream through bounded windows. Also supports paginated `grep`, `around`, `outline`, and `tail` inspection modes. |
| `find` | Fast bounded file/text discovery when a dedicated search call is clearer than `read`. |
| `edit` | Precise single-file edits, including atomic `edits[]` batches against original coordinates. |
| `patch` | Bulk multi-file mutation using OpenCode/Codex `*** Begin Patch` syntax or git unified diffs, with full preflight and rollback. |
| `git` | Typed safe git operations with argv execution and confirmation tokens for broad mutations. |
| `exec_command` | Foreground or yielded command execution with PTY support, bounded output, batch commands, and owned process trees. |
| `write_stdin` | Poll or interact with an existing `exec_command` session, including stdin and interruption. |
| `shell` | Run a shell command normally or start a durable named background job. |
| `background` | List/status/read/wait/send/kill/remove durable background jobs using byte-addressed logs. |
| `archive` | List/read archives directly and safely extract/create them when write permission is enabled. |
| `json` | Structure-aware JSON/JSONC/JSONL/BSON scaffold, query, search, schema, stats, diff, format, and RFC6902 patch operations. |
| `skill` | Progressively discover and load `SKILL.md` capabilities from approved roots, with paginated discovery and batched known-skill loads. |
| `project` | Token-lean project orientation: stack, package manager, scripts, entry points, CI/config hints, bounded structure, recent files, and toolchain probes. |
| `symbols` | AST-based TS/TSX/JS/JSX definition search, file outline, and usage analysis with an explicit unattributed bucket for ambiguous same-name matches. |
| `test` | Detect the project test harness, list tests read-only, or run focused tests when Shell is enabled. |
| `typecheck` | Scoped TypeScript diagnostics and error-code explanations using a compiler host constrained to approved roots. |
| `file_transfer` | Save a ChatGPT-native file locally, upload an approved local file to the public OpenAI Files API, download a `file-*` locally, or resolve bounded file metadata. |

Tool descriptions explicitly encourage batching. If eight file ranges are already known, use one `read` call. If several files belong to one coherent mutation, use one `patch` call. If a process is already running, poll it instead of launching another equivalent command.

`archive`, `json`, `skill`, `project`, `symbols`, `test`, `typecheck`, and `file_transfer` are first-class built-ins because they replace common multi-call workflows with bounded structured operations. `file_transfer` keeps ChatGPT-native signed references, API credentials, and bulk bytes out of model text. Heavier niche OpenCode tools such as `sqlite`, `sympy`, and `refactor` are intentionally not part of the permanent default schema surface; they are candidates for a later optional/lazy capability tier.

See [`docs/tools.md`](docs/tools.md) for the complete built-in contract and permission behavior.

### Live sessions vs. durable jobs

`exec_command` + `write_stdin` and `shell(background:true)` + `background` are intentionally separate:

```text
exec_command -> session_id -> write_stdin
    live interactive/yielded process
    ideal for builds, tests, REPLs and commands that may finish soon

shell(background:true) -> job id -> background
    durable named job with persistent log/meta files
    ideal for dev servers, watchers and long-running processes
```

The application owns processes it starts and terminates their process trees during shutdown. A restarted application may read historical background logs, but it does not silently adopt an unknown live PID.

## Filesystem authority

Approved folders are exposed as virtual roots. For example:

```text
Windows path: C:\work\project
Root name:    project
Model path:   /project/src/index.ts
```

The model never needs the native host path. File tools canonicalize paths and enforce root containment, including symlink boundaries.

There is deliberately no implicit "current ChatGPT conversation directory." Working directories are explicit. This keeps MCP behavior deterministic across ChatGPT clients and removes the browser-extension identity assumptions of the predecessor project.

### Mutation freshness

Reads record file freshness. Mutation rules are asymmetric on purpose:

- no prior read: mutation may proceed after validating current context, with a warning;
- known stale read: mutation is refused until the file is read again.

Bulk patching preflights before the first write. If a later write fails, captured preimages are restored only while each path still contains the exact state the patch itself wrote. If another local process edits a path during failure recovery, that newer content wins and rollback reports the conflict instead of overwriting it.

## External MCP integrations

`localMCP-chat` can install/configure supported MCPB, npm, Python, command, and remote MCP integrations. Dynamic external integrations are discovered and invoked through a stable `integration` gateway so routine plugin install/update/enable/disable churn does not continually invalidate ChatGPT's cached custom-app action declaration. Already-cached direct external tool names may remain executable for compatibility, but the long-term model-facing boundary is the fixed gateway.

`OpenCode Control` is the first bundled native integration. It talks directly to the local OpenCode HTTP/SSE service instead of spawning another MCP hop. ChatGPT can inspect existing OpenCode sessions, list live providers/models/quotas, persist a session model plus reasoning variant, launch durable workers, and batch several restart-safe task-like workers behind one localMCP swarm handle. The model catalog preserves OpenCode Go/Zen, OpenRouter, WorkBuddy account-qualified routes, and whatever other providers the running OpenCode instance exposes.

LocalMCP swarms are intentionally separate from OpenSwarm and are not an autonomous peer-to-peer swarm runtime. They behave like a durable batch form of OpenCode's native `task` tool: each worker gets a standalone assignment, ChatGPT remains the coordinator, and status/results are pulled through MCP. Every OpenCode session created by localMCP gets a hard `swarm_* = deny` rule, so delegated workers cannot recursively fan out into OpenSwarm. Existing OpenSwarm member sessions remain inspectable and controllable through `opencode_session` when they are inside approved roots. The bridge never silently adopts those sessions into localMCP ownership.

Built-in names are reserved. A plugin cannot silently replace `read`, `patch`, `git`, shell tools, or another built-in capability.

External MCP servers execute with the permissions of their own process/service. The approved-root sandbox constrains the built-in filesystem tools; it cannot impose that policy on an arbitrary third-party MCP server.

ChatGPT's custom-app action snapshot is a separate cache boundary above the live MCP connection. A deliberate localMCP release that changes the stable top-level schema may require one manual **Refresh / Scan actions** in ChatGPT, but normal plugin/OpenCode runtime lifecycle must not depend on schema churn or browser automation.

## Quick start

Requirements:

- Windows 10/11 x64 or ARM64. Linux x64/ARM64 is also retained as a supported build target.
- Node.js 22+ for development.
- A ChatGPT account/workspace that supports custom MCP connectors / Developer mode.
- For OpenAI Secure MCP Tunnel: a tunnel id and an OpenAI API key used by `tunnel-client`.

Development:

```powershell
npm ci
npm run verify
npm run dev
```

In the app:

1. In Settings, choose a connector identity. The default is `localMCP-chat`; use a machine-specific name such as `localMCP-workstation` or `localMCP-homelab` when multiple machines will be connected.
2. Add one or more approved folders.
3. Review the Read, Write, Receive files, Send files to OpenAI, Shell, Git, and Plugins capability switches. Local-to-OpenAI file egress is off by default.
4. Choose a tunnel method. For OpenAI Secure MCP Tunnel, enter the tunnel id and save the API key.
5. Connect.
6. Create/refresh the matching custom MCP app in ChatGPT. Keep its ChatGPT-side app name aligned with this instance's connector identity. Refresh again only after a release that deliberately changes localMCP's stable top-level tool contract, not for normal plugin/OpenCode lifecycle changes.
7. Optionally choose whether the app starts with Windows, starts hidden in the tray, connects on its own, and keeps running when the window is closed.

Tool schemas may be cached by an MCP client. Runtime permission checks are repeated on every tool call, so disabling a capability takes effect even before a client refreshes its cached schema.

## Agent / homelab deployment

Windows deployments can be applied declaratively instead of clicking through the control window or editing `%APPDATA%` by hand. The deployment file is versioned, strict, and contains no credential values.

```yaml
version: 1
connectorName: localMCP-homelab
roots:
  - name: projects
    path: C:\Projects
permissions:
  read: true
  write: true
  shell: true
  git: true
  plugins: true
  filesReceive: true
  filesSend: false
tunnel:
  kind: openai
  tunnelId: tunnel_REPLACE_WITH_MACHINE_TUNNEL_ID
  binaryPath: ""
preferences:
  launchAtLogin: true
  startHidden: true
  autoConnect: true
  closeToTray: true
```

Apply it with the installed app itself:

```powershell
$env:LOCALMCP_OPENAI_API_KEY = <secret supplied at runtime>
& "$env:LOCALAPPDATA\Programs\localMCP-chat\localMCP-chat.exe" `
  --apply-deployment C:\setup\localmcp-homelab.yaml `
  --store-openai-key-from-env
Remove-Item Env:LOCALMCP_OPENAI_API_KEY
```

`--apply-deployment` validates root existence/containment, connector identity, permissions and tunnel settings before atomically persisting configuration. `--store-openai-key-from-env` seals the process-only key into Electron `safeStorage` (DPAPI on Windows); the key is never copied into the YAML/JSON config. Runtime-only service deployments may instead provide `LOCALMCP_OPENAI_API_KEY` or `LOCALMCP_OPENAI_API_KEY_FILE` without persisting it.

For the complete Windows agent handoff, including silent install, mandatory installer-hash verification, startup registration and connection verification, use [`deploy/windows/AGENT_SETUP.md`](deploy/windows/AGENT_SETUP.md). [`deploy/windows/bootstrap.ps1`](deploy/windows/bootstrap.ps1) is the reusable helper and [`deploy/windows/localmcp-homelab.example.yaml`](deploy/windows/localmcp-homelab.example.yaml) is the secret-free template.

The local `connectorName` and the custom app's name in ChatGPT are intentionally separate authorities. The app can advertise its MCP server identity, but it cannot rename an already-created ChatGPT custom app remotely. Give the homelab its own ChatGPT app name **and** its own Secure MCP Tunnel ID rather than reusing the workstation tunnel.

## Control window

The control window has six sections — Overview, Folders, Capabilities, Integrations, Activity and Settings — plus a console drawer pinned to the bottom of every one of them.

| Shortcut | Action |
| --- | --- |
| `Ctrl+K` | Command menu |
| `Ctrl+1` … `Ctrl+6` | Jump to a section |
| `` Ctrl+` `` | Show/hide the console drawer |
| `Ctrl+F` | Focus the log filter |

### Logs

Diagnostics are pushed to the window as they are written, not polled. The same view is available twice: as the collapsible console drawer, which stays visible while you work in any section, and as the full-height **Activity** section. Both filter by level and by substring, and both can copy or export the whole log.

Clearing the panel clears only what the window is holding. The on-disk log file is deliberately kept.

### Tool-call counters

**Overview** reports, for the current run of the app and across every reconnect: total tool calls, failures, failure rate, average duration, endpoint requests, rejected requests, calls for tools that are not currently published, and the slowest call with the tool responsible. **Capabilities** breaks the same counters down per tool, including the most recent failure message, and keeps a withdrawn tool visible while it still has history so turning a capability off does not erase what it did.

A tool reports failure in-band, so a call counts as failed when its result is flagged as an error — not only when it throws. Failure text is redacted and truncated like any other diagnostic. **Reset** starts the counters over.

### Startup

**Settings** has four independent, opt-out-by-default switches:

- **Start when I sign in** registers a per-user login item. It is only available from an installed build, and the switch reflects the registration the OS actually holds rather than the stored preference.
- **Start hidden in the tray** skips the control window at sign-in. Open it again from the tray icon.
- **Connect automatically** connects once startup settles and retries on a widening backoff if the network is not up yet. It never retries an authentication or configuration failure, and it defers to the tunnel's own recovery once a tunnel exists.
- **Keep running when the window is closed** hides the window instead of quitting the connector.

The tray icon shows connection state and offers connect/disconnect, open control window, open log file and quit. If the platform provides no tray, the app keeps a normal window lifetime instead — closing the last window quits it.

When a custom connector identity is configured, the title bar, Overview connection facts, tray tooltip and tray menu show that identity so separate machines are easy to distinguish during remote administration.

## Building

### Windows

```powershell
npm run dist:x64
npm run dist:arm64
```

Unpacked packages for smoke/debug work:

```powershell
npm run dist:dir:x64
npm run dist:dir:arm64
```

### Linux

```sh
npm run dist:linux:x64
npm run dist:linux:arm64
```

macOS packaging and native support are intentionally not part of this fork.

Packaging pins and verifies `tunnel-client` and ripgrep and stages only the target architecture's native `node-pty` payload. `scripts/smoke-packaged-runtime.mjs` verifies the actual packaged runtime, not just the TypeScript bundle.

## Verification

```powershell
npm run typecheck
npm test
npm run build
npm run verify
```

The focused tool suite covers batching, stale-read refusal, atomic edit batches, both patch formats, non-destructive rollback, typed git, yielded terminal polling, durable background output, archive traversal safety, JSON dry-run mutation, skill discovery, project orientation, symbol attribution, focused test execution, scoped typechecking, and streaming file-transfer security including no-overwrite publication, SSRF-resistant ChatGPT ingress, source-identity races, and ambiguous OpenAI upload outcomes.

The desktop-shell suites cover preference loading and config-read failure, login-item escaping and registration refusal, tool-call/request counting with its bounded per-tool table, and the log merge/filter used by both log panes.

## Security model

`localMCP-chat` is a local capability boundary, not a VM sandbox.

- MCP listens on loopback and uses an unguessable path token.
- Approved roots constrain built-in filesystem operations.
- Write, Receive files, Send files to OpenAI, Shell, Git, and Plugins are independently disableable at runtime. Sending local file bytes is a separate explicit egress capability and defaults off.
- Shell commands intentionally run with the privileges of the logged-in OS account. Root approval limits where they start; it is not an OS-level sandbox for arbitrary commands.
- API/plugin credentials are encrypted with Electron `safeStorage` when the host provides a protected backend.
- Diagnostic logs are bounded and redact token-shaped credentials before storage.
- The control window runs with context isolation, sandboxing and a Content-Security-Policy, loads no remote content, and hands links to the system browser only when they are `https:`.
- There is no browser-extension bridge, DOM observer, conversation recorder, or ChatGPT-tab automation.

See [`SECURITY.md`](SECURITY.md) for the full boundary description.

## Architecture

```text
ChatGPT
   │ MCP over tunnel
   ▼
OpenAI tunnel-client / cloudflared / manual HTTPS endpoint
   │
   ▼
127.0.0.1 tokenized Streamable HTTP MCP endpoint
   │
   ├─ built-in adapter
   │    ├─ approved-root filesystem + read cache
    │    ├─ read / find / edit / patch / git
    │    ├─ archive / json / skill
     │    ├─ project / symbols / test / typecheck
     │    ├─ file_transfer -> ChatGPT-native files / public OpenAI Files API
   │    ├─ unified live exec manager
   │    └─ durable background job manager
   │
   └─ external MCP plugin manager

Electron main process
   ├─ config / permissions / desktop preferences
   ├─ OS-backed secret storage
   ├─ tunnel lifecycle + auto-connect
   ├─ tray, login item, window lifetime
   ├─ tool-call and request counters
   └─ compact control-window IPC, pushed on change
```

The MCP adapter intentionally keeps rich internal state internal and returns compact model-facing text/structured content. This follows the same useful boundary pattern seen in OpenCode's ACP integration without importing OpenCode's full session/runtime graph.

## Lineage

This fork was rebuilt from the MIT-licensed Chat On Steroids repository, retaining selected low-level infrastructure such as the secure tunnel adapter, sandbox primitives, secret storage, MCP plugin transport, and Codex-derived patch/terminal foundations. The product composition, connector model, UI, and coding-tool surface were rewritten for `localMCP-chat`.

Tool ergonomics and several safety/economy patterns are informed by OpenCode, especially batched reads, precise-vs-bulk mutation routing, typed git, and background-pollable shell jobs.

The original MIT copyright notice is preserved in [`LICENSE`](LICENSE), and retained third-party plugin notices remain under [`docs/licenses`](docs/licenses).
