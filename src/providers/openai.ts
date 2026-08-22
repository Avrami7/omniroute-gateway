import OpenAI from 'openai';
import { GatewayProviderError } from '../types/gateway.js';
import type {
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedStreamEvent,
  NormalizedUsage,
  ProviderAdapter,
} from '../types/gateway.js';
import { classifyError, extractErrorMessage, extractHttpStatus } from './errors.js';

/*
 * As with the Anthropic adapter, we declare minimal structural request/
 * response types for exactly the Chat Completions fields this adapter
 * uses, rather than depending on the exact TypeScript type names exported
 * by the pinned `openai` SDK version (unverifiable here since dependencies
 * are not installed). The real SDK client is cast into this narrow
 * interface at construction time. Error classification still uses the
 * SDK's real, versioned exception classes (`OpenAI.RateLimitError`, etc.)
 * via `classifyError`, so that part is unaffected by this decoupling.
 */

interface OpenAIMessageParam {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIChatCompletionParams {
  model: string;
  messages: OpenAIMessageParam[];
  max_tokens?: number;
  temperature?: number;
  stop?: string[];
  stream?: boolean;
}

interface OpenAIChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { content: string | null };
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIChatCompletionChunk {
  choices: Array<{
    delta: { content?: string | null };
    finish_reason: string | null;
  }>;
}

export interface OpenAIChatClient {
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionParams,
      ): Promise<OpenAIChatCompletionResponse | AsyncIterable<OpenAIChatCompletionChunk>>;
    };
  };
}

function toOpenAIMessages(
  messages: NormalizedChatRequest['messages'],
): OpenAIMessageParam[] {
  // Unlike Anthropic, OpenAI's Chat Completions API accepts a `role:
  // 'system'` message directly in the array -- no special top-level field
  // needed. Pass messages through as-is, just narrowing the role.
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function mapFinishReason(finishReason: string | null): 'stop' | 'length' {
  return finishReason === 'length' ? 'length' : 'stop';
}

function wrapError(err: unknown): GatewayProviderError {
  const errorClass = classifyError(err, 'openai');
  return new GatewayProviderError(
    extractErrorMessage(err),
    'openai',
    errorClass,
    extractHttpStatus(err),
  );
}

export function createOpenAIAdapter(
  apiKey: string,
  client?: OpenAIChatClient,
): ProviderAdapter {
  // Cast rationale documented in the file header comment above.
  const sdkClient: OpenAIChatClient =
    client ?? (new OpenAI({ apiKey }) as unknown as OpenAIChatClient);

  return {
    name: 'openai',

    async send(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
      try {
        const response = (await sdkClient.chat.completions.create({
          model: req.requestedModel,
          messages: toOpenAIMessages(req.messages),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stop: req.stopSequences,
          stream: false,
        })) as OpenAIChatCompletionResponse;

        const choice = response.choices[0];

        return {
          id: response.id,
          provider: 'openai',
          modelUsed: response.model,
          content: choice?.message.content ?? '',
          finishReason: mapFinishReason(choice?.finish_reason ?? null),
          usage: {
            inputTokens: response.usage?.prompt_tokens ?? 0,
            outputTokens: response.usage?.completion_tokens ?? 0,
          },
        };
      } catch (err) {
        throw wrapError(err);
      }
    },

    async *stream(req: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
      let hasYieldedDelta = false;
      let finishReason: 'stop' | 'length' = 'stop';
      // OpenAI's streaming Chat Completions API does not return token usage
      // by default (unlike the non-streaming response's `.usage` field).
      // TODO: request usage via `stream_options: { include_usage: true }`
      // (if supported by the pinned SDK/API version) and parse the final
      // usage-only chunk instead of reporting zeros here.
      const usage: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

      try {
        const stream = (await sdkClient.chat.completions.create({
          model: req.requestedModel,
          messages: toOpenAIMessages(req.messages),
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          stop: req.stopSequences,
          stream: true,
        })) as AsyncIterable<OpenAIChatCompletionChunk>;

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) {
            continue;
          }
          if (choice.delta.content) {
            hasYieldedDelta = true;
            yield { type: 'delta', textDelta: choice.delta.content };
          }
          if (choice.finish_reason) {
            finishReason = mapFinishReason(choice.finish_reason);
            yield { type: 'done', finishReason, usage };
          }
        }
      } catch (err) {
        const wrapped = wrapError(err);
        if (!hasYieldedDelta) {
          // No bytes have reached the caller yet: throw so chatRouter can
          // catch it and attempt fallback before anything is streamed out.
          throw wrapped;
        }
        yield { type: 'error', error: wrapped };
      }
    },
  };
}
