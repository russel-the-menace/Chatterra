import AsyncStorage from '@react-native-async-storage/async-storage'

const USER_ID_KEY = 'chatterra.mobile.userId'

const createUserId = () => (
  `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
)

export const getOrCreateUserId = async () => {
  const configuredUserId = process.env.EXPO_PUBLIC_USER_ID?.trim()
  if (configuredUserId) return configuredUserId

  const existing = await AsyncStorage.getItem(USER_ID_KEY)
  if (existing) return existing

  const created = createUserId()
  await AsyncStorage.setItem(USER_ID_KEY, created)
  return created
}
