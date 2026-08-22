import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createChatRouter } from '../../src/router/chatRouter.js';
import { GatewayProviderError } from '../../src/types/gateway.js';
import type {
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedStreamEvent,
  ProviderAdapter,
} from '../../src/types/gateway.js';

// Real fallback rules live in src/config/routing.ts and are used as-is by
// chatRouter (resolveFallback is not injectable): claude-opus-5 -> gpt-4o,
// claude-sonnet-5 -> gpt-4o, gpt-4o -> claude-sonnet-5. 'claude-haiku-9' is
// deliberately not in that table, to exercise the no-fallback-mapping path.

const logger = pino({ level: 'silent' });

function baseRequest(model: string): NormalizedChatRequest {
  return {
    requestedModel: model,
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 100,
    stream: false,
  };
}

function makeResponse(overrides: Partial<NormalizedChatResponse> = {}): NormalizedChatResponse {
  return {
    id: 'resp-1',
    provider: 'anthropic',
    modelUsed: 'claude-opus-5',
    content: 'hello',
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
    ...overrides,
  };
}

function makeAdapter(
  name: ProviderAdapter['name'],
  opts: {
    send?: ProviderAdapter['send'];
    stream?: ProviderAdapter['stream'];
  } = {},
): ProviderAdapter {
  return {
    name,
    send: opts.send ?? (async () => makeResponse({ provider: name })),
    stream: opts.stream ?? (async function* () {}),
  };
}

describe('createChatRouter - handleChat', () => {
  it('returns the primary result when it succeeds; fallback is never attempted', async () => {
    const fallbackSend = vi.fn();
    const primary = makeAdapter('anthropic', {
      send: async () => makeResponse({ id: 'primary-ok' }),
    });
    const fallback = makeAdapter('openai', { send: fallbackSend });

    const router = createChatRouter(
      { getAdapterForModel: (model) => (model === 'claude-opus-5' ? primary : fallback) },
      logger,
    );

    const result = await router.handleChat(baseRequest('claude-opus-5'));
    expect(result.id).toBe('primary-ok');
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  it('falls back to the mapped model when the primary throws a retryable error', async () => {
    const primary = makeAdapter('anthropic', {
      send: async () => {
        throw new GatewayProviderError('rate limited', 'anthropic', 'retryable', 429);
      },
    });
    const fallback = makeAdapter('openai', {
      send: async (req) =>
        makeResponse({ id: 'fallback-ok', provider: 'openai', modelUsed: req.requestedModel }),
    });

    const router = createChatRouter(
      { getAdapterForModel: (model) => (model === 'claude-opus-5' ? primary : fallback) },
      logger,
    );

    const result = await router.handleChat(baseRequest('claude-opus-5'));
    expect(result.id).toBe('fallback-ok');
    expect(result.modelUsed).toBe('gpt-4o');
  });

  it('rethrows a client_error immediately; fallback is never attempted', async () => {
    const fallbackSend = vi.fn();
    const primary = makeAdapter('anthropic', {
      send: async () => {
        throw new GatewayProviderError('bad request', 'anthropic', 'client_error', 400);
      },
    });
    const fallback = makeAdapter('openai', { send: fallbackSend });

    const router = createChatRouter(
      { getAdapterForModel: (model) => (model === 'claude-opus-5' ? primary : fallback) },
      logger,
    );

    await expect(router.handleChat(baseRequest('claude-opus-5'))).rejects.toMatchObject({
      errorClass: 'client_error',
    });
    expect(fallbackSend).not.toHaveBeenCalled();
  });

  it('rethrows a retryable error when no fallback mapping exists for the model', async () => {
    const primary = makeAdapter('anthropic', {
      send: async () => {
        throw new GatewayProviderError('rate limited', 'anthropic', 'retryable', 429);
      },
    });

    const router = createChatRouter({ getAdapterForModel: () => primary }, logger);

    await expect(router.handleChat(baseRequest('claude-haiku-9'))).rejects.toMatchObject({
      errorClass: 'retryable',
    });
  });
});

describe('createChatRouter - handleChatStream', () => {
  it('falls back cleanly with zero events lost/duplicated when the first event errors', async () => {
    const primary = makeAdapter('anthropic', {
      // eslint-disable-next-line require-yield -- deliberately throws before ever yielding
      stream: async function* (): AsyncIterable<NormalizedStreamEvent> {
        throw new GatewayProviderError('rate limited', 'anthropic', 'retryable', 429);
      },
    });
    const fallback = makeAdapter('openai', {
      stream: async function* (): AsyncIterable<NormalizedStreamEvent> {
        yield { type: 'delta', textDelta: 'hi' };
        yield { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    });

    const router = createChatRouter(
      { getAdapterForModel: (model) => (model === 'claude-opus-5' ? primary : fallback) },
      logger,
    );

    const events: NormalizedStreamEvent[] = [];
    for await (const event of router.handleChatStream(baseRequest('claude-opus-5'))) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'delta', textDelta: 'hi' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
  });

  it('does not fall back and yields an error event when a later event errors', async () => {
    const fallbackStream = vi.fn();
    const primary = makeAdapter('anthropic', {
      stream: async function* (): AsyncIterable<NormalizedStreamEvent> {
        yield { type: 'delta', textDelta: 'partial' };
        throw new GatewayProviderError('connection dropped', 'anthropic', 'retryable');
      },
    });
    const fallback = makeAdapter('openai', { stream: fallbackStream });

    const router = createChatRouter(
      { getAdapterForModel: (model) => (model === 'claude-opus-5' ? primary : fallback) },
      logger,
    );

    const events: NormalizedStreamEvent[] = [];
    for await (const event of router.handleChatStream(baseRequest('claude-opus-5'))) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'delta', textDelta: 'partial' });
    expect(events[1]?.type).toBe('error');
    expect(fallbackStream).not.toHaveBeenCalled();
  });
});
