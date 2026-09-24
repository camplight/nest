import { describe, expect, it } from "vitest";
import { withLegacyRunnerEnv } from "./legacy-env";

describe("Nest wrapper environment compatibility", () => {
  it("exports both names for existing wrapper recipes and keeps Nest values authoritative", () => {
    const input = { NEST_API_URL: "https://nest.example.com", ORGOPS_API_URL: "https://old.example.com", NEST_WRAPPED_MESSAGE: "hello" };
    const env = withLegacyRunnerEnv(input);
    expect(env.ORGOPS_API_URL).toBe(input.NEST_API_URL);
    expect(env.ORGOPS_WRAPPED_MESSAGE).toBe("hello");
    expect(input.ORGOPS_API_URL).toBe("https://old.example.com");
  });
  it("accepts legacy-only configuration without altering unrelated secrets", () => {
    expect(withLegacyRunnerEnv({ ORGOPS_RUNNER_TOKEN: "legacy", API_KEY: "value" })).toEqual({
      NEST_RUNNER_TOKEN: "legacy", ORGOPS_RUNNER_TOKEN: "legacy", API_KEY: "value"
    });
  });
});
