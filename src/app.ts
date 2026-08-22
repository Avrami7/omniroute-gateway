import express, { type Application, type ErrorRequestHandler } from 'express';
import type pino from 'pino';
import type { GatewayConfig } from './config/env.js';
import type { ChatRouter } from './router/chatRouter.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { createRequestLogger } from './middleware/requestLogger.js';
import { createHealthRoute } from './routes/health.js';
import { createChatCompletionsRoute } from './routes/chatCompletions.js';

export interface AppDeps {
  config: GatewayConfig;
  logger: pino.Logger;
  chatRouter: ChatRouter;
}

/**
 * Builds (but does not start) the Express application, so tests can drive
 * it directly with supertest.
 */
export function buildApp(deps: AppDeps): Application {
  const { config, logger, chatRouter } = deps;
  const app = express();

  app.use(express.json());
  app.use(createRequestLogger(logger));

  // Unauthenticated, mounted before the auth middleware below.
  app.use('/health', createHealthRoute(config));

  // Everything under /v1 requires a valid bearer token.
  app.use('/v1', createAuthMiddleware(config), createChatCompletionsRoute(chatRouter));

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    logger.error({ err }, 'unhandled error');
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(errorHandler);

  return app;
}
