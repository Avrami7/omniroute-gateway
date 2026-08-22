import pino from 'pino';

export function createLogger(level: string): pino.Logger {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', 'apiKey', 'req.body'],
      remove: true,
    },
  });
}
