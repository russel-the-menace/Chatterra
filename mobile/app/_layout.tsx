import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'

import { ChatProvider, useChat } from '@/src/chat-context'
import { usePushNotifications } from '@/src/push-notifications'
import { palette } from '@/src/theme'

function PushNotificationRegistration() {
  const { userId } = useChat()
  usePushNotifications(userId)
  return null
}

export default function RootLayout() {
  return (
    <ChatProvider>
      <PushNotificationRegistration />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: palette.surface },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="chat/[characterId]" />
        <Stack.Screen
          name="character/[characterId]"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </Stack>
      <StatusBar style="dark" />
    </ChatProvider>
  )
}
