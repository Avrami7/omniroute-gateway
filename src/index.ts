import 'dotenv/config';
import { loadConfig, type GatewayConfig } from './config/env.js';
import { createLogger } from './logger.js';
import { createChatRouter } from './router/chatRouter.js';
import { buildApp } from './app.js';
// NOTE: the provider-adapter half of the codebase (src/providers/*),
// including registry.ts, is being written concurrently in a separate
// stream of work. It is not present at the time this file is authored;
// wiring it in here is the only place that dependency is needed.
import { createRegistry } from './providers/registry.js';

let config: GatewayConfig;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const registry = createRegistry(config);
const chatRouter = createChatRouter(registry, logger);
const app = buildApp({ config, logger, chatRouter });

app.listen(config.port, () => {
  logger.info({ port: config.port }, 'omniroute-gateway listening');
});
