# Chatterra Mobile

Expo/React Native client for the existing Chatterra API. It targets Expo SDK 54
so it can run in the current App Store version of Expo Go on a physical iPhone.

## Run On iPhone

Prerequisites:

- Expo Go installed on the iPhone
- Node.js 20.19+, 22.13+, or 24+ (Node 22 LTS is recommended)
- The Mac and iPhone on the same Wi-Fi network
- PostgreSQL and the Chatterra backend running on the Mac

Start the backend from the repository root:

```bash
docker compose up -d postgres
cd backend
npm install
npm run db:migrate
npm start
```

Start Expo in another terminal:

```bash
cd mobile
npm install
npm start
```

Scan the QR code with the iPhone Camera app and open it in Expo Go. The mobile
client normally derives the Mac's LAN address from Metro and calls port `3000`.

## API Address

If automatic LAN discovery does not reach the backend, create `mobile/.env`:

```bash
EXPO_PUBLIC_API_URL=http://YOUR_MAC_LAN_IP:3000
```

For Wi-Fi, the Mac address is commonly available with:

```bash
ipconfig getifaddr en0
```

Reload the app in Expo Go after changing `.env`. The value is public client
configuration; never put API keys or other secrets in an `EXPO_PUBLIC_` value.

`npm run start:tunnel` tunnels Metro only. It does not expose the Express API.
When the phone cannot access the Mac over LAN, expose the backend through a
separate HTTPS tunnel and set that URL in `EXPO_PUBLIC_API_URL`.

## Device Identity

There is no authentication layer yet. By default, the mobile app creates a
persistent device-specific user ID, so its conversations and relationship state
are separate from the browser client.

To use an existing local identity on both clients, copy the browser's
`chatterra_userId` value and add this to `mobile/.env`:

```bash
EXPO_PUBLIC_USER_ID=YOUR_EXISTING_USER_ID
```

This is a development bridge, not a substitute for account authentication and
secure device linking.

## Included

- Database-backed character list and search
- Conversation history and natural `no_reply` handling
- Fixed composer with keyboard avoidance
- Per-character in-memory drafts
- Foreground proactive-message polling and unread indicators
- Character creation and editing
- Tap-to-select avatar with native 1:1 crop and 512px compression
- Backend-derived activity state

## Voice Boundary

The web client uses the browser Web Speech API. Expo Go does not provide an
equivalent speech-to-text API, and native speech-recognition libraries that are
not bundled into Expo Go require a development build. Mobile dictation should
therefore be added through either a backend streaming transcription service or
an Expo development build with a native recognition module.

## Checks

```bash
npm run typecheck
npm run lint
npm run doctor
```
