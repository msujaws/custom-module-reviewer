import { describe, test, expect } from "bun:test";
import { loadEnv, EnvSchema } from "../src/config.ts";

describe("EnvSchema", () => {
  test("requires all three API keys", () => {
    expect(() => EnvSchema.parse({})).toThrow();
    expect(() =>
      EnvSchema.parse({
        BUGZILLA_API_KEY: "a",
        PHABRICATOR_API_TOKEN: "b",
      }),
    ).toThrow();
  });

  test("accepts a full env", () => {
    const parsed = EnvSchema.parse({
      BUGZILLA_API_KEY: "a",
      PHABRICATOR_API_TOKEN: "b",
      ANTHROPIC_API_KEY: "c",
    });
    expect(parsed.ANTHROPIC_API_KEY).toBe("c");
  });
});

describe("loadEnv", () => {
  test("does not require ANTHROPIC_API_KEY in dry-run mode", () => {
    const env = loadEnv(
      { BUGZILLA_API_KEY: "a", PHABRICATOR_API_TOKEN: "b" },
      { dryRun: true },
    );
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  test("throws with a helpful message when keys are missing", () => {
    expect(() => loadEnv({}, { dryRun: false })).toThrow(/BUGZILLA_API_KEY/);
  });
});
