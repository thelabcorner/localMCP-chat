import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // Keep node_modules external so the MCP SDK ships as real files in the asar
    // rather than being inlined by the bundler.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/clean/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/clean/preload/index.ts') }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/clean/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/clean/renderer/index.html') }
    }
  }
});
