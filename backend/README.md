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
such as `👍` through a direct route without calling a model. Model settings are not
part of the character API.
