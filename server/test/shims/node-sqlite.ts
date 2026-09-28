// Vitest 2.x's bundled vite predates the `node:sqlite` builtin and fails to
// resolve it from transformed source files (it strips the `node:` prefix and
// looks for a 'sqlite' module). Load it through createRequire instead; the
// alias in vitest.config.ts routes `node:sqlite` imports here during tests.
import { createRequire } from 'node:module';

const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
