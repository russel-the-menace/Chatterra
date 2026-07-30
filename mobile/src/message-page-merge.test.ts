import { mergeMessagePage } from './message-page-merge'
import { ChatMessage, UserVoiceMessage } from './types'

const expect = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

const sameIds = (messages: ChatMessage[], expected: string[]) => (
  messages.length === expected.length
  && messages.every((message, index) => message.id === expected[index])
)

const serverStarter: ChatMessage = {
  id: 'server-starter',
  sourceMessageId: 'server-starter',
  sender: 'assistant',
  text: 'Hi, I am Sofía. Let us start from zero.',
  createdAt: '2026-07-30T00:00:00.000Z',
}

const userMessage: ChatMessage = {
  id: 'server-user',
  sourceMessageId: 'server-user',
  sender: 'user',
  text: 'Hola',
}

const reply: ChatMessage = {
  id: 'server-reply',
  sourceMessageId: 'server-reply',
  sender: 'assistant',
  text: 'Perfecto.',
}

const localStarter: ChatMessage = {
  id: 'starter-sofia',
  sender: 'assistant',
  text: serverStarter.text,
}

const run = () => {
  const incoming = [serverStarter, userMessage, reply]
  const expectedIds = ['server-starter', 'server-user', 'server-reply']
  const firstSync = mergeMessagePage([localStarter, userMessage, reply], incoming, 'append')
  expect(sameIds(firstSync, expectedIds), 'first sync should replace the local starter in place')
  expect(firstSync[0].sourceMessageId === 'server-starter', 'starter should use its server ID')

  const cachedDuplicate = mergeMessagePage(
    [localStarter, userMessage, reply, serverStarter],
    incoming,
    'append'
  )
  expect(sameIds(cachedDuplicate, expectedIds), 'cached duplicate starter should be removed')

  const older: ChatMessage[] = [{
    id: 'older-message',
    sourceMessageId: 'older-message',
    sender: 'assistant',
    text: 'Older message',
  }]
  const prepended = mergeMessagePage([userMessage], older, 'prepend')
  expect(sameIds(prepended, ['older-message', 'server-user']), 'older history should prepend')

  const convertedVoice: UserVoiceMessage = {
    provider: 'user-recording',
    status: 'ready',
    audioUrl: '/voice-message.m4a',
    durationSeconds: 4,
    mimeType: 'audio/m4a',
    transcriptStatus: 'ready',
  }
  const locallyConvertedVoice: ChatMessage = {
    id: 'voice-message',
    sourceMessageId: 'voice-message',
    sender: 'user',
    text: 'What does gracias mean?',
    voice: convertedVoice,
    voiceTranscriptVisible: true,
  }
  const staleVoiceSnapshot: ChatMessage = {
    ...locallyConvertedVoice,
    text: '',
    voice: { ...convertedVoice, transcriptStatus: 'none' },
    voiceTranscriptVisible: false,
  }
  const protectedVoiceTranscript = mergeMessagePage(
    [locallyConvertedVoice],
    [staleVoiceSnapshot],
    'append'
  )[0]
  expect(protectedVoiceTranscript.text === locallyConvertedVoice.text,
    'a stale sync must not clear a converted voice transcript')
  expect(protectedVoiceTranscript.voice?.provider === 'user-recording'
    && protectedVoiceTranscript.voice.transcriptStatus === 'ready',
  'a stale sync must not reset a converted voice transcript status')
  expect(protectedVoiceTranscript.voiceTranscriptVisible === true,
    'a stale sync must retain the visible converted transcript')
  console.log('message page merge checks passed')
}

run()
