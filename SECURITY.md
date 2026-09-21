# Security policy

## Reporting

Use the repository host's private vulnerability-reporting mechanism for security issues rather than a public issue. Include the smallest useful reproduction, application version, Windows/Linux version and architecture, and which localMCP-chat permissions were enabled. Remove credentials, private paths, file contents, account identifiers, and tunnel URLs/tokens from reports.

## Security model

`localMCP-chat` is a permission boundary between an MCP client and the logged-in OS user running the application.

- MCP binds to loopback on an unguessable path. Remote reachability exists only through the configured tunnel.
- Built-in filesystem operations canonicalize paths and enforce explicit approved roots.
- Read, Write, Shell, Git, and Plugins are independently switchable. Every call checks current state; schema discovery is not authorization.
- A known stale read blocks a write until the file is reread.
- Multi-file patches preflight before commit and use compare-before-restore rollback so recovery cannot overwrite a newer external edit.
- `exec_command` and background shell jobs run with the normal privileges of the logged-in OS account. Starting inside an approved root does **not** kernel-sandbox arbitrary commands.
- Process/session IDs authorize only processes this application owns. Persisted job history does not authorize adopting an unknown live PID after restart.
- OpenAI and plugin credentials use Electron `safeStorage`. Plaintext secret values are not returned to the renderer or model.
- Diagnostic logs are bounded and redact credential-shaped values before persistence.
- There is no Chrome/Edge companion, ChatGPT DOM bridge, conversation recorder, browser automation, worker-chat system, or computer-use input surface.

## External MCP servers

Third-party MCP servers are separate trust boundaries. A local executable can generally do whatever the logged-in user could do; a remote service handles whatever data its tool receives. The built-in approved-folder policy does not sandbox arbitrary external MCP servers. Review an integration before enabling it and disable plugin access when it is not needed.

## Expected limitations

- Application path checks are not a VM, container, or kernel sandbox. Same-user filesystem races are possible in principle.
- Shell and git write capabilities are intentionally powerful.
- Release binaries may be unsigned, so Windows SmartScreen or other security software can warn. Verify release hashes when distributing binaries.
- Linux secret storage depends on a protected desktop keyring backend; the application refuses Electron's insecure/basic fallback.

## Scope

In scope: the Electron application, built-in MCP endpoint/tools, tunnel adapter, approved-root enforcement, credential storage, process ownership, external-MCP aggregation, and Windows/Linux packaging.

Out of scope: ChatGPT/OpenAI infrastructure, Electron/Chromium upstream, `tunnel-client`, `cloudflared`, ripgrep, third-party MCP servers, and macOS support.
