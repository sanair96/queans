import { fileURLToPath } from "node:url";

export function resolveWorkflowEntryPath(entrypointUrl: string) {
  const extension = entrypointUrl.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(new URL(`./workflows/index.${extension}`, entrypointUrl));
}
