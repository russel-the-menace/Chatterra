# Chatterra MVP

Minimal AI language-practice chat MVP.

Frontend (Vite + React) and backend (Express) are included.

Quick start


1. Backend

```
cd backend
npm install
npm start
```

2. Frontend (in another terminal)

```
cd frontend
npm install
npm run dev
```

Notes: both frontend and backend are migrated to TypeScript. Frontend uses Vite; backend runs with `ts-node-dev` during development.

The frontend calls `http://localhost:3000/api/chat` by default. Later we'll integrate OpenAI on the backend.
