import { router, Stack, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'
import { useEffect } from 'react'

import { ChatProvider, useChat } from '@/src/chat-context'
import { usePushNotifications } from '@/src/push-notifications'
import { ThemeProvider, useTheme } from '@/src/theme'

function PushNotificationRegistration() {
  const { userId } = useChat()
  usePushNotifications(userId)
  return null
}

function SessionRouteGuard() {
  const { ready, userId } = useChat()
  const segments = useSegments()

  useEffect(() => {
    if (!ready) return
    const onLogin = segments[0] === 'login'
    if (!userId && !onLogin) router.replace('/login')
    if (userId && onLogin) router.replace('/')
  }, [ready, segments, userId])

  return null
}

function RootNavigator() {
  const { palette } = useTheme()
  return (
    <ChatProvider>
      <PushNotificationRegistration />
      <SessionRouteGuard />
      <Stack
        screenOptions={{
          headerShown: false,
          animation: 'slide_from_right',
          contentStyle: { backgroundColor: palette.surface },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="login" />
        <Stack.Screen name="chat/[characterId]" />
        <Stack.Screen
          name="profile"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen
          name="character/[characterId]"
          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
        />
      </Stack>
      <StatusBar style="auto" />
    </ChatProvider>
  )
}

export default function RootLayout() {
  return <ThemeProvider><RootNavigator /></ThemeProvider>
}
