import { describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { createOpenAIAdapter } from '../../src/providers/openai.js';
import type { OpenAIChatClient } from '../../src/providers/openai.js';
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
    requestedModel: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello there' },
    ],
    maxTokens: 1024,
    stream: false,
    ...overrides,
  };
}

describe('OpenAIAdapter.send', () => {
  it('maps a successful non-streaming response into a NormalizedChatResponse', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'chatcmpl_123',
      model: 'gpt-4o',
      choices: [{ message: { content: 'Hello! How can I help?' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
    const client: OpenAIChatClient = { chat: { completions: { create } } };
    const adapter = createOpenAIAdapter('fake-key', client);

    const result = await adapter.send(baseRequest());

    expect(result).toEqual({
      id: 'chatcmpl_123',
      provider: 'openai',
      modelUsed: 'gpt-4o',
      content: 'Hello! How can I help?',
      finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8 },
    });

    // Unlike Anthropic, the system message stays inline in `messages` --
    // no top-level field extraction.
    const callArgs = create.mock.calls[0][0];
    expect(callArgs.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello there' },
    ]);
    expect(callArgs.max_tokens).toBe(1024);
    expect(callArgs.stream).toBe(false);
  });

  it('maps finish_reason "length" to finishReason "length"', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'chatcmpl_456',
      model: 'gpt-4o',
      choices: [{ message: { content: 'truncated...' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 5, completion_tokens: 1024 },
    });
    const client: OpenAIChatClient = { chat: { completions: { create } } };
    const adapter = createOpenAIAdapter('fake-key', client);

    const result = await adapter.send(baseRequest());
    expect(result.finishReason).toBe('length');
  });

  it.each([
    ['RateLimitError', OpenAI.RateLimitError, 429, 'retryable'],
    ['InternalServerError', OpenAI.InternalServerError, 500, 'retryable'],
    ['APIConnectionError', OpenAI.APIConnectionError, undefined, 'retryable'],
    ['BadRequestError', OpenAI.BadRequestError, 400, 'client_error'],
    ['AuthenticationError', OpenAI.AuthenticationError, 401, 'client_error'],
    ['NotFoundError', OpenAI.NotFoundError, 404, 'client_error'],
    ['PermissionDeniedError', OpenAI.PermissionDeniedError, 403, 'client_error'],
  ] as const)(
    'classifies %s as %s and wraps it in a GatewayProviderError',
    async (_name, ErrorCtor, status, expectedClass) => {
      const create = vi.fn().mockRejectedValue(fakeSdkError(ErrorCtor, status, 'boom'));
      const client: OpenAIChatClient = { chat: { completions: { create } } };
      const adapter = createOpenAIAdapter('fake-key', client);

      await expectGatewayError(adapter.send(baseRequest()), 'openai', expectedClass);
    },
  );
});

describe('OpenAIAdapter.stream', () => {
  it('yields delta events followed by a done event for a simple fake stream', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const create = vi.fn().mockResolvedValue(fakeAsyncIterable(chunks));
    const client: OpenAIChatClient = { chat: { completions: { create } } };
    const adapter = createOpenAIAdapter('fake-key', client);

    const received: NormalizedStreamEvent[] = [];
    for await (const event of adapter.stream(baseRequest())) {
      received.push(event);
    }

    expect(received).toEqual([
      { type: 'delta', textDelta: 'Hel' },
      { type: 'delta', textDelta: 'lo' },
      { type: 'done', finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } },
    ]);

    const callArgs = create.mock.calls[0][0];
    expect(callArgs.stream).toBe(true);
  });

  it('throws (does not yield) on an error before any delta has been produced', async () => {
    const create = vi.fn().mockRejectedValue(fakeSdkError(OpenAI.RateLimitError, 429, 'rate limited'));
    const client: OpenAIChatClient = { chat: { completions: { create } } };
    const adapter = createOpenAIAdapter('fake-key', client);

    const iterate = async () => {
      for await (const _event of adapter.stream(baseRequest())) {
        // no-op
      }
    };

    await expectGatewayError(iterate(), 'openai', 'retryable');
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
                value: { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
                done: false,
              };
            }
            throw fakeSdkError(OpenAI.InternalServerError, 500, 'server error');
          },
        };
      },
    };
    const create = vi.fn().mockResolvedValue(failingStream);
    const client: OpenAIChatClient = { chat: { completions: { create } } };
    const adapter = createOpenAIAdapter('fake-key', client);

    const received: NormalizedStreamEvent[] = [];
    for await (const event of adapter.stream(baseRequest())) {
      received.push(event);
    }

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ type: 'delta', textDelta: 'Hi' });
    expect(received[1]).toMatchObject({
      type: 'error',
      error: { provider: 'openai', errorClass: 'retryable' },
    });
  });
});
