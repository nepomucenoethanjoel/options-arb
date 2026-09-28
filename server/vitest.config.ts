import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        // Vitest 2.x's bundled vite predates the `node:sqlite` builtin and
        // mangles the import in transformed files (src/storage/sqlite.ts).
        // Route it to a createRequire shim during tests only.
        find: /^node:sqlite$/,
        replacement: fileURLToPath(new URL('./test/shims/node-sqlite.ts', import.meta.url)),
      },
    ],
  },
});
