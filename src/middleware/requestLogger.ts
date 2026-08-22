import { pinoHttp } from 'pino-http';
import type pino from 'pino';
import type { RequestHandler } from 'express';

/**
 * pino-http request logging, configured so request bodies and the bearer
 * token never reach the log sink — not merely redacted-in-place, but left
 * out of the serialized object entirely.
 *
 * The default pino-http req serializer never includes `body` in the first
 * place, but we build the serialized object explicitly here rather than
 * relying on that default, so this stays true even if pino-http's default
 * fields change, or something upstream attaches a `body` property to the
 * request object pino-http passes to the serializer.
 */
export function createRequestLogger(logger: pino.Logger): RequestHandler {
  return pinoHttp({
    logger,
    serializers: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      req(req: any) {
        const headers = (req.headers ?? {}) as Record<string, unknown>;
        const { authorization: _authorization, ...safeHeaders } = headers;
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          headers: safeHeaders,
          remoteAddress: req.remoteAddress,
          remotePort: req.remotePort,
        };
      },
    },
  });
}
