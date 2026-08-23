import { defineConfig } from 'tsdown';

/**
 * Build the host entry (and its bundled declaration file) for npm and
 * workspace installs. Platform peers stay external: the host provides them at
 * runtime; only schemastery is bundled-adjacent and it too stays external to
 * keep the tarball minimal and the dependency story honest.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: false,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/schemastery',
    ],
  },
});
