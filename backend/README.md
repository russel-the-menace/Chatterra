# Chatterra Backend

The Express API uses PostgreSQL for characters, conversations, messages, and
memories. See [DATABASE.md](./DATABASE.md) for the schema design.

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
- `PORT`: API port, default `3000`.
