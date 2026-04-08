# ChatGPT Wire Protocol — Notes from Live Capture

Captured 2026-04-08 01:17 CT via slop-browser network interception.

## Conversation flow

1. `GET /backend-api/sentinel/chat-requirements/prepare` → `{ prepare_token }`
2. `GET /backend-api/sentinel/chat-requirements/finalize` → `{ persona, token, expire_after }`
3. `GET /backend-api/f/conversation/prepare` → `{ conduit_token: <JWT> }` (60s TTL)
4. `POST /backend-api/f/conversation` → SSE stream (accept: text/event-stream)
5. `GET /backend-api/conversation/{id}/stream_status` → `{ status: "IS_STREAMING" }`
6. `GET /backend-api/conversations?offset=0&limit=28` → conversation list

## Auth headers (from slop net headers)

- `Authorization: Bearer <session-jwt>` (~8-day TTL)
- `x-conduit-token: <conduit-jwt>` (60s TTL, per-message)
- `OpenAI-Sentinel-Chat-Requirements-Token` (~540s TTL)
- `OpenAI-Sentinel-Turnstile-Token` (Cloudflare)
- `OpenAI-Sentinel-Proof-Token` (proof-of-work)
- `OAI-Device-Id`, `OAI-Session-Id`, `OAI-Client-Version`

## Conduit JWT payload

```json
{
  "conduit_uuid": "d0707ca090f04bc89b4a0b632029751e",
  "conduit_location": "10.131.103.199:8308",
  "cluster": "unified-120",
  "iat": 1775611054,
  "exp": 1775611114
}
```

## DOM structure

- Input: `textbox "Chat with ChatGPT"` (contenteditable)
- Model selector: `button "Model selector"`
- Response readable via `slop text`

## SPA behavior

ChatGPT uses `history.pushState` for conversation switching.
Content scripts persist but monitor needs re-arming (fixed in PRD-15 Phase 6).
