import React, { useRef, useState } from 'react'
import { useVoiceInput } from '../voice/useVoiceInput'
import { VoiceInputStatus, VoiceTranscriptMetadata } from '../voice/types'

type InputBoxProps = {
  onSend: (text: string, voice?: VoiceTranscriptMetadata) => void
  language?: string
}

const MicrophoneIcon = ({ recording }: { recording: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="voice-microphone-icon">
    <path
      d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
      fill={recording ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const voiceStatusLabel = (status: VoiceInputStatus, error?: string) => {
  if (status === 'recording') return 'Listening...'
  if (status === 'processing') return 'Converting speech...'
  if (status === 'error') return error || 'Voice input failed.'
  return ''
}

export default function InputBox({ onSend, language }: InputBoxProps): JSX.Element {
  const [text, setText] = useState('')
  const [voiceMetadata, setVoiceMetadata] = useState<VoiceTranscriptMetadata | undefined>()
  const isComposing = useRef(false)
  const voice = useVoiceInput({
    language,
    onTranscriptChange: (transcript, metadata) => {
      setText(transcript)
      setVoiceMetadata(metadata.originalText ? metadata : undefined)
    }
  })

  const submit = () => {
    if (voice.status === 'recording' || voice.status === 'processing') return
    const trimmed = text.trim()
    if (!trimmed) return

    const finalVoice = voiceMetadata?.originalText
      ? {
          ...voiceMetadata,
          correctedText: trimmed !== voiceMetadata.originalText ? trimmed : undefined
        }
      : undefined
    onSend(trimmed, finalVoice)
    setText('')
    setVoiceMetadata(undefined)
    voice.reset()
  }

  const handleTextChange = (value: string) => {
    setText(value)
    if (voiceMetadata && voice.status !== 'recording') {
      setVoiceMetadata(previous => previous
        ? {
            ...previous,
            correctedText: value.trim() && value.trim() !== previous.originalText
              ? value.trim()
              : undefined
          }
        : previous)
    }
  }

  const statusLabel = voiceStatusLabel(voice.status, voice.error)
  const buttonLabel = voice.status === 'recording'
    ? 'Stop recording'
    : voice.status === 'processing'
      ? 'Converting speech'
      : voice.status === 'error'
        ? 'Try voice input again'
        : 'Start voice input'

  return (
    <div className="input-box">
      <div className="input-compose-row">
        <textarea
          value={text}
          onChange={event => handleTextChange(event.target.value)}
          onCompositionStart={() => {
            isComposing.current = true
          }}
          onCompositionEnd={() => {
            isComposing.current = false
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              if (
                isComposing.current
                || event.nativeEvent.isComposing
                || event.nativeEvent.keyCode === 229
              ) return

              event.preventDefault()
              submit()
            }
          }}
          aria-label="Message"
          placeholder="Type your message..."
        />
        <div className="input-actions">
          <button
            type="button"
            className={`voice-button voice-${voice.status}`}
            onClick={() => voice.toggle(text)}
            disabled={voice.status === 'processing'}
            aria-label={buttonLabel}
            aria-pressed={voice.status === 'recording'}
            title={buttonLabel}
          >
            {voice.status === 'processing'
              ? <span className="voice-spinner" aria-hidden="true" />
              : voice.status === 'error'
                ? <span className="voice-error-mark" aria-hidden="true">!</span>
                : <MicrophoneIcon recording={voice.status === 'recording'} />}
          </button>
          <button
            type="button"
            className="send"
            onClick={submit}
            disabled={!text.trim() || voice.status === 'recording' || voice.status === 'processing'}
          >
            Send
          </button>
        </div>
      </div>
      {statusLabel && (
        <div
          className={`voice-status voice-status-${voice.status}`}
          role={voice.status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {statusLabel}
        </div>
      )}
    </div>
  )
}
