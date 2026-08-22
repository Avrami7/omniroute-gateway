import Anthropic from '@anthropic-ai/sdk';
import { GatewayProviderError } from '../types/gateway.js';
import type {
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedMessage,
  NormalizedStreamEvent,
  NormalizedUsage,
  ProviderAdapter,
} from '../types/gateway.js';
import { classifyError, extractErrorMessage, extractHttpStatus } from './errors.js';

/*
 * The Anthropic Messages API wire format is stable and well-documented, but
 * the exact TypeScript type names exported by `@anthropic-ai/sdk` differ
 * across SDK minor versions and cannot be verified here (dependencies are
 * not installed in this environment). To keep this adapter compileable and
 * testable without depending on those exact export names, we declare our
 * own minimal structural types for exactly the request/response fields this
 * adapter uses, and inject the client through this narrow interface rather
 * than the SDK's full `Anthropic` class type. The real SDK client is cast
 * into this interface at construction time (see `createAnthropicAdapter`);
 * at runtime it is a real `Anthropic` instance and behaves exactly as the
 * official docs describe. Error classification still uses the SDK's real,
 * versioned exception classes (`Anthropic.RateLimitError`, etc.) via
 * `classifyError`, so that part is unaffected by this decoupling.
 */

interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  temperature?: number;
  stop_sequences?: string[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicTextDelta {
  type: 'text_delta';
  text: string;
}

interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta';
  delta: AnthropicTextDelta | { type: string };
}

interface AnthropicMessageStartEvent {
  type: 'message_start';
  message: { usage: { input_tokens: number; output_tokens: number } };
}

interface AnthropicMessageDeltaEvent {
  type: 'message_delta';
  delta: { stop_reason: string | null };
  usage?: { output_tokens: number };
}

interface AnthropicMessageStopEvent {
  type: 'message_stop';
}

type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | { type: string };

export interface AnthropicMessagesClient {
  messages: {
    create(params: AnthropicCreateParams): Promise<AnthropicMessageResponse>;
    stream(params: AnthropicCreateParams): AsyncIterable<AnthropicStreamEvent>;
  };
}

/**
 * Pulls any leading system message(s) out of the normalized message list
 * and joins them into a single top-level `system` string, since the
 * Anthropic Messages API requires `system` as a top-level field rather than
 * a message with `role: 'system'`. Remaining messages are narrowed to
 * user/assistant.
 */
function splitSystemAndMessages(messages: NormalizedMessage[]): {
  system: string | undefined;
  messages: AnthropicMessageParam[];
} {
  let leadingSystemCount = 0;
  while (
    leadingSystemCount < messages.length &&
    messages[leadingSystemCount]?.role === 'system'
  ) {
    leadingSystemCount++;
  }

  const systemParts = messages
    .slice(0, leadingSystemCount)
    .map((m) => m.content);
  const rest = messages.slice(leadingSystemCount);

  const converted = rest.map((m): AnthropicMessageParam => {
    if (m.role !== 'user' && m.role !== 'assistant') {
      throw new Error(
        `Anthropic adapter received a non-leading 'system' message; only a leading system message is supported.`,
      );
    }
    return { role: m.role, content: m.content };
  });

  return {
    system: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    messages: converted,
  };
}

function mapStopReason(stopReason: string | null): 'stop' | 'length' {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

function wrapError(err: unknown): GatewayProviderError {
  const errorClass = classifyError(err, 'anthropic');
  return new GatewayProviderError(
    extractErrorMessage(err),
    'anthropic',
    errorClass,
    extractHttpStatus(err),
  );
}

export function createAnthropicAdapter(
  apiKey: string,
  client?: AnthropicMessagesClient,
): ProviderAdapter {
  // Cast rationale documented in the file header comment above.
  const sdkClient: AnthropicMessagesClient =
    client ?? (new Anthropic({ apiKey }) as unknown as AnthropicMessagesClient);

  return {
    name: 'anthropic',

    async send(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
      try {
        const { system, messages } = splitSystemAndMessages(req.messages);

        const response = await sdkClient.messages.create({
          model: req.requestedModel,
          max_tokens: req.maxTokens,
          system,
          messages,
          temperature: req.temperature,
          stop_sequences: req.stopSequences,
        });

        const content = response.content
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('');

        return {
          id: response.id,
          provider: 'anthropic',
          modelUsed: response.model,
          content,
          finishReason: mapStopReason(response.stop_reason),
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        throw wrapError(err);
      }
    },

    async *stream(req: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent> {
      let hasYieldedDelta = false;
      let finishReason: 'stop' | 'length' = 'stop';
      const usage: NormalizedUsage = { inputTokens: 0, outputTokens: 0 };

      try {
        const { system, messages } = splitSystemAndMessages(req.messages);

        const stream = sdkClient.messages.stream({
          model: req.requestedModel,
          max_tokens: req.maxTokens,
          system,
          messages,
          temperature: req.temperature,
          stop_sequences: req.stopSequences,
        });

        for await (const event of stream) {
          if (event.type === 'message_start') {
            const e = event as AnthropicMessageStartEvent;
            usage.inputTokens = e.message.usage.input_tokens;
          } else if (event.type === 'content_block_delta') {
            const e = event as AnthropicContentBlockDeltaEvent;
            if (e.delta.type === 'text_delta') {
              hasYieldedDelta = true;
              yield { type: 'delta', textDelta: (e.delta as AnthropicTextDelta).text };
            }
          } else if (event.type === 'message_delta') {
            const e = event as AnthropicMessageDeltaEvent;
            if (e.delta.stop_reason) {
              finishReason = mapStopReason(e.delta.stop_reason);
            }
            if (e.usage?.output_tokens !== undefined) {
              usage.outputTokens = e.usage.output_tokens;
            }
          } else if (event.type === 'message_stop') {
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
