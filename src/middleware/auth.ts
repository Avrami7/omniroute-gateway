import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { GatewayConfig } from '../config/env.js';

const BEARER_PREFIX = 'Bearer ';

/**
 * Constant-time comparison of two strings via Buffer + timingSafeEqual.
 * timingSafeEqual throws if the buffers differ in length, so a length
 * mismatch is treated as a straightforward "not equal" rather than an
 * exception the caller has to handle.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Bearer-token auth middleware, checked against config.gatewayApiKey.
 *
 * This intentionally has no built-in path exemption (e.g. for /health) —
 * callers mount it only on the routes that require auth (see app.ts, which
 * mounts it under /v1 and mounts /health separately, before this).
 */
export function createAuthMiddleware(config: GatewayConfig) {
  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization');
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const token = header.slice(BEARER_PREFIX.length);
    if (!safeEqual(token, config.gatewayApiKey)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    next();
  };
}
