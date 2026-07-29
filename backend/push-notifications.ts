import {
  disableExpoPushDevice,
  listEnabledExpoPushTokens,
} from './repository'

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send'
const MAX_EXPO_PUSH_MESSAGES = 100
const MAX_NOTIFICATION_BODY_LENGTH = 140

export type ProactivePushNotification = {
  characterId: string
  characterName: string
  conversationId: string
  messageId: string
  content: string
}

type ExpoPushTicket = {
  status?: string
  details?: { error?: string }
}

export const isExpoPushToken = (value: string) => (
  /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(value)
)

export const notificationPreview = (content: string) => {
  const compact = content.replace(/\s+/g, ' ').trim()
  if (compact.length <= MAX_NOTIFICATION_BODY_LENGTH) return compact
  return `${compact.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1).trimEnd()}…`
}

export const pushNotificationsEnabled = () => process.env.PUSH_NOTIFICATIONS_ENABLED === 'true'

export const buildExpoPushMessages = (
  tokens: string[],
  notification: ProactivePushNotification
) => tokens.map(token => ({
  to: token,
  title: notification.characterName,
  body: notificationPreview(notification.content),
  sound: 'default',
  badge: 1,
  priority: 'high',
  data: {
    type: 'chat_message',
    characterId: notification.characterId,
    conversationId: notification.conversationId,
    messageId: notification.messageId,
    url: `/chat/${notification.characterId}`,
  },
}))

const chunks = <T,>(items: T[], size: number) => {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

export const sendProactivePushNotification = async ({
  userId,
  ...notification
}: ProactivePushNotification & { userId: string }) => {
  if (!pushNotificationsEnabled()) return

  const tokens = await listEnabledExpoPushTokens(userId)
  if (tokens.length === 0) return

  const endpoint = process.env.EXPO_PUSH_ENDPOINT?.trim() || EXPO_PUSH_ENDPOINT
  for (const batch of chunks(buildExpoPushMessages(tokens, notification), MAX_EXPO_PUSH_MESSAGES)) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`Expo push service returned ${response.status}`)
      }

      const payload = await response.json().catch(() => ({})) as { data?: ExpoPushTicket[] }
      const tickets = Array.isArray(payload.data) ? payload.data : []
      await Promise.all(tickets.map((ticket, index) => (
        ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered'
          ? disableExpoPushDevice(batch[index]?.to).catch(error => {
            console.error('Could not disable unregistered Expo push device', error)
          })
          : undefined
      )))
    } finally {
      clearTimeout(timeout)
    }
  }
}
