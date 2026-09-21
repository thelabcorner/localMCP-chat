/**
 * The live preload bridge, kept apart from the type declarations so `types.ts` stays free of
 * runtime code and can be imported by tests that never have a `window`.
 */

import type { LocalApi } from './types.js';

declare global {
  interface Window { localMcp: LocalApi }
}

export const api: LocalApi = window.localMcp;
