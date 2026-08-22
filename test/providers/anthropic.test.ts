import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicAdapter } from '../../src/providers/anthropic.js';
import type { AnthropicMessagesClient } from '../../src/providers/anthropic.js';
import { GatewayProviderError } from '../../src/types/gateway.js';
import type { NormalizedChatRequest, NormalizedStreamEvent } from '../../src/types/gateway.js';

function fakeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) {
            return { value: items[i++]!, done: false as const };
          }
          return { value: undefined, done: true as const };
        },
      };
    },
  };
}

/**
 * Builds a fake instance of one of the SDK's typed error classes without
 * depending on that class's exact constructor signature (which varies
 * across SDK versions and isn't available to inspect in this environment).
 * `instanceof` checks only require the correct prototype chain.
 */
function fakeSdkError<T extends Error>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctor: new (...args: any[]) => T,
  status: number | undefined,
  message: string,
): T {
  const err = Object.create(ctor.prototype) as T & { status?: number; message: string };
  err.status = status;
  err.message = message;
  return err;
}

async function expectGatewayError(
  promise: Promise<unknown>,
  provider: 'anthropic' | 'openai',
  errorClass: 'retryable' | 'client_error' | 'unknown',
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(GatewayProviderError);
  try {
    await promise;
    throw new Error('expected promise to reject, but it resolved');
  } catch (err) {
    const gatewayErr = err as GatewayProviderError;
    expect(gatewayErr.provider).toBe(provider);
    expect(gatewayErr.errorClass).toBe(errorClass);
  }
}

function baseRequest(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  return {
    requestedModel: 'claude-opus-5',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello there' },
    ],
    maxTokens: 1024,
    stream: false,
    ...overrides,
  };
}

describe('AnthropicAdapter.send', () => {
  it('maps a successful non-streaming response into a NormalizedChatResponse', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'msg_123',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'Hello! How can I help?' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 8 },
    });
    const client: AnthropicMessagesClient = {
      messages: { create, stream: vi.fn() },
    };
    const adapter = createAnthropicAdapter('fake-key', client);

    const result = await adapter.send(baseRequest());

    expect(result).toEqual({
      id: 'msg_123',
      provider: 'anthropic',
      modelUsed: 'claude-opus-5',
      content: 'Hello! How can I help?',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8 },
    });

    // system message must be pulled out to the top-level `system` field,
    // and not included in `messages`.
    const callArgs = create.mock.calls[0][0];
    expect(callArgs.system).toBe('You are a helpful assistant.');
    expect(callArgs.messages).toEqual([{ role: 'user', content: 'Hello there' }]);
    expect(callArgs.max_tokens).toBe(1024);
  });

  it('maps stop_reason "max_tokens" to finishReason "length"', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'msg_456',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'truncated...' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 5, output_tokens: 1024 },
    });
    const client: AnthropicMessagesClient = { messages: { create, stream: vi.fn() } };
    const adapter = createAnthropicAdapter('fake-key', client);

    const result = await adapter.send(baseRequest());
    expect(result.finishReason).toBe('length');
  });

  it.each([
    ['RateLimitError', Anthropic.RateLimitError, 429, 'retryable'],
    ['InternalServerError', Anthropic.InternalServerError, 529, 'retryable'],
    ['APIConnectionError', Anthropic.APIConnectionError, undefined, 'retryable'],
    ['BadRequestError', Anthropic.BadRequestError, 400, 'client_error'],
    ['AuthenticationError', Anthropic.AuthenticationError, 401, 'client_error'],
  ] as const)(
    'classifies %s as %s and wraps it in a GatewayProviderError',
    async (_name, ErrorCtor, status, expectedClass) => {
      const create = vi.fn().mockRejectedValue(fakeSdkError(ErrorCtor, status, 'boom'));
      const client: AnthropicMessagesClient = { messages: { create, stream: vi.fn() } };
      const adapter = createAnthropicAdapter('fake-key', client);

      await expectGatewayError(adapter.send(baseRequest()), 'anthropic', expectedClass);
    },
  );
});

describe('AnthropicAdapter.stream', () => {
  it('yields delta events followed by a done event for a simple fake stream', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    const stream = vi.fn().mockReturnValue(fakeAsyncIterable(events));
    const client: AnthropicMessagesClient = { messages: { create: vi.fn(), stream } };
    const adapter = createAnthropicAdapter('fake-key', client);

    const received: NormalizedStreamEvent[] = [];
    for await (const event of adapter.stream(baseRequest())) {
      received.push(event);
    }

    expect(received).toEqual([
      { type: 'delta', textDelta: 'Hel' },
      { type: 'delta', textDelta: 'lo' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
  });

  it('throws (does not yield) on an error before any delta has been produced', async () => {
    // Simulate an iterable whose first `next()` call rejects.
    const failingStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw fakeSdkError(Anthropic.RateLimitError, 429, 'rate limited');
          },
        };
      },
    };
    const stream = vi.fn().mockReturnValue(failingStream);
    const client: AnthropicMessagesClient = { messages: { create: vi.fn(), stream } };
    const adapter = createAnthropicAdapter('fake-key', client);

    const iterate = async () => {
      for await (const _event of adapter.stream(baseRequest())) {
        // no-op
      }
    };

    await expectGatewayError(iterate(), 'anthropic', 'retryable');
  });

  it('yields an error event (does not throw) on an error after a delta has been produced', async () => {
    const failingStream: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          async next() {
            step++;
            if (step === 1) {
              return {
                value: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
                done: false,
              };
            }
            throw fakeSdkError(Anthropic.InternalServerError, 500, 'server error');
          },
        };
      },
    };
    const stream = vi.fn().mockReturnValue(failingStream);
    const client: AnthropicMessagesClient = { messages: { create: vi.fn(), stream } };
    const adapter = createAnthropicAdapter('fake-key', client);

    const received: NormalizedStreamEvent[] = [];
    for await (const event of adapter.stream(baseRequest())) {
      received.push(event);
    }

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: 'delta', textDelta: 'Hi' });
    expect(received[1]).toMatchObject({
      type: 'error',
      error: { provider: 'anthropic', errorClass: 'retryable' },
    });
  });
});
