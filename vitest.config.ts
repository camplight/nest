import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The CLI uses node:test and runs through its own workspace script.
    exclude: [...configDefaults.exclude, "apps/cli/test/**"],
  },
});
