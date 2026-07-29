import assert from 'node:assert/strict'
import { mergeMessagePage } from '../mobile/src/message-page-merge'
import { ChatMessage } from '../mobile/src/types'

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
  const firstSync = mergeMessagePage([localStarter, userMessage, reply], incoming, 'append')
  assert.deepEqual(firstSync.map(message => message.id), [
    'server-starter',
    'server-user',
    'server-reply',
  ])
  assert.equal(firstSync[0].sourceMessageId, 'server-starter')

  const cachedDuplicate = mergeMessagePage(
    [localStarter, userMessage, reply, serverStarter],
    incoming,
    'append'
  )
  assert.deepEqual(cachedDuplicate.map(message => message.id), [
    'server-starter',
    'server-user',
    'server-reply',
  ])

  const older = [{
    id: 'older-message',
    sourceMessageId: 'older-message',
    sender: 'assistant' as const,
    text: 'Older message',
  }]
  const prepended = mergeMessagePage([userMessage], older, 'prepend')
  assert.deepEqual(prepended.map(message => message.id), ['older-message', 'server-user'])
  console.log('message page merge checks passed')
}

run()
