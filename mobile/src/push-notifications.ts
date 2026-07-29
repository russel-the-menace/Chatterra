import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Notifications from 'expo-notifications'
import { useEffect, useRef } from 'react'
import { Platform } from 'react-native'
import { useRouter } from 'expo-router'

import { api } from './api'

const pushNotificationsEnabled = process.env.EXPO_PUBLIC_PUSH_NOTIFICATIONS_ENABLED === 'true'

if (pushNotificationsEnabled && Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  })
}

const projectId = () => {
  const configured = process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim()
  if (configured) return configured
  const expoProjectId = Constants.expoConfig?.extra?.eas?.projectId
  return typeof expoProjectId === 'string' && expoProjectId ? expoProjectId : Constants.easConfig?.projectId
}

const notificationCharacterId = (response: Notifications.NotificationResponse) => {
  const value = response.notification.request.content.data?.characterId
  return typeof value === 'string' && value ? value : undefined
}

const requestAndRegisterExpoPushToken = async (userId: string) => {
  if (!pushNotificationsEnabled || Platform.OS === 'web' || !Device.isDevice) return false

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'Messages',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 180, 110, 180],
      sound: 'default',
    })
  }

  const existing = await Notifications.getPermissionsAsync()
  const permissions = existing.granted ? existing : await Notifications.requestPermissionsAsync()
  if (!permissions.granted) return false

  const configuredProjectId = projectId()
  if (!configuredProjectId) {
    console.warn('Push notifications need an EAS project ID before this device can register.')
    return false
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId: configuredProjectId })
  await api.registerExpoPushDevice({
    userId,
    expoPushToken: token.data,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  })
  return true
}

export function usePushNotifications(userId: string | null) {
  const router = useRouter()
  const registeredUserIdRef = useRef<string | null>(null)
  const openedNotificationIdsRef = useRef(new Set<string>())

  useEffect(() => {
    if (!pushNotificationsEnabled || Platform.OS === 'web') return

    const openNotification = (response: Notifications.NotificationResponse) => {
      const notificationId = response.notification.request.identifier
      if (openedNotificationIdsRef.current.has(notificationId)) return
      const characterId = notificationCharacterId(response)
      if (!characterId) return
      openedNotificationIdsRef.current.add(notificationId)
      void Notifications.setBadgeCountAsync(0)
      router.push({ pathname: '/chat/[characterId]', params: { characterId } })
    }

    const subscription = Notifications.addNotificationResponseReceivedListener(openNotification)
    void Notifications.getLastNotificationResponseAsync().then(response => {
      if (response) openNotification(response)
    }).catch(() => undefined)
    return () => subscription.remove()
  }, [router])

  useEffect(() => {
    if (!userId || registeredUserIdRef.current === userId) return
    let cancelled = false

    void requestAndRegisterExpoPushToken(userId)
      .then(registered => {
        if (!cancelled && registered) registeredUserIdRef.current = userId
      })
      .catch(error => {
        console.warn('Could not register this device for push notifications.', error)
      })

    return () => {
      cancelled = true
    }
  }, [userId])
}
