import { Message } from './types'

export const CONVERSATION_TOPIC_GAP_MS = 12 * 60 * 60 * 1000

const timestamp = (message: Message) => new Date(message.createdAt).getTime()

// A long quiet gap starts a new ordinary-chat episode. Durable facts remain in
// memory, but a casual plan from the previous episode should not steer a reply.
export const activeConversationEpisode = (
  messages: Message[],
  now = new Date(),
  gapMs = CONVERSATION_TOPIC_GAP_MS
): Message[] => {
  const chronological = [...messages].sort((left, right) => (
    timestamp(left) - timestamp(right) || left.id.localeCompare(right.id)
  ))
  if (chronological.length === 0) return []

  const latestIndex = chronological.length - 1
  const latestAt = timestamp(chronological[latestIndex])
  if (!Number.isFinite(latestAt)) return chronological
  if (now.getTime() - latestAt > gapMs) return []

  let firstActiveIndex = latestIndex
  while (firstActiveIndex > 0) {
    const previousAt = timestamp(chronological[firstActiveIndex - 1])
    const currentAt = timestamp(chronological[firstActiveIndex])
    if (!Number.isFinite(previousAt) || !Number.isFinite(currentAt) || currentAt - previousAt > gapMs) {
      break
    }
    firstActiveIndex -= 1
  }
  return chronological.slice(firstActiveIndex)
}
