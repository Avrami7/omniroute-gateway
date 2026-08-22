import type { ProviderAdapter, ProviderName } from '../types/gateway.js';
import type { GatewayConfig } from '../config/env.js';
import { resolveProvider } from '../config/routing.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createOpenAIAdapter } from './openai.js';

export interface ProviderRegistry {
  getAdapter(provider: ProviderName): ProviderAdapter;
  getAdapterForModel(model: string): ProviderAdapter;
}

/**
 * Lazily constructs and caches one adapter per provider, using the API key
 * loaded into `config.providerKeys`. `loadConfig()` already fails fast at
 * startup if any provider referenced by the routing table is missing its
 * key, so the missing-key guard here should be unreachable in practice --
 * it exists for safety and testability (e.g. constructing a registry
 * directly from a hand-built config in a test).
 */
export function createRegistry(config: GatewayConfig): ProviderRegistry {
  const cache = new Map<ProviderName, ProviderAdapter>();

  function buildAdapter(provider: ProviderName): ProviderAdapter {
    const apiKey = config.providerKeys[provider];
    if (!apiKey) {
      throw new Error(
        `No API key configured for provider '${provider}'. Set the corresponding environment variable before using this provider.`,
      );
    }

    switch (provider) {
      case 'anthropic':
        return createAnthropicAdapter(apiKey);
      case 'openai':
        return createOpenAIAdapter(apiKey);
      default: {
        // Exhaustiveness guard: if ProviderName grows, this line fails to
        // compile until a case is added above.
        const _exhaustive: never = provider;
        throw new Error(`Unhandled provider: ${String(_exhaustive)}`);
      }
    }
  }

  return {
    getAdapter(provider: ProviderName): ProviderAdapter {
      const cached = cache.get(provider);
      if (cached) {
        return cached;
      }
      const adapter = buildAdapter(provider);
      cache.set(provider, adapter);
      return adapter;
    },

    getAdapterForModel(model: string): ProviderAdapter {
      const provider = resolveProvider(model);
      if (!provider) {
        throw new Error(`Unrecognized model '${model}': no configured provider matches it.`);
      }
      return this.getAdapter(provider);
    },
  };
}
