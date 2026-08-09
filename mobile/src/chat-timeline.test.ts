import { belongsToSameMessageCluster, chatTimeline } from './chat-timeline'
import { ChatMessage } from './types'

const expect = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

const message = (
  id: string,
  sender: ChatMessage['sender'],
  createdAt?: string
): ChatMessage => ({ id, sender, text: id, createdAt })

const run = () => {
  const first = message('first', 'assistant', '2026-07-30T10:00:00.000Z')
  const withinFiveMinutes = message('within-five', 'assistant', '2026-07-30T10:05:00.000Z')
  const afterFiveMinutes = message('after-five', 'assistant', '2026-07-30T10:10:01.000Z')
  expect(belongsToSameMessageCluster(first, withinFiveMinutes),
    'messages at exactly five minutes should remain in one cluster')
  expect(!belongsToSameMessageCluster(withinFiveMinutes, afterFiveMinutes),
    'messages more than five minutes apart should start a new cluster')
  expect(!belongsToSameMessageCluster(afterFiveMinutes, message('user', 'user', '2026-07-30T10:11:00.000Z')),
    'a sender change should start a new cluster')

  const nextDay = message('next-day', 'assistant', '2026-07-31T10:00:00.000Z')
  const timeline = chatTimeline([first, withinFiveMinutes, afterFiveMinutes, nextDay])
  const timelineMessages = timeline.filter(item => item.kind === 'message')
  const dateItems = timeline.filter(item => item.kind === 'date')
  expect(timelineMessages[0]?.kind === 'message' && timelineMessages[0].message.id === 'next-day',
    'the inverted display should expose the newest message first')
  expect(timelineMessages[2]?.kind === 'message' && timelineMessages[2].continuation,
    'same-sender messages within five minutes should continue an assistant cluster')
  expect(timelineMessages[1]?.kind === 'message' && !timelineMessages[1].continuation,
    'a new day should start a new assistant cluster')
  expect(dateItems.length === 2, 'each calendar day should add one date divider')
  expect(dateItems.every(item => item.kind === 'date' && /\d{2}:\d{2}$/.test(item.label)),
    'date dividers should end with a 24-hour local time')

  const twoHourBoundary = chatTimeline([
    message('block-last', 'assistant', '2026-07-30T10:00:00.000Z'),
    message('exactly-two-hours', 'user', '2026-07-30T12:00:00.000Z'),
    message('over-two-hours', 'assistant', '2026-07-30T14:00:01.000Z'),
  ]).filter(item => item.kind === 'date')
  expect(twoHourBoundary.length === 2,
    'a new time divider should appear only when the gap exceeds two hours')

  const segmentedFirst: ChatMessage = { id: 'segment-a', sourceMessageId: 'reply', sender: 'assistant', text: 'a' }
  const segmentedSecond: ChatMessage = { id: 'segment-b', sourceMessageId: 'reply', sender: 'assistant', text: 'b' }
  expect(belongsToSameMessageCluster(segmentedFirst, segmentedSecond),
    'segments from one assistant reply should remain in one cluster without timestamps')

  const userFirst = message('user-first', 'user', '2026-07-31T10:00:00.000Z')
  const userSecond = message('user-second', 'user', '2026-07-31T10:01:00.000Z')
  const userTimeline = chatTimeline([userFirst, userSecond])
  const userTimelineMessages = userTimeline.filter(item => item.kind === 'message')
  expect(userTimelineMessages[0]?.kind === 'message' && userTimelineMessages[0].continuation,
    'same-sender user messages should use the same continuation rule')
  console.log('chat timeline checks passed')
}

run()
