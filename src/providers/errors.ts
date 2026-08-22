import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ErrorClass, ProviderName } from '../types/gateway.js';

/**
 * Classifies an SDK error into a class the router can act on:
 *  - 'retryable'    -> rate limits, 5xx/overloaded, and network/connection
 *                       failures. The router may attempt its single-hop
 *                       fallback to another provider.
 *  - 'client_error' -> bad request, auth, permission, not-found. Retrying
 *                       an identical malformed request against a different
 *                       provider would just fail the same way, so no
 *                       fallback is attempted.
 *  - 'unknown'       -> anything we don't recognize. Treated as
 *                       non-retryable by the adapters (safer default).
 *
 * `instanceof` checks are ordered most-specific-first per each SDK's own
 * error hierarchy, since some subclasses (e.g. APIConnectionError) extend
 * the base APIError class and must be checked before it.
 */
export function classifyError(err: unknown, provider: ProviderName): ErrorClass {
  if (provider === 'anthropic') {
    return classifyAnthropicError(err);
  }
  return classifyOpenAIError(err);
}

function classifyAnthropicError(err: unknown): ErrorClass {
  // Check the more specific network/connection error before the base
  // APIError class, since APIConnectionError is a subclass of APIError.
  if (err instanceof Anthropic.APIConnectionError) {
    return 'retryable';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'retryable';
  }
  if (err instanceof Anthropic.InternalServerError) {
    // Covers 5xx and 529 (overloaded).
    return 'retryable';
  }
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError
  ) {
    return 'client_error';
  }
  return 'unknown';
}

function classifyOpenAIError(err: unknown): ErrorClass {
  // Same ordering rationale as Anthropic: APIConnectionError is a subclass
  // of the base APIError and must be checked first.
  if (err instanceof OpenAI.APIConnectionError) {
    return 'retryable';
  }
  if (err instanceof OpenAI.RateLimitError) {
    return 'retryable';
  }
  if (err instanceof OpenAI.InternalServerError) {
    return 'retryable';
  }
  if (
    err instanceof OpenAI.BadRequestError ||
    err instanceof OpenAI.AuthenticationError ||
    err instanceof OpenAI.PermissionDeniedError ||
    err instanceof OpenAI.NotFoundError
  ) {
    return 'client_error';
  }
  return 'unknown';
}

/** Extracts an HTTP status code from an SDK error, if the SDK exposes one. */
export function extractHttpStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
}

/** Extracts a safe message from an SDK error without ever leaking secrets. */
export function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return 'Unknown provider error';
}
