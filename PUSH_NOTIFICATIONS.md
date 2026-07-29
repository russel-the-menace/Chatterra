# Deferred Push Notifications

Status: implemented but disabled while the app is signed with a free Apple Personal Team.

## Why Disabled

iOS remote push requires the `Push Notifications` capability and an APNs-enabled
provisioning profile. A free Apple Personal Team cannot sign that entitlement. The
implementation remains in the repository, but the default configuration does not request
notification permission, register a token, or send push requests.

## Current Switches

Keep both values disabled until the Apple Developer Program and APNs configuration are
available:

```bash
# mobile/.env
EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=false

# backend/.env
PUSH_NOTIFICATIONS_ENABLED=false
```

`expo-notifications` remains installed, but its plugin is intentionally absent from
`mobile/app.json`; this prevents Expo prebuild from adding the `aps-environment`
entitlement to iOS builds.

## Re-enable Checklist

1. Join the Apple Developer Program and enable **Push Notifications** for
   `com.chatterra.mobile` in Apple Developer.
2. Create or refresh the APNs credentials in the Expo/EAS project.
3. Run `eas init`, then set the resulting project ID:

   ```bash
   # mobile/.env
   EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_ID
   EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED=true
   ```

4. Set `PUSH_NOTIFICATIONS_ENABLED=true` in the backend runtime environment.
5. Restore `"expo-notifications"` to the `plugins` list in `mobile/app.json`, then
   regenerate native configuration and Pods:

   ```bash
   cd mobile
   npx expo prebuild --no-install
   npx pod-install ios
   npx expo run:ios --device
   ```

6. Deploy the backend and apply `backend/migrations/015_add_expo_push_devices.sql` with
   `npm run db:migrate`.
7. On a real device, grant notification permission. Send a proactive character message,
   verify the banner, then tap it and confirm the matching chat opens.

## Delivery Flow

1. The mobile client obtains an Expo Push Token after notification permission is granted
   and calls `PUT /api/push-devices/expo`.
2. `expo_push_devices` persists one enabled token per device token and user.
3. A committed proactive message triggers `sendProactivePushNotification` in
   `backend/push-notifications.ts`.
4. The backend sends an Expo Push payload with the character, conversation, and message
   IDs. The mobile notification handler opens `/chat/[characterId]` when the user taps it.
5. An immediate `DeviceNotRegistered` ticket disables the stale token. Normal transcript
   synchronization remains the fallback if delivery fails.

## Related Files

- `mobile/src/push-notifications.ts`
- `mobile/app/_layout.tsx`
- `backend/push-notifications.ts`
- `backend/migrations/015_add_expo_push_devices.sql`
