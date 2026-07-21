# Chatterra Backend

The Express API uses PostgreSQL for characters, conversations, messages, and
memories. It also persists per-user relationship, affect, simulation, event,
decision, inference, and generation state. See [DATABASE.md](./DATABASE.md) for the
schema design.

## Setup

```bash
docker compose up -d postgres
cd backend
npm install
npm run db:setup
npm start
```

`db:setup` applies versioned SQL migrations and imports the legacy JSON records
from `/data`. The importer is safe to rerun and never overwrites existing rows.

The local Docker connection is the development default, so an existing `.env`
containing only `DEEPSEEK_API_KEY` continues to work. Use `.env.example` as the
reference when connecting to a different database.

Environment variables:

- `DATABASE_URL`: PostgreSQL connection URL. Required in production; local Docker is the development default.
- `DATABASE_SSL`: set to `true` for hosted PostgreSQL providers requiring TLS.
- `DEEPSEEK_API_KEY`: DeepSeek API key for live chat mode.
- `DEEPSEEK_API_MODE`: `live` or `mock`.
- `BEHAVIOR_DEBUG`: set to `true` only in local development to include raw behavioral
  projections in the character-state endpoint.
- `DEEPSEEK_LIGHT_MODEL`: optional provider model used for low-complexity companion
  turns. The orchestrator falls back to `DEEPSEEK_MODEL` when it is absent.
- `PORT`: API port, default `3000`.

The chat API does not accept a user-selected interaction mode. It derives an internal
base policy from the stored character definition. Teaching characters retain their
learning role, while the Inference Orchestrator can prioritize grief, distress, or
relationship repair over correction for the current turn. Delayed and proactive
delivery will use the persisted decision/outbox boundary in a later slice.

Memory is automatic by default. The UI intentionally has no memory toggle; the
backend preference endpoint remains available for explicit privacy administration.

The Inference Orchestrator owns retrieval, context assembly, prompt construction,
response length, model routing, and fixed sampling defaults. It can answer a reaction
such as `👍` through a direct route without calling a model. It can also accept the
Decision Engine's `no_reply` action as a `none` route, skipping retrieval and model
generation entirely. Model settings are not part of the character API.

Companion turns do not automatically require a visible answer. The reply policy uses
message demand, character personality and availability, affect, relationship warmth,
and conversational momentum. Silence is deterministic and audited; it is never inferred
from an empty provider response. Direct questions, explicit requests, distress, grief,
and relational conflict retain response priority. A successful no-reply turn returns
`reply: null` with `behavior.decision: "no_reply"` and still persists the user message,
memory candidates, state changes, decision record, and `none` inference audit.
Rejected or empty model output also produces no assistant message, but is recorded
separately as `responseStatus: "inference_failed"`; it is never treated as a character
decision and never replaced with synthetic dialogue.

Every chat request emits structured inference trace logs and returns a `traceId`. The
same metadata is stored in `inference_records.diagnostics` and
`generation_records.diagnostics`, including provider status, finish reason, extracted
text length, reasoning-content length, provider token usage, output validation, and
rejection reason. If a provider ends because of its output limit without returning
visible assistant text, the gateway retries once with a bounded output budget. This is
a provider retry, not a generated fallback: the second response still passes the normal
format and language checks, and an empty or invalid result remains a failed inference.
Prompts and secrets are not logged.
Rejected assistant output is stored in the inference audit as
`diagnostics.rejectedOutput`, bounded to 4,000 characters. This is the model's attempted
assistant message only; prompts, API keys, and retrieved context remain excluded.

`Character.language` is an output contract. A single-language value such as
`Cantonese` or `Cantonese only` is treated as strict: starter messages, model prompts,
and mock responses use that language. Strict model output is validated before it is
returned, so an English-dominant or explicitly Mandarin response cannot leak through
for a Cantonese-only character. Natural Cantonese may contain up to three common
English code-switch tokens when the surrounding grammar is clearly Cantonese; the
audit records `languageReason: "cantonese_code_switch"`. CJK-only sentences that are
linguistically ambiguous are accepted rather than falsely rejected. Invalid output is
audited without generating a replacement message. Chat output also uses a
dialogue-only contract: stage directions, facial-expression narration, inner thoughts,
and roleplay markup are not shown to the user.

Voice dictation is implemented in the frontend as an input modality. The browser MVP
uses Web Speech recognition and session-scoped audio capture, then stores transcript
metadata in `messages.content_json.voice` through the normal chat request. Raw audio is
not uploaded; see the repository-level voice architecture document for the future
realtime adapter boundary.
