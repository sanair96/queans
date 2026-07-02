import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const envFile = findWorkspaceEnvFile([process.cwd(), dirname(fileURLToPath(import.meta.url))]);

if (envFile) {
  config({ path: envFile, quiet: true });
}

export function findWorkspaceEnvFile(startDirectories: readonly string[]) {
  for (const startDirectory of startDirectories) {
    const workspaceRoot = findWorkspaceRoot(startDirectory);
    const envPath = workspaceRoot ? join(workspaceRoot, ".env") : undefined;
    if (envPath && existsSync(envPath)) {
      return envPath;
    }
  }

  return undefined;
}

export function findWorkspaceRoot(startDirectory: string) {
  const workspaceFile = findFileUpward(startDirectory, "pnpm-workspace.yaml");
  if (workspaceFile) {
    return dirname(workspaceFile);
  }

  return findPackageRoot(startDirectory);
}

function findPackageRoot(startDirectory: string) {
  let currentDirectory = resolve(startDirectory);
  const rootDirectory = parse(currentDirectory).root;

  while (true) {
    const packageJson = join(currentDirectory, "package.json");
    if (existsSync(packageJson) && isWorkspacePackageJson(packageJson)) {
      return currentDirectory;
    }

    if (currentDirectory === rootDirectory) {
      return undefined;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}

function isWorkspacePackageJson(path: string) {
  try {
    const packageJson = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return (
      packageJson !== null &&
      typeof packageJson === "object" &&
      "workspaces" in packageJson &&
      Boolean((packageJson as { workspaces?: unknown }).workspaces)
    );
  } catch {
    return false;
  }
}

export function findFileUpward(filePath: string, fileName: string, stopDirectory = parse(resolve(filePath)).root) {
  let currentDirectory = resolve(filePath);
  const boundaryDirectory = resolve(stopDirectory);

  while (true) {
    const candidate = join(currentDirectory, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }

    if (currentDirectory === boundaryDirectory) {
      return undefined;
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }

    currentDirectory = parentDirectory;
  }
}
