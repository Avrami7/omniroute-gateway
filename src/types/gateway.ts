export type ProviderName = 'anthropic' | 'openai';

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface NormalizedChatRequest {
  /** Raw model string from the client, e.g. "claude-opus-5" or "gpt-4o". */
  requestedModel: string;
  messages: NormalizedMessage[];
  maxTokens: number;
  temperature?: number;
  stream: boolean;
  stopSequences?: string[];
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface NormalizedChatResponse {
  id: string;
  provider: ProviderName;
  modelUsed: string;
  content: string;
  finishReason: 'stop' | 'length' | 'error';
  usage: NormalizedUsage;
}

export type NormalizedStreamEvent =
  | { type: 'delta'; textDelta: string }
  | { type: 'done'; finishReason: 'stop' | 'length'; usage: NormalizedUsage }
  | { type: 'error'; error: GatewayProviderError };

export interface ProviderAdapter {
  readonly name: ProviderName;
  send(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
  stream(req: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent>;
}

/**
 * `retryable` errors (rate limits, 5xx, connection/timeout) trigger the
 * router's single-hop fallback. `client_error` (bad request, auth, 404) does
 * not — retrying an identical malformed request against a different
 * provider would just fail the same way.
 */
export type ErrorClass = 'retryable' | 'client_error' | 'unknown';

export class GatewayProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: ProviderName,
    public readonly errorClass: ErrorClass,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'GatewayProviderError';
  }
}
