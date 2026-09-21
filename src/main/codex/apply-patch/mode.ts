/**
 * `ApplyPatchFileUpdateMode` from `codex-rs/apply-patch/src/lib.rs`.
 *
 * Controls how updates reconstruct the target file after matching a patch.
 */
export type ApplyPatchFileUpdateMode =
  /** Preserve the historical upstream behavior of normalizing updated files to LF. */
  | 'normalize_to_lf'
  /** Preserve existing line endings and infer a local ending for newly introduced lines. */
  | 'preserve_line_endings';

/**
 * localMCP's safe default. Upstream Codex historically normalizes updated files to LF, but that
 * is a destructive default for a general-purpose editor because a one-line semantic patch can
 * rewrite every CRLF in the file. Preserve/infer is therefore the default at every local entry
 * point; callers that explicitly need upstream parity can still request `normalize_to_lf`.
 */
export const DEFAULT_APPLY_PATCH_FILE_UPDATE_MODE: ApplyPatchFileUpdateMode = 'preserve_line_endings';
