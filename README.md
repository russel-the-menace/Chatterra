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

Both clients can use the production API at `https://api.feiwan.online`. The API
uses server-issued internal account sessions, persisted locally by each client;
there is deliberately no public registration flow.

## Mobile Push Notifications

The remote-push implementation is present but disabled while using a free Apple Personal
Team. Re-enable it later by setting `EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=true` and
`PUSH_NOTIFICATIONS_ENABLED=true`, restoring the `expo-notifications` plugin in
`mobile/app.json`, setting `EXPO_PUBLIC_EAS_PROJECT_ID`, configuring APNs credentials for
`com.chatterra.mobile`, and installing a new native iOS build. See
[`mobile/README.md`](mobile/README.md) for details.

Database design and migration details are documented in
[`backend/DATABASE.md`](backend/DATABASE.md). The target behavioral
design, including the implemented Inference Orchestrator, is documented in
[`AI_COMPANION_ARCHITECTURE.md`](AI_COMPANION_ARCHITECTURE.md).
Voice dictation boundaries and the browser/realtime migration path are documented in
[`VOICE_INPUT_ARCHITECTURE.md`](VOICE_INPUT_ARCHITECTURE.md).

## Maya Voice Messages

Maya can optionally attach occasional, tap-to-play AI-generated voice messages to short
replies. Text remains the durable message source; the audio is a cached attachment and
can be revealed from the message action menu.

The initial provider is self-hosted Qwen3-TTS, not a bundled mobile model. It requires
an NVIDIA CUDA host and is disabled by default. Start the service with:

```bash
docker compose --profile voice up --build tts
```

Then set `MAYA_VOICE_MESSAGES_ENABLED=true` and `QWEN_TTS_URL=http://localhost:8001`
in `backend/.env`. See [`tts-service/README.md`](tts-service/README.md) for deployment
details. The first request downloads the model weights; normal text chat continues to
work if the service is unavailable.

## Mobile Push Notifications

The React Native client can receive system notifications when a character proactively
starts a new message. It registers an Expo Push token after the user grants permission;
the backend stores the token and sends only after the message has been persisted. Apply
database migration `015_add_expo_push_devices.sql`, initialize an EAS project, set
`EXPO_PUBLIC_EAS_PROJECT_ID` for the mobile build, and build a new iOS app with Apple
Push Notification credentials. Full setup is in [`mobile/README.md`](mobile/README.md).
