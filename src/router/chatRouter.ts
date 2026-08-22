import type pino from 'pino';
import type {
  NormalizedChatRequest,
  NormalizedChatResponse,
  NormalizedStreamEvent,
  ProviderAdapter,
} from '../types/gateway.js';
import { GatewayProviderError } from '../types/gateway.js';
import { resolveFallback } from '../config/routing.js';

/**
 * Minimal structural dependency the router needs from the provider
 * registry. Deliberately NOT the concrete ProviderRegistry type, so tests
 * can inject fake adapters without needing the real registry to exist.
 */
export interface ChatRouterDeps {
  getAdapterForModel(model: string): ProviderAdapter;
}

export interface ChatRouter {
  handleChat(req: NormalizedChatRequest): Promise<NormalizedChatResponse>;
  handleChatStream(req: NormalizedChatRequest): AsyncIterable<NormalizedStreamEvent>;
}

export function createChatRouter(deps: ChatRouterDeps, logger: pino.Logger): ChatRouter {
  async function handleChat(req: NormalizedChatRequest): Promise<NormalizedChatResponse> {
    const adapter = deps.getAdapterForModel(req.requestedModel);

    try {
      return await adapter.send(req);
    } catch (err) {
      if (!(err instanceof GatewayProviderError) || err.errorClass !== 'retryable') {
        throw err;
      }

      const fallbackModel = resolveFallback(req.requestedModel);
      if (!fallbackModel) {
        throw err;
      }

      logger.warn(
        { primaryModel: req.requestedModel, fallbackModel, reason: 'retryable' },
        'falling back',
      );

      // Exactly one fallback hop: errors thrown by this attempt are not
      // caught here, and propagate straight to the caller.
      const fallbackAdapter = deps.getAdapterForModel(fallbackModel);
      return fallbackAdapter.send({ ...req, requestedModel: fallbackModel });
    }
  }

  /**
   * First-event-gates-fallback: fallback to a secondary provider is only
   * attempted if the very first event of the primary's stream fails to
   * arrive. Nothing is yielded to the caller until that first event is
   * confirmed obtainable, so a failed primary attempt never leaks a
   * partial/duplicated transcript into a subsequently-started fallback
   * stream. Once a first event has been successfully yielded, the response
   * has effectively "started": any later error is surfaced as a
   * `{ type: 'error' }` event and the generator stops — it is never used to
   * trigger a fallback, and never chains beyond the single hop above.
   */
  async function* handleChatStream(
    req: NormalizedChatRequest,
  ): AsyncIterable<NormalizedStreamEvent> {
    let adapter = deps.getAdapterForModel(req.requestedModel);
    let iterator = adapter.stream(req)[Symbol.asyncIterator]();
    let first: IteratorResult<NormalizedStreamEvent>;

    try {
      first = await iterator.next();
    } catch (err) {
      if (!(err instanceof GatewayProviderError) || err.errorClass !== 'retryable') {
        throw err;
      }

      const fallbackModel = resolveFallback(req.requestedModel);
      if (!fallbackModel) {
        throw err;
      }

      logger.warn(
        { primaryModel: req.requestedModel, fallbackModel, reason: 'retryable' },
        'falling back',
      );

      const fallbackReq: NormalizedChatRequest = { ...req, requestedModel: fallbackModel };
      adapter = deps.getAdapterForModel(fallbackModel);
      iterator = adapter.stream(fallbackReq)[Symbol.asyncIterator]();

      // Errors from this fallback attempt are NOT caught — they propagate
      // to the caller, matching handleChat's single-hop semantics.
      first = await iterator.next();
    }

    if (first.done) {
      return;
    }
    yield first.value;

    // Past the first successful event: no more fallback attempts. Any
    // further error is surfaced as a stream-level error event, not retried.
    try {
      let next = await iterator.next();
      while (!next.done) {
        yield next.value;
        next = await iterator.next();
      }
    } catch (err) {
      const wrapped =
        err instanceof GatewayProviderError
          ? err
          : new GatewayProviderError(
              err instanceof Error ? err.message : String(err),
              adapter.name,
              'unknown',
            );
      yield { type: 'error', error: wrapped };
    }
  }

  return { handleChat, handleChatStream };
}
