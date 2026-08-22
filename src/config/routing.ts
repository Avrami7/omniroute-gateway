import type { ProviderName } from '../types/gateway.js';

export interface RouteRule {
  prefix: string;
  provider: ProviderName;
}

export interface FallbackRule {
  primaryModel: string;
  fallbackModel: string;
}

/**
 * Model prefix -> provider. Adding a provider later means one new adapter
 * file plus one new entry here — nothing else changes.
 */
export const routeRules: RouteRule[] = [
  { prefix: 'claude-', provider: 'anthropic' },
  { prefix: 'gpt-', provider: 'openai' },
];

/**
 * Single-hop fallback: if the primary model's provider errors retryably,
 * the router retries once against the mapped fallback model. No chains.
 */
export const fallbackRules: FallbackRule[] = [
  { primaryModel: 'claude-opus-5', fallbackModel: 'gpt-4o' },
  { primaryModel: 'claude-sonnet-5', fallbackModel: 'gpt-4o' },
  { primaryModel: 'gpt-4o', fallbackModel: 'claude-sonnet-5' },
];

export function resolveProvider(model: string): ProviderName | undefined {
  return routeRules.find((rule) => model.startsWith(rule.prefix))?.provider;
}

export function resolveFallback(model: string): string | undefined {
  return fallbackRules.find((rule) => rule.primaryModel === model)?.fallbackModel;
}

/** All providers referenced by routeRules, for env-validation at startup. */
export function configuredProviders(): ProviderName[] {
  return [...new Set(routeRules.map((rule) => rule.provider))];
}
