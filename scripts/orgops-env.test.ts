import { test, expect, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureOrgOpsEnv } from "./orgops-env";
for (const component of ["api", "runner"] as const)
  test(`launcher excludes provider service keys from ${component} and seeds Nest skill`, () => {
    const previous = { ...process.env },
      dir = mkdtempSync(join(tmpdir(), "nest-skill-launch-"));
    try {
      vi.stubEnv("NEST_ENGINE_DATA_DIR", dir);
      vi.stubEnv("NEST_COMPOSIO_API_KEY", "test-private");
      vi.stubEnv("ORGOPS_COMPOSIO_API_KEY", "test-private");
      vi.stubEnv("NEST_CONNECTION_METADATA_TOKEN", "test-private");
      vi.stubEnv("ORGOPS_CONNECTION_METADATA_TOKEN", "test-private");
      const result = configureOrgOpsEnv(component);
      for (const key of [
        "NEST_COMPOSIO_API_KEY",
        "ORGOPS_COMPOSIO_API_KEY",
        "NEST_CONNECTION_METADATA_TOKEN",
        "ORGOPS_CONNECTION_METADATA_TOKEN",
      ])
        expect(process.env[key]).toBeUndefined();
      expect(
        readFileSync(
          join(result.projectRoot, "skills/nest-connections/SKILL.md"),
          "utf8",
        ),
      ).toContain("name: nest-connections");
    } finally {
      process.env = previous;
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
