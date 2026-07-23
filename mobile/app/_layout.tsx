import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import 'react-native-reanimated'

import { ChatProvider } from '@/src/chat-context'
import { palette } from '@/src/theme'

export default function RootLayout() {
  return (
    <ChatProvider>
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
