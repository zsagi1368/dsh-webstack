import { defineConfig } from 'vitest/config';
import { CONTRACT_SPECS } from './vitest.config.ts';

/**
 * Opt-in runner for the true-host contract specs (TC-B4-W1, PluginCenter 32C
 * precedent shape). These import the mainline `zDSH-main` sibling and fail
 * loud when it is missing, so they are NOT part of the default `vitest run`
 * (the default include below only picks `*.test.ts` / `*.test.tsx`; contract
 * specs are `*.spec.ts`). Run locally — or in a matrix that checks out
 * zDSH-main as the sibling of zDSH-plugins — with `pnpm test:contract`,
 * which resolves to `vitest run --config vitest.contract.config.ts`.
 */
export default defineConfig({
  test: {
    include: [...CONTRACT_SPECS],
    environment: 'node',
    restoreMocks: true,
  },
});
