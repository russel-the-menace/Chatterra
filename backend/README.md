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
- `PROACTIVE_SCHEDULER_ENABLED`: set to `false` to disable background character
  initiation; enabled by default.
- `PROACTIVE_SCHEDULER_INTERVAL_MS`: scheduler scan interval, default `30000`.
- `PROACTIVE_MIN_DELAY_MINUTES` and `PROACTIVE_MAX_DELAY_MINUTES`: optional internal
  development overrides for character-derived initiative timing. They are not user settings.
- `PORT`: API port, default `3000`.

The chat API does not accept a user-selected interaction mode. It derives an internal
base policy from the stored character definition. Teaching characters retain their
learning role, while the Inference Orchestrator can prioritize grief, distress, or
relationship repair over correction for the current turn. Proactive companion
initiation uses the same persisted decision, inference, generation, event, and outbox
records as user-triggered chat.

Memory is automatic by default. The UI intentionally has no memory toggle; the
backend preference endpoint remains available for explicit privacy administration.

The Inference Orchestrator owns retrieval, context assembly, prompt construction,
response length, model routing, and fixed sampling defaults. It can answer a reaction
such as `👍` through a direct route without calling a model. It can also accept the
Decision Engine's `no_reply` action as a `none` route, skipping retrieval and model
generation entirely. Model settings are not part of the character API.

Response length is a conversational upper tendency, not a quota. Casual turns default
to compact replies, while information demand, narrative depth, emotional importance,
personality, energy, and relationship state can expand or contract the target. A
separate message-cadence policy lets a character return one to three chat bubbles when
their persona and established history support that style. The provider marks intentional
bubble boundaries with an internal separator; the server validates and stores them in
`messages.content_json.deliverySegments` while retaining one complete assistant turn for
memory, context, and inference auditing.

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

Characters whose authored persona explicitly expresses initiative derive a private
proactive policy; there is no user-facing toggle or timing control. After an assistant
turn, the policy writes a jittered `character_instances.next_action_at`. The scheduler
claims due work with a lease, skips sleeping characters, verifies that the user has not
replied during generation, and caps consecutive unanswered proactive messages. Topic
selection happens inside the Inference Orchestrator from persona domains, current
activity, recent conversation, memories, and affect. The prompt prohibits guilt,
pressure, relationship tests, fabricated emergencies, and mention of scheduling.

Every chat request emits structured inference trace logs and returns a `traceId`. The
same metadata is stored in `inference_records.diagnostics` and
`generation_records.diagnostics`, including provider status, finish reason, extracted
text length, reasoning-content length, provider token usage, output validation, and
rejection reason. If a provider ends because of its output limit without returning
visible assistant text, the gateway retries once with a bounded output budget. This is
a provider retry, not a generated fallback: the second response still passes the normal
format normalization and language observation, and an empty or format-only result
remains a failed inference.
Prompts and secrets are not logged.
Rejected assistant output is stored in the inference audit as
`diagnostics.rejectedOutput`, bounded to 4,000 characters. This is the model's attempted
assistant message only; prompts, API keys, and retrieved context remain excluded.

`Character.language` is an output contract. A single-language value such as
`Cantonese` or `Cantonese only` is treated as strict: starter messages, model prompts,
and mock responses use that language. Post-response language checks are observational:
they never suppress a non-empty normalized model response. A mismatch is recorded in
the inference trace with script counts, English dominance, severity, and a likely cause
such as user-language mirroring, mixed-language mirroring, dialect drift, or model
language drift. In particular, substantial English in a Cantonese or Mandarin context
is logged as `substantial_english_in_chinese_context` and still returned to the user.
A short CJK term copied from the latest user message by an English teaching character
is classified as a source-term reference rather than drift. Chat output still uses a
dialogue-only contract: stage directions, facial-expression narration, inner thoughts,
and roleplay markup are not shown to the user.

Voice dictation is implemented in the frontend as an input modality. The browser MVP
uses Web Speech recognition and session-scoped audio capture, then stores transcript
metadata in `messages.content_json.voice` through the normal chat request. Raw audio is
not uploaded; see the repository-level voice architecture document for the future
realtime adapter boundary.
