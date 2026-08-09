import React, {useEffect, useRef, useState} from 'react'
import { Character } from '../data/character'
import { WeChatVoiceWave } from './wechat-voice-wave'

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

export type UserVoiceMessage = {
  provider: 'user-recording'
  status: 'ready'
  audioUrl: string
  durationSeconds: number
  mimeType: 'audio/mp4' | 'audio/m4a' | 'audio/x-m4a' | 'audio/3gpp' | 'audio/webm'
  transcriptStatus: 'none' | 'ready'
}

export type MessageVoice = AssistantVoiceMessage | UserVoiceMessage

export type MessageQuote = {
  sourceMessageId?: string
  segmentIndex: number
  senderRole: 'user' | 'assistant'
  senderName: string
  text: string
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
  voice?: MessageVoice
  voiceTranscriptVisible?: boolean
  voiceTranscriptionLoading?: boolean
  quote?: MessageQuote
  createdAt?: string
}

const isImageAvatar = (avatar?: string) => Boolean(avatar && /^(data:image\/|blob:|https?:\/\/|\/)/.test(avatar))
const voiceBubbleWidth = (duration: number | undefined, viewportWidth: number) => {
  const minWidth = 92
  const maxWidth = Math.max(minWidth, viewportWidth / 2 - 60)
  const clampedDuration = Math.min(11, Math.max(1, duration || 1))
  return minWidth + (maxWidth - minWidth) * ((clampedDuration - 1) / 10)
}

export default function MessageBubble({
  msg,
  character,
  userAvatar,
  userName,
  onEditCharacter,
  onPreviewAvatar,
  onMessageContextMenu
}:{
  msg: ChatMessage
  character: Character
  userAvatar?: string
  userName?: string
  onEditCharacter: () => void
  onPreviewAvatar: (avatar: string | undefined, name: string, muted?: boolean) => void
  onMessageContextMenu: (event: React.MouseEvent<HTMLDivElement>, message: ChatMessage) => void
}): JSX.Element{
  const isUser = msg.sender === 'user'
  const bubbleClass = "bubble "+(isUser? 'user':'ai')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [waveLevel, setWaveLevel] = useState(3)
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth)
  const readyVoice = msg.voice?.status === 'ready' && Boolean(msg.voice.audioUrl)
  const isSingleLineMessage = !msg.loading
    && !readyVoice
    && !/[\r\n]/.test(msg.text)
  const duration = Math.max(1, Math.round(msg.voice?.durationSeconds || 1))
  const isUserVoice = msg.voice?.provider === 'user-recording'
  const characterAvatar = isImageAvatar(character.avatar)
    ? <img src={character.avatar} alt="" />
    : <span>{character.avatar || character.name.slice(0, 1)}</span>
  const userAvatarContent = isImageAvatar(userAvatar)
    ? <img src={userAvatar} alt="" />
    : <span>{(userName || 'Me').trim().slice(0, 1).toUpperCase() || 'M'}</span>

  useEffect(() => () => {
    audioRef.current?.pause()
  }, [])

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

  useEffect(() => {
    if (!playing) {
      setWaveLevel(3)
      return
    }
    let level = 1
    setWaveLevel(level)
    const timer = window.setInterval(() => {
      level = level === 3 ? 1 : level + 1
      setWaveLevel(level)
    }, 220)
    return () => window.clearInterval(timer)
  }, [playing])

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
          className="avatar assistant avatar-preview-trigger"
          onClick={() => onPreviewAvatar(character.avatar, character.name)}
          aria-label={`Preview ${character.name}'s avatar`}
          title={`Preview ${character.name}'s avatar`}
        >
          {characterAvatar}
        </button>
      )}
      <div className="message-content">
        <div
          className={`${bubbleClass}${isSingleLineMessage ? ' single-line' : ''}`}
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
                className={`voice-note${isUserVoice ? ' user-voice' : ''}${playing ? ' playing' : ''}`}
                style={{ width: voiceBubbleWidth(msg.voice?.durationSeconds, viewportWidth) }}
                onClick={() => void toggleVoice()}
                aria-label={`${playing ? 'Pause' : 'Play'} voice message`}
              >
                <WeChatVoiceWave
                  color={isUser ? '#FFFFFF' : '#171b22'}
                  level={waveLevel}
                  mirrored={isUser}
                />
                <span className="voice-note-duration">{`${duration}"`}</span>
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
        {msg.quote && (
          <div className={`sent-quote${isUser ? ' sent-quote-user' : ''}`}>
            <strong>{msg.quote.senderName}: </strong>{msg.quote.text}
          </div>
        )}
        {readyVoice && msg.voiceTranscriptVisible && (
          <div className={`voice-transcript${isUser ? ' user-voice-transcript' : ''}`} role="status">
            {msg.voiceTranscriptionLoading ? 'Converting to text...' : msg.text}
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
      {isUser && (
        <button
          type="button"
          className="avatar user avatar-preview-trigger"
          onClick={() => onPreviewAvatar(userAvatar, userName || 'Me', true)}
          aria-label="Preview your avatar"
          title="Preview your avatar"
        >
          {userAvatarContent}
        </button>
      )}
    </div>
  )
}
