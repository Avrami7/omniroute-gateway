import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { buildApp } from '../../src/app.js';
import { GatewayProviderError } from '../../src/types/gateway.js';
import type { ChatRouter } from '../../src/router/chatRouter.js';
import type { GatewayConfig } from '../../src/config/env.js';
import type { NormalizedChatResponse } from '../../src/types/gateway.js';

const config: GatewayConfig = {
  port: 0,
  gatewayApiKey: 'test-gateway-key-1234567890',
  logLevel: 'error',
  providerKeys: { anthropic: 'sk-ant-test', openai: 'sk-oai-test' },
};

const logger = pino({ level: 'silent' });

function makeResponse(overrides: Partial<NormalizedChatResponse> = {}): NormalizedChatResponse {
  return {
    id: 'resp-1',
    provider: 'anthropic',
    modelUsed: 'claude-opus-5',
    content: 'hello there',
    finishReason: 'stop',
    usage: { inputTokens: 3, outputTokens: 5 },
    ...overrides,
  };
}

function makeChatRouter(overrides: Partial<ChatRouter> = {}): ChatRouter {
  return {
    handleChat: overrides.handleChat ?? (async () => makeResponse()),
    handleChatStream: overrides.handleChatStream ?? (async function* () {}),
  };
}

function authHeader(token: string = config.gatewayApiKey): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

const validBody = { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] };

describe('POST /v1/chat/completions - validation', () => {
  it('rejects a request missing messages with 400 invalid_request', async () => {
    const app = buildApp({ config, logger, chatRouter: makeChatRouter() });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set(authHeader())
      .send({ model: 'claude-opus-5' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(Array.isArray(res.body.details)).toBe(true);
  });
});

describe('POST /v1/chat/completions - non-streaming success', () => {
  it('returns a chat.completion body shaped from the router result', async () => {
    const app = buildApp({ config, logger, chatRouter: makeChatRouter() });
    const res = await request(app).post('/v1/chat/completions').set(authHeader()).send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.object).toBe('chat.completion');
    expect(res.body.model).toBe('claude-opus-5');
    expect(res.body.choices).toHaveLength(1);
    expect(res.body.choices[0].message).toEqual({ role: 'assistant', content: 'hello there' });
    expect(res.body.choices[0].finish_reason).toBe('stop');
    expect(res.body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });
});

describe('POST /v1/chat/completions - error mapping', () => {
  it('maps a client_error GatewayProviderError to 400', async () => {
    const handleChat = vi.fn(async () => {
      throw new GatewayProviderError('bad request', 'anthropic', 'client_error', 400);
    });
    const app = buildApp({ config, logger, chatRouter: makeChatRouter({ handleChat }) });

    const res = await request(app).post('/v1/chat/completions').set(authHeader()).send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad request');
  });

  it('maps a retryable (fallback-exhausted) GatewayProviderError to 502', async () => {
    const handleChat = vi.fn(async () => {
      throw new GatewayProviderError('upstream unavailable', 'openai', 'retryable', 503);
    });
    const app = buildApp({ config, logger, chatRouter: makeChatRouter({ handleChat }) });

    const res = await request(app).post('/v1/chat/completions').set(authHeader()).send(validBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream unavailable');
  });

  it('maps an unknown-model plain Error from the registry to 400', async () => {
    const handleChat = vi.fn(async () => {
      throw new Error('unrecognized model prefix: foo-1');
    });
    const app = buildApp({ config, logger, chatRouter: makeChatRouter({ handleChat }) });

    const res = await request(app).post('/v1/chat/completions').set(authHeader()).send(validBody);
    expect(res.status).toBe(400);
  });
});

describe('auth middleware', () => {
  it('rejects requests to /v1/* with no Authorization header', async () => {
    const app = buildApp({ config, logger, chatRouter: makeChatRouter() });
    const res = await request(app).post('/v1/chat/completions').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('rejects requests to /v1/* with the wrong bearer token', async () => {
    const app = buildApp({ config, logger, chatRouter: makeChatRouter() });
    const res = await request(app)
      .post('/v1/chat/completions')
      .set(authHeader('wrong-token'))
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it('allows GET /health without any Authorization header', async () => {
    const app = buildApp({ config, logger, chatRouter: makeChatRouter() });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.providers.sort()).toEqual(['anthropic', 'openai']);
  });
});
