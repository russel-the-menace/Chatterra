import React, {useEffect, useRef, useState} from 'react'
import { Character } from '../data/character'

export type AssistantVoiceMessage = {
  provider: 'qwen3-tts'
  status: 'pending' | 'ready' | 'failed'
  segmentIndex: number
  voiceId: 'maya'
  style: string
  audioUrl?: string
  durationSeconds?: number
  mimeType?: 'audio/wav'
  generatedAt?: string
}

export type ChatMessage = {
  id: string
  sender: 'ai' | 'user'
  text: string
  loading?: boolean
  sourceMessageId?: string
  segmentIndex?: number
  translation?: string
  translationVisible?: boolean
  translationLoading?: boolean
  translationError?: string
  voice?: AssistantVoiceMessage
  voiceTranscriptVisible?: boolean
}

const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))

export default function MessageBubble({
  msg,
  character,
  onEditCharacter,
  onMessageContextMenu
}:{
  msg: ChatMessage
  character: Character
  onEditCharacter: () => void
  onMessageContextMenu: (event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) => void
}): JSX.Element{
  const isUser = msg.sender === 'user'
  const bubbleClass = "bubble "+(isUser? 'user':'ai')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const readyVoice = msg.voice?.status === 'ready' && Boolean(msg.voice.audioUrl)
  const duration = Math.max(1, Math.round(msg.voice?.durationSeconds || 1))
  const characterAvatar = isImageAvatar(character.avatar)
    ? <img src={character.avatar} alt="" />
    : <span>{character.avatar || character.name.slice(0, 1)}</span>

  useEffect(() => () => {
    audioRef.current?.pause()
  }, [])

  const toggleVoice = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      await audio.play().catch(() => undefined)
      return
    }
    audio.pause()
  }

  return (
    <div className={"message-row "+(isUser? 'right':'left')}>
      {!isUser && (
        <button
          type="button"
          className="avatar assistant chat-character-edit-trigger"
          onClick={onEditCharacter}
          aria-label={`Edit ${character.name}`}
          title="Edit character"
        >
          {characterAvatar}
        </button>
      )}
      <div className="message-content">
        {!isUser && (
          <button
            type="button"
            className="message-character-name chat-character-edit-trigger"
            onClick={onEditCharacter}
            title="Edit character"
          >
            {character.name}
          </button>
        )}
        <div
          className={bubbleClass}
          onContextMenu={event => onMessageContextMenu(event, msg)}
        >
          {msg.loading ? (
            <span className="typing">
              <span className="dot"/> <span className="dot"/> <span className="dot"/>
            </span>
          ) : readyVoice ? (
            <>
              <button
                type="button"
                className={`voice-note${playing ? ' playing' : ''}`}
                onClick={() => void toggleVoice()}
                aria-label={`${playing ? 'Pause' : 'Play'} Maya voice message`}
              >
                <span className="voice-note-icon" aria-hidden="true">))</span>
                <span className="voice-note-wave" aria-hidden="true"><i/><i/><i/><i/></span>
                <span className="voice-note-duration">{duration}\"</span>
              </button>
              <audio
                ref={audioRef}
                preload="metadata"
                src={msg.voice?.audioUrl}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
            </>
          ) : (
            msg.text
          )}
        </div>
        {readyVoice && msg.voiceTranscriptVisible && (
          <div className="voice-transcript" role="status">
            <span>Voice message</span>
            {msg.text}
          </div>
        )}
        {msg.translationVisible && !msg.loading && (
          <div
            className={`message-translation${msg.translationError ? ' error' : ''}`}
            role="status"
            aria-live="polite"
            aria-busy={msg.translationLoading || undefined}
          >
            {msg.translationLoading
              ? (
                  <span className="translation-loading">
                    <span className="translation-spinner" aria-hidden="true" />
                    <span>Translating...</span>
                  </span>
                )
              : msg.translationError || msg.translation}
          </div>
        )}
      </div>
      {isUser && <div className="avatar user">Me</div>}
    </div>
  )
}
