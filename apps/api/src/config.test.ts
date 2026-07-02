import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const envKeys = [
  "INTERNAL_API_TOKEN",
  "MISTRAL_EXECUTION_MODE"
] as const;

const originalEnv = new Map<string, string | undefined>();

describe("loadConfig", () => {
  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
  });

  it("defaults Mistral execution mode to sync", () => {
    expect(loadConfig().MISTRAL_EXECUTION_MODE).toBe("sync");
  });

  it("accepts batch execution mode", () => {
    process.env.MISTRAL_EXECUTION_MODE = "batch";

    expect(loadConfig().MISTRAL_EXECUTION_MODE).toBe("batch");
  });

  it("rejects unsupported execution modes", () => {
    process.env.MISTRAL_EXECUTION_MODE = "inline";

    expect(() => loadConfig()).toThrow();
  });
});
