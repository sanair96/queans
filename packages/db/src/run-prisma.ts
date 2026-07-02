import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import "./load-env.js";

const require = createRequire(import.meta.url);
const prismaBin = require.resolve("prisma/build/index.js");

const child = spawn(process.execPath, [prismaBin, ...process.argv.slice(2)], {
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
