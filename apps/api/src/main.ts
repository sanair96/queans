import "@queans/db/load-env";

import { loadConfig } from "./config.js";
import { startOutboxDispatcher } from "./outbox.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = await buildServer(config);
const stopDispatcher = startOutboxDispatcher(config);

const shutdown = async () => {
  stopDispatcher();
  await app.close();
};

process.on("SIGINT", () => {
  shutdown()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
});

process.on("SIGTERM", () => {
  shutdown()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
});

await app.listen({
  port: config.API_PORT,
  host: "0.0.0.0"
});
