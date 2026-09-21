# Contributing

`localMCP-chat` is a Windows-first local MCP tunnel and coding-capability router. Focused fixes and concrete improvements are welcome.

## Development

Node.js 22+ is required.

```sh
npm ci
npm run verify:ci
npm run dev
```

Read [`AGENTS.md`](AGENTS.md) before changing architecture-sensitive code. Keep changes scoped, preserve unrelated dirty work, and add deterministic regression coverage for behavior changes where practical.

## Design constraints

- Keep one MCP connector instance per application process; its advertised identity may be configured per machine.
- Browser/ChatGPT DOM automation, conversation recording, worker agents and computer-use are intentionally out of scope.
- Built-in filesystem tools stay inside explicitly approved roots.
- Runtime permission checks are authoritative even if an MCP client cached an older schema.
- Prefer batching existing tools over growing the public tool count.
- Recovery/rollback never overwrites a newer concurrent local edit.
- External MCP plugins are separate trust boundaries; do not imply the built-in approved-root sandbox contains them.

## Packaging

Windows:

```sh
npm run dist:x64
npm run dist:arm64
```

Linux:

```sh
npm run dist:linux:x64
npm run dist:linux:arm64
```

macOS is not a supported target in this fork.

Packaging/runtime changes should exercise `scripts/smoke-packaged-runtime.mjs` on the native target. Cross-target packaging alone is not proof that native modules work.

## Pull requests

Explain the root cause, the invariant established, and the exact verification performed. Do not include credentials, private paths, conversation contents, debugging debris, or unrelated formatting changes.

Contributions are accepted under the MIT license in [`LICENSE`](LICENSE).
