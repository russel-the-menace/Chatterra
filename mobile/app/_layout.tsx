import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import 'react-native-reanimated'

import { ChatProvider } from '@/src/chat-context'
import { palette } from '@/src/theme'

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ChatProvider>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: 'slide_from_right',
              contentStyle: { backgroundColor: palette.background },
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
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
