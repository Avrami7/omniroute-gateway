import { randomUUID } from 'node:crypto';
import express, { type Router } from 'express';
import { z } from 'zod';
import type {
  ChatCompletionChunk,
  ChatCompletionResponseBody,
} from '../types/openai-api.js';
import type {
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedStreamEvent,
} from '../types/gateway.js';
import { GatewayProviderError } from '../types/gateway.js';
import type { ChatRouter } from '../router/chatRouter.js';

const chatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  stream: z.boolean().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
});

type ValidatedBody = z.infer<typeof chatCompletionRequestSchema>;

/** Anthropic requires a max_tokens value; 4096 is used when the client omits it. */
const DEFAULT_MAX_TOKENS = 4096;

function toNormalizedRequest(body: ValidatedBody): NormalizedChatRequest {
  const stopSequences =
    body.stop === undefined ? undefined : Array.isArray(body.stop) ? body.stop : [body.stop];

  return {
    requestedModel: body.model,
    messages: body.messages,
    maxTokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
    temperature: body.temperature,
    stream: !!body.stream,
    stopSequences,
  };
}

function toResponseBody(result: NormalizedChatResponse): ChatCompletionResponseBody {
  return {
    id: result.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.modelUsed,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: result.finishReason === 'error' ? 'stop' : result.finishReason,
      },
    ],
    usage: {
      prompt_tokens: result.usage.inputTokens,
      completion_tokens: result.usage.outputTokens,
      total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    },
  };
}

/**
 * Maps a thrown error to an HTTP status + JSON error body.
 *  - GatewayProviderError with errorClass 'client_error' -> 400
 *  - GatewayProviderError with errorClass 'retryable'/'unknown' (fallback
 *    already exhausted by the router, or no fallback was available) -> 502
 *  - Any other Error (e.g. registry throwing on an unrecognized model
 *    prefix) -> 400
 */
function mapError(err: unknown): { status: number; body: { error: string } } {
  if (err instanceof GatewayProviderError) {
    return {
      status: err.errorClass === 'client_error' ? 400 : 502,
      body: { error: err.message },
    };
  }
  return {
    status: 400,
    body: { error: err instanceof Error ? err.message : 'unknown_error' },
  };
}

function sseWrite(res: express.Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function baseChunk(id: string, model: string): Omit<ChatCompletionChunk, 'choices'> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

export function createChatCompletionsRoute(chatRouter: ChatRouter): Router {
  const router = express.Router();

  router.post('/chat/completions', async (req, res) => {
    const parseResult = chatCompletionRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'invalid_request', details: parseResult.error.issues });
      return;
    }

    const normalized = toNormalizedRequest(parseResult.data);

    if (!normalized.stream) {
      try {
        const result = await chatRouter.handleChat(normalized);
        res.status(200).json(toResponseBody(result));
      } catch (err) {
        const { status, body } = mapError(err);
        res.status(status).json(body);
      }
      return;
    }

    // Streaming path. We must not commit to an SSE response (status +
    // flushed headers) until we know the primary/fallback attempt actually
    // produced a first event — otherwise a failure on that first event
    // could no longer be reported as a normal JSON error response.
    const iterator = chatRouter.handleChatStream(normalized)[Symbol.asyncIterator]();
    let first: IteratorResult<NormalizedStreamEvent>;
    try {
      first = await iterator.next();
    } catch (err) {
      const { status, body } = mapError(err);
      if (!res.headersSent) {
        res.status(status).json(body);
      } else {
        res.end();
      }
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const streamId = `chatcmpl-${randomUUID()}`;
    // The model actually used may differ from requestedModel after a
    // fallback, but NormalizedStreamEvent carries no modelUsed field, so
    // the originally requested model is the best available label here.
    const model = normalized.requestedModel;

    try {
      let current = first;
      while (!current.done) {
        const event = current.value;

        if (event.type === 'delta') {
          sseWrite(res, {
            ...baseChunk(streamId, model),
            choices: [{ index: 0, delta: { content: event.textDelta }, finish_reason: null }],
          });
        } else if (event.type === 'done') {
          sseWrite(res, {
            ...baseChunk(streamId, model),
            choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
          });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } else {
          // event.type === 'error'
          sseWrite(res, { error: { message: event.error.message, provider: event.error.provider } });
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        current = await iterator.next();
      }

      // Iterator ended without an explicit 'done'/'error' event. Defensive
      // fallback so the client still gets a terminator.
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      // Defensive: chatRouter's contract yields post-first-event errors as
      // { type: 'error' } events rather than throwing, but guard anyway
      // since headers are already flushed at this point.
      if (!res.writableEnded) {
        const message = err instanceof Error ? err.message : 'stream_error';
        sseWrite(res, { error: { message } });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });

  return router;
}
