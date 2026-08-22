import { z } from 'zod';
import { configuredProviders } from './routing.js';
import type { ProviderName } from '../types/gateway.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  GATEWAY_API_KEY: z.string().min(16, 'GATEWAY_API_KEY must be at least 16 characters'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface GatewayConfig {
  port: number;
  gatewayApiKey: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  providerKeys: Partial<Record<ProviderName, string>>;
}

const providerEnvVar: Record<ProviderName, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * Parses and validates process.env, then cross-checks that every provider
 * referenced in the routing table has a configured key. Throws a
 * descriptive error rather than exiting, so callers (and tests) can decide
 * how to handle failure; src/index.ts is responsible for exiting the
 * process on error.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = envSchema.parse(env);

  const providerKeys: Partial<Record<ProviderName, string>> = {
    anthropic: parsed.ANTHROPIC_API_KEY,
    openai: parsed.OPENAI_API_KEY,
  };

  const missing = configuredProviders().filter((provider) => !providerKeys[provider]);
  if (missing.length > 0) {
    const varNames = missing.map((provider) => providerEnvVar[provider]).join(', ');
    throw new Error(
      `Missing API key(s) for provider(s) referenced in routing.ts: ${missing.join(', ')}. ` +
        `Set the following environment variable(s): ${varNames}`,
    );
  }

  return {
    port: parsed.PORT,
    gatewayApiKey: parsed.GATEWAY_API_KEY,
    logLevel: parsed.LOG_LEVEL,
    providerKeys,
  };
}
