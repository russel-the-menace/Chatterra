# Chatterra MVP

AI language-practice chat with a Vite/React frontend, Express API, and
PostgreSQL persistence.

## Quick Start

1. Start PostgreSQL and migrate the legacy JSON data.

```
docker compose up -d postgres
cd backend
npm install
npm run db:setup
npm start
```

2. Start the frontend in another terminal.

```
cd frontend
npm install
npm run dev
```

The frontend calls `http://localhost:3000`. Database design and migration details
are documented in [`backend/DATABASE.md`](backend/DATABASE.md). The target behavioral
design, including the implemented Inference Orchestrator, is documented in
[`AI_COMPANION_ARCHITECTURE.md`](AI_COMPANION_ARCHITECTURE.md).
