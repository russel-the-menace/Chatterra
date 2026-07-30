import { ChatMessage } from './types'

export const CHAT_CLUSTER_WINDOW_MS = 5 * 60 * 1_000

export const messageRenderKey = (message: ChatMessage) => message.renderKey || message.id

const parsedMessageDate = (message: ChatMessage) => {
  if (!message.createdAt) return undefined
  const date = new Date(message.createdAt)
  return Number.isFinite(date.getTime()) ? date : undefined
}

const localDayKey = (date: Date) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-')

const dateDividerLabel = (date: Date) => {
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const dayKey = localDayKey(date)
  if (dayKey === localDayKey(today)) return `Today ${time}`
  if (dayKey === localDayKey(yesterday)) return `Yesterday ${time}`
  const formattedDate = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date)
  return `${formattedDate} ${time}`
}

export const belongsToSameMessageCluster = (previous: ChatMessage, message: ChatMessage) => {
  if (previous.sender !== message.sender) return false
  if (previous.sourceMessageId && previous.sourceMessageId === message.sourceMessageId) return true
  const previousDate = parsedMessageDate(previous)
  const messageDate = parsedMessageDate(message)
  if (!previousDate || !messageDate || localDayKey(previousDate) !== localDayKey(messageDate)) {
    return false
  }
  const elapsed = messageDate.getTime() - previousDate.getTime()
  return elapsed >= 0 && elapsed <= CHAT_CLUSTER_WINDOW_MS
}

export type ChatTimelineMessageItem = {
  assistantContinuation: boolean
  key: string
  kind: 'message'
  message: ChatMessage
}

export type ChatTimelineDateItem = {
  key: string
  kind: 'date'
  label: string
}

export type ChatTimelineItem = ChatTimelineMessageItem | ChatTimelineDateItem

export const chatTimeline = (messages: ChatMessage[]): ChatTimelineItem[] => {
  const chronologicalItems: ChatTimelineItem[] = []
  let previousMessage: ChatMessage | undefined
  let previousDayKey: string | undefined

  messages.forEach(message => {
    const messageDate = parsedMessageDate(message)
    const dayKey = messageDate ? localDayKey(messageDate) : undefined
    if (messageDate && dayKey !== previousDayKey) {
      chronologicalItems.push({
        key: `date-${dayKey}`,
        kind: 'date',
        label: dateDividerLabel(messageDate),
      })
      previousDayKey = dayKey
    }
    chronologicalItems.push({
      assistantContinuation: Boolean(
        previousMessage
        && message.sender === 'assistant'
        && belongsToSameMessageCluster(previousMessage, message)
      ),
      key: `message-${messageRenderKey(message)}`,
      kind: 'message',
      message,
    })
    previousMessage = message
  })

  return chronologicalItems.reverse()
}

export const chatTimelineItemType = (item: ChatTimelineItem) => {
  if (item.kind === 'date') return 'date'
  const { message } = item
  if (message.loading) return 'loading'
  if (message.voice) return `${message.sender}-voice`
  if (message.quote || message.voiceTranscriptVisible || message.translationVisible) {
    return `${message.sender}-supplement`
  }
  return message.sender
}
