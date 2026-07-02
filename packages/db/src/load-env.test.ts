import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findFileUpward, findWorkspaceEnvFile, findWorkspaceRoot } from "./load-env.js";

describe("findWorkspaceEnvFile", () => {
  it("loads the workspace root .env from a nested package directory", () => {
    const root = mkdtempSync(join(tmpdir(), "queans-env-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgresql://test\n");
      const nestedDirectory = join(root, "apps", "api", "src");

      expect(findWorkspaceEnvFile([nestedDirectory])).toBe(join(root, ".env"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the workspace root .env over package-local env files", () => {
    const root = mkdtempSync(join(tmpdir(), "queans-env-"));
    try {
      const appDirectory = join(root, "apps", "api");
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
      writeFileSync(join(root, ".env"), "DATABASE_URL=postgresql://root\n");
      mkdirSync(appDirectory, { recursive: true });
      writeFileSync(join(appDirectory, ".env"), "DATABASE_URL=postgresql://app\n");

      expect(findWorkspaceEnvFile([join(appDirectory, "src")])).toBe(join(root, ".env"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findWorkspaceRoot", () => {
  it("finds a pnpm workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "queans-env-"));
    try {
      writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");

      expect(findWorkspaceRoot(join(root, "packages", "db", "src"))).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("findFileUpward", () => {
  it("returns undefined when no .env exists before the stop directory", () => {
    const root = mkdtempSync(join(tmpdir(), "queans-env-"));
    try {
      expect(findFileUpward(join(root, "packages", "db", "src"), ".env", root)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
