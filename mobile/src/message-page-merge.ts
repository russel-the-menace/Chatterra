import { ChatMessage } from './types'

const mergeMessageUiState = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const currentById = new Map(current.map(message => [message.id, message]))
  return incoming.map(message => {
    const existing = currentById.get(message.id)
    if (!existing) return message
    const preserveReadyVoiceTranscript = (
      existing.voice?.provider === 'user-recording'
      && message.voice?.provider === 'user-recording'
      && existing.voice.transcriptStatus === 'ready'
      && message.voice.transcriptStatus === 'none'
    )
    const mergedVoice = preserveReadyVoiceTranscript ? existing.voice : message.voice
    return {
      ...message,
      ...(preserveReadyVoiceTranscript
        ? { text: existing.text || message.text, voice: existing.voice }
        : {}),
      renderKey: existing.renderKey || message.renderKey,
      translation: existing.translation || message.translation,
      translationVisible: existing.translation !== undefined
        || existing.translationLoading
        || existing.translationError
        ? existing.translationVisible
        : message.translationVisible,
      translationLoading: existing.translationLoading,
      translationError: existing.translationError,
      voiceTranscriptionLoading: existing.voiceTranscriptionLoading,
      voiceTranscriptVisible: existing.voiceTranscriptVisible && Boolean(mergedVoice),
    }
  })
}

const reconcileLocalStarter = (current: ChatMessage[], incoming: ChatMessage[]) => {
  const serverStarter = incoming[0]
  if (
    !serverStarter
    || serverStarter.sender !== 'assistant'
    || !serverStarter.sourceMessageId
  ) return current

  const localStarter = current.find(message => (
    message.sender === 'assistant'
    && !message.sourceMessageId
    && !message.loading
    && message.id.startsWith('starter-')
    && message.text === serverStarter.text
  ))
  if (!localStarter) return current

  // The starter is shown locally before a conversation exists. Once its persisted
  // counterpart arrives, retain the local position but adopt the server identity.
  return current
    .filter(message => message.id !== serverStarter.id)
    .map(message => (
      message.id === localStarter.id
        ? { ...message, ...serverStarter, renderKey: message.renderKey || serverStarter.renderKey }
        : message
    ))
}

export const mergeMessagePage = (
  current: ChatMessage[],
  incoming: ChatMessage[],
  position: 'prepend' | 'append'
) => {
  const reconciledCurrent = reconcileLocalStarter(current, incoming)
  const currentById = new Map(reconciledCurrent.map(message => [message.id, message]))
  const hydratedIncoming = mergeMessageUiState(reconciledCurrent, incoming)
  const incomingById = new Map(hydratedIncoming.map(message => [message.id, message]))
  const preservedCurrent = reconciledCurrent.map(message => incomingById.get(message.id) || message)
  const unseenIncoming = hydratedIncoming.filter(message => !currentById.has(message.id))

  return position === 'prepend'
    ? [...unseenIncoming, ...preservedCurrent]
    : [...preservedCurrent, ...unseenIncoming]
}
