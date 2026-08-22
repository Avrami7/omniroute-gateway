import express, { type Router } from 'express';
import type { GatewayConfig } from '../config/env.js';
import type { ProviderName } from '../types/gateway.js';

/**
 * GET /health — unauthenticated. Lists which providers have a configured
 * key (names only, never the key values) so operators can sanity-check
 * deployment without exposing secrets.
 */
export function createHealthRoute(config: GatewayConfig): Router {
  const router = express.Router();

  const providers = (Object.keys(config.providerKeys) as ProviderName[]).filter(
    (name) => !!config.providerKeys[name],
  );

  router.get('/', (_req, res) => {
    res.status(200).json({ status: 'ok', providers });
  });

  return router;
}
