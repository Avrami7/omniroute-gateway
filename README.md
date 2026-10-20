# omniroute-gateway

[![CI](https://github.com/Avrami7/omniroute-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/Avrami7/omniroute-gateway/actions/workflows/ci.yml)

A self-hosted, single-endpoint LLM gateway that routes requests to multiple
providers (Anthropic, OpenAI, more to come) using **your own paid API keys**.

This project is a legitimate alternative to gateways that disguise paid
provider access as "free" via shared or unofficial credentials. It never
shares, scrapes, or forwards credentials on your behalf — you configure your
own `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, and the gateway talks to each
provider's official API with them, nothing more.

## What it does

- One endpoint, `POST /v1/chat/completions`, compatible with the OpenAI Chat
  Completions request/response shape (including SSE streaming) — point any
  existing OpenAI-compatible client at this gateway by changing `base_url`.
- Routes by model name prefix (`claude-*` → Anthropic, `gpt-*` → OpenAI; see
  `src/config/routing.ts`) to a small adapter per provider.
- Single-hop automatic fallback: if the primary provider errors in a
  retryable way (rate limit, 5xx, connection/timeout), the gateway retries
  once against a configured fallback model. Client errors (bad request, auth,
  404) are never retried against a different provider.
- Structured request logs (method, route, status, latency) that never
  include request/response bodies or API keys.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set GATEWAY_API_KEY (e.g. `openssl rand -hex 32`) and the
# API key for whichever provider(s) you want to route to
npm run build
npm start
# or, for local development with auto-reload:
npm run dev
```

Every request to `/v1/*` must include `Authorization: Bearer <GATEWAY_API_KEY>`.
`GET /health` is unauthenticated and reports which providers are configured
(names only, never keys) — useful for confirming setup.

## Adding a provider

1. Create `src/providers/<name>.ts` implementing the `ProviderAdapter`
   interface from `src/types/gateway.ts` (`send()` and `stream()`).
2. Add its error classification cases to `src/providers/errors.ts`.
3. Register it in `src/providers/registry.ts` and add a `RouteRule` (model
   prefix → provider) and optional `FallbackRule` in `src/config/routing.ts`.
4. Add its API key env var to `src/config/env.ts`'s schema and to
   `.env.example`.

No other file needs to change.

## Known limitation: streaming + fallback

Once the gateway has flushed the first SSE bytes to the client, it can no
longer transparently switch providers — the client has already seen partial
output from the original provider. So fallback is only attempted **before**
the first streamed chunk is confirmed: if the primary provider fails on its
very first event, the gateway retries the whole stream against the fallback
model with zero bytes lost. If a provider fails *after* streaming has
already started, the gateway ends the response with an `error` event instead
of falling back mid-stream.

## Not in this version

No cost/usage dashboard, no persistence/database, no multi-tenant auth (one
shared `GATEWAY_API_KEY` for all clients), no rate limiting. These are
reasonable v1.1+ additions if you're exposing this beyond a private network.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm run lint         # eslint
npm test             # vitest — adapters mocked, no real provider calls
```
