import cors from "@fastify/cors";
import Fastify from "fastify";
import { ZodError } from "zod";

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

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message
        }))
      });
    }

    return reply.send(error);
  });

  registerRoutes(app, config);

  return app;
}
