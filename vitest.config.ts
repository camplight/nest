import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Product fixtures have no federation peers and dispose embedded engine DBs.
    // Upstream's poller currently outlives db.close(); engine tests run separately.
    env: { ORGOPS_FEDERATION_SYNC_INTERVAL_MS: '0' },
    // The CLI uses node:test and runs through its own workspace script.
    exclude: [...configDefaults.exclude, "apps/cli/test/**", "vendor/**"],
  },
});
