import { defineConfig } from 'vitest/config';

/**
 * True-host contract specs (TC-B4-W1, 32C precedent shape): they import the
 * mainline `zDSH-main` sibling and fail loud when it is missing, so they are
 * deliberately outside the default run below (include only picks `*.test.ts`
 * / `*.test.tsx`; contract specs are `*.spec.ts`). Run them via
 * `pnpm test:contract` (see `vitest.contract.config.ts`).
 */
export const CONTRACT_SPECS: string[] = ['tests/tools-host-contract.spec.ts'];

export default defineConfig({
  test: {
    // Unit tests must never touch the real network; live probes (if ever
    // added) are env-gated and skipped by default.
    restoreMocks: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
