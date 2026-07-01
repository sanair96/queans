import cors from "@fastify/cors";
import Fastify from "fastify";

import type { ApiConfig } from "./config.js";
import { registerRoutes } from "./routes.js";

export async function buildServer(config: ApiConfig) {
  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: [config.APP_URL],
    credentials: false
  });

  registerRoutes(app, config);

  return app;
}
