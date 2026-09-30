import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({test: {
  env: {ORGOPS_PROJECT_ROOT: fileURLToPath(new URL('./vendor/orgops', import.meta.url))},
  include: ['apps/{api,agent-runner}/src/**/*.test.ts', 'packages/**/*.test.ts'],
}});
