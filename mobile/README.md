# Chatterra Mobile

Expo/React Native client for the existing Chatterra API. It targets Expo SDK 54
so it can run in the current App Store version of Expo Go on a physical iPhone.

## Run On iPhone

Prerequisites:

- Expo Go installed on the iPhone
- Node.js 20.19+, 22.13+, or 24+ (Node 22 LTS is recommended)
- The Mac and iPhone on the same Wi-Fi network
- Access to the deployed Chatterra backend, or PostgreSQL and the backend running
  on the Mac for local development

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

If Expo Go initially shows only a blank development background, stop Metro and
restart once with `npm run start:clear`. Use the Node version in `.nvmrc`; Node
23 is outside the supported engine range of the current React Native toolchain.

With `nvm`, select the supported runtime before starting Metro:

```bash
nvm install
nvm use
```

Scan the QR code with the iPhone Camera app and open it in Expo Go. The default
example configuration uses the production API. For local backend development,
override it with the Mac's LAN address and port `3000`.

## API Address

Create `mobile/.env` from `.env.example`. To use a backend running on the Mac,
override the production URL:

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

## Accounts

The mobile app signs in with an internal Chatterra account. Registration is not
exposed in the app. A successful login stores an expiring local session, so the
user is not prompted again on normal app launches. Conversations, memories,
character settings, local message caches, and Quote drafts are isolated by the
authenticated account.

The clients poll a workspace snapshot while foregrounded. Character edits,
contact pins, new conversations, user messages, assistant messages, and history
clearing normally appear on another active device for the same account within
three seconds. PostgreSQL remains the source of truth, and concurrent first
messages reuse one active conversation.

## Included

- Database-backed character list and search
- Conversation history and natural `no_reply` handling
- Anchored message actions, quoted replies, and native range selection for copying
- Fixed composer with keyboard avoidance and focus-preserving message actions
- Per-character text drafts and device-persisted Quote drafts
- Foreground proactive-message polling and unread indicators
- Character creation and editing
- Tap-to-select avatar with native 1:1 crop and 512px compression
- Backend-derived activity state
- Native speech-to-text dictation in the chat composer

## Voice Boundary

The chat composer uses `expo-speech-recognition`, which maps to Apple's
`SFSpeechRecognizer` on iOS and the platform speech recognizer on Android.
It is a native module and therefore requires a development build; it does not
run in Expo Go. Build and install the iOS client with `npm run ios` after
pulling changes that affect the native configuration.

## Push Notifications

The remote-push implementation is currently disabled because it requires a paid Apple
Developer Program account for APNs. With the default configuration, the app does not ask
for notification permission, register a device token, or send push requests.

Set an EAS project ID in `mobile/.env` after `eas init`:

```bash
EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_ID
EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=true
```

For iOS, configure APNs credentials for `com.chatterra.mobile` in the associated Expo
project, set `PUSH_NOTIFICATIONS_ENABLED=true` in the backend, restore the
`expo-notifications` plugin in `app.json`, and install a newly built development or
production app. The iOS simulator cannot validate remote push delivery; this app already
requires a native build for dictation.

## Chat Scroll Invariants

The mobile chat screen has dynamic-height rows, keyboard-driven movement, and
short transcripts that must remain top-aligned. Preserve these invariants when
changing its layout:

- `LATEST_MESSAGE_COMPOSER_GAP` is the single source of truth for the resting
  gap. The final message row margin plus the list bottom padding must equal it.
- The composer and message list derive movement from the same `keyboardLift`.
  Short transcripts consume their unused space before the list moves, so a
  single message remains at the top while long transcripts track the composer.
- Do not use `VirtualizedList.scrollToEnd()` for initial positioning. It derives
  the target from an approximate last-cell frame, which can temporarily
  overscroll dynamic message rows. Use the measured
  `contentHeight - viewportHeight` offset instead.
- When the reader is more than half a viewport from the latest message, incoming
  messages must preserve the reading position and expose the down-arrow control.

Regression-check a one-message conversation, a long conversation on first
entry, keyboard open/close in both, and an incoming message while reading
history.

## Checks

```bash
npm run typecheck
npm run lint
npm run doctor
```
