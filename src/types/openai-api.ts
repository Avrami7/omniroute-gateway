/**
 * Public wire contract for POST /v1/chat/completions — mirrors OpenAI's
 * chat.completion / chat.completion.chunk shapes so existing
 * OpenAI-compatible clients can point at this gateway unmodified.
 */

export interface ChatMessageBody {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequestBody {
  model: string;
  messages: ChatMessageBody[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string | string[];
}

export interface ChatCompletionChoice {
  index: 0;
  message: ChatMessageBody;
  finish_reason: 'stop' | 'length';
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponseBody {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: 0;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}
