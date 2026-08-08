import { ChatMessage } from './components/MessageBubble'

type ChatTimelineDateItem = {
  key: string
  kind: 'date'
  label: string
}

type ChatTimelineMessageItem = {
  key: string
  kind: 'message'
  message: ChatMessage
}

export type ChatTimelineItem = ChatTimelineDateItem | ChatTimelineMessageItem

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

export const chatTimeline = (messages: ChatMessage[]): ChatTimelineItem[] => {
  const items: ChatTimelineItem[] = []
  let previousDayKey: string | undefined

  messages.forEach(message => {
    const messageDate = parsedMessageDate(message)
    const dayKey = messageDate ? localDayKey(messageDate) : undefined
    if (messageDate && dayKey !== previousDayKey) {
      items.push({
        key: `date-${dayKey}`,
        kind: 'date',
        label: dateDividerLabel(messageDate),
      })
      previousDayKey = dayKey
    }
    items.push({
      key: `message-${message.id}`,
      kind: 'message',
      message,
    })
  })

  return items
}
