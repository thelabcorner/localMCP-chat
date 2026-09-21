# Changelog

All notable public changes to localMCP-chat are documented here.

## [0.2.0] — 2026-09-20

First public release of localMCP-chat.

### Added

- Official Windows x64 and ARM64 installers.
- Official Linux x64 and ARM64 AppImage and Debian packages.
- SHA-256 release manifest covering every published binary.
- Approved-root coding tools: batched reads, precise edits, atomic multi-file patches, typed Git, project/symbol/test/typecheck helpers, archive/JSON/skill tooling, and managed foreground/background processes.
- Bidirectional file transfer between ChatGPT/OpenAI file storage and explicitly approved local folders, with local-file egress disabled by default.
- External MCP integration management behind a stable gateway plus the optional native OpenCode Control integration.
- Secret-free declarative Windows deployment configuration and OS-backed credential storage.

### Security and release hardening

- Runtime Read/Write/Shell/Git/Plugins/file-transfer authority is rechecked on every call.
- Filesystem operations enforce canonical approved-root containment and symlink boundaries.
- Known stale reads block mutation, and multi-file rollback never overwrites a newer concurrent edit.
- Release CI executes verification and packaged-runtime smoke tests on each native target; Linux x64 additionally validates an Ubuntu 20.04 / glibc 2.31 compatibility floor.
- Public-history privacy verification blocks known private maintainer identifiers and workstation-specific paths from entering releasable history.
- Public distribution starts from a clean root history rather than exposing private preview tags or development ancestry.

### Notes

- Release binaries are currently unsigned. Verify downloads against `SHA256SUMS.txt`.
- macOS is intentionally unsupported.

## Private preview builds

Versions 0.1.0–0.1.2 were private release-validation builds and are intentionally not part of the public repository history.
