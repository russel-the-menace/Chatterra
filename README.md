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

3. Run the Expo/React Native client on an iPhone with Expo Go.

```bash
cd mobile
npm install
npm start
```

Keep the iPhone and Mac on the same Wi-Fi network, then scan the Metro QR code.
The mobile client derives the backend LAN host automatically and supports an
`EXPO_PUBLIC_API_URL` override. See [`mobile/README.md`](mobile/README.md) for
the complete physical-device setup and Expo Go constraints.

Both clients can use the production API at `https://api.feiwan.online`. Copy the
example environment files and set the same non-secret user ID in
`frontend/.env.local` and `mobile/.env` to synchronize conversations, messages,
characters, and pinned contacts:

```bash
VITE_USER_ID=YOUR_SHARED_USER_ID
EXPO_PUBLIC_USER_ID=YOUR_SHARED_USER_ID
```

This shared-ID bridge is intended for the current single-user deployment. It is
not authentication; a multi-user release needs account login and server-issued
sessions before exposing another user's data.

Database design and migration details are documented in
[`backend/DATABASE.md`](backend/DATABASE.md). The target behavioral
design, including the implemented Inference Orchestrator, is documented in
[`AI_COMPANION_ARCHITECTURE.md`](AI_COMPANION_ARCHITECTURE.md).
Voice dictation boundaries and the browser/realtime migration path are documented in
[`VOICE_INPUT_ARCHITECTURE.md`](VOICE_INPUT_ARCHITECTURE.md).
