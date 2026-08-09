import React, { PointerEvent, useEffect, useRef, useState } from 'react'
import { AudioCapture, AudioCaptureError } from '../voice/audioCapture'
import { VoiceTranscriptMetadata } from '../voice/types'
import { WeChatVoiceWave } from './wechat-voice-wave'

export type RecordedVoiceMessage = {
  audio: Blob
  durationMilliseconds: number
}

type InputBoxProps = {
  onSend: (text: string, voice?: VoiceTranscriptMetadata) => void
  onSendVoice: (voice: RecordedVoiceMessage) => Promise<void>
  onTranscribeVoice: (voice: RecordedVoiceMessage) => Promise<string>
  draft: string
  onDraftChange: (draft: string) => void
}

type RecorderState = 'idle' | 'starting' | 'message-recording' | 'dictation-recording' | 'processing' | 'sending'

const KeyboardIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="composer-icon">
    <rect x="3" y="5" width="18" height="14" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M7 9h.01M11 9h.01M15 9h.01M7 13h6M16 13h.01" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" />
  </svg>
)

const MicrophoneIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="composer-icon">
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const CloseIcon = () => <span aria-hidden="true" className="composer-command-glyph">×</span>
const CheckIcon = () => <span aria-hidden="true" className="composer-command-glyph">✓</span>

function RecordingWaveform({ level, active }: { level: number; active: boolean }) {
  return (
    <div
      className={`recording-waveform${active ? ' active' : ''}`}
      style={{ '--voice-level': String(Math.max(0.12, level)) } as React.CSSProperties}
      aria-hidden="true"
    >
      {Array.from({ length: 30 }, (_, index) => {
        const seed = (Math.sin(index * 1.73) + 1) / 2
        const height = 6 + seed * 20
        return <i key={index} style={{ height }} />
      })}
    </div>
  )
}

export default function InputBox({
  onSend,
  onSendVoice,
  onTranscribeVoice,
  draft,
  onDraftChange,
}: InputBoxProps): JSX.Element {
  const [voiceMessageMode, setVoiceMessageMode] = useState(false)
  const [recorderState, setRecorderState] = useState<RecorderState>('idle')
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const [voiceMetadata, setVoiceMetadata] = useState<VoiceTranscriptMetadata | undefined>()
  const captureRef = useRef<AudioCapture | null>(null)
  const startedAtRef = useRef(0)
  const currentModeRef = useRef<'message' | 'dictation' | null>(null)
  const cancelledBeforeReadyRef = useRef(false)
  const isComposing = useRef(false)

  const resetRecorder = () => {
    captureRef.current?.abort()
    captureRef.current = null
    currentModeRef.current = null
    cancelledBeforeReadyRef.current = false
    setRecorderState('idle')
    setLevel(0)
  }

  useEffect(() => () => captureRef.current?.abort(), [])

  const recordingResult = async (): Promise<RecordedVoiceMessage | undefined> => {
    const capture = captureRef.current
    if (!capture) return undefined
    const durationMilliseconds = Date.now() - startedAtRef.current
    const audio = await capture.stop()
    captureRef.current = null
    currentModeRef.current = null
    setLevel(0)
    if (!audio || audio.size === 0 || durationMilliseconds < 250) {
      setError('Record for a little longer before sending.')
      setRecorderState('idle')
      return undefined
    }
    return { audio, durationMilliseconds }
  }

  const startRecording = async (mode: 'message' | 'dictation') => {
    if (recorderState !== 'idle') return
    setError('')
    setRecorderState('starting')
    currentModeRef.current = mode
    cancelledBeforeReadyRef.current = false
    const capture = new AudioCapture(nextLevel => setLevel(nextLevel))
    captureRef.current = capture
    try {
      await capture.start()
      if (cancelledBeforeReadyRef.current || currentModeRef.current !== mode) {
        capture.abort()
        captureRef.current = null
        currentModeRef.current = null
        setRecorderState('idle')
        setLevel(0)
        return
      }
      startedAtRef.current = Date.now()
      setRecorderState(mode === 'message' ? 'message-recording' : 'dictation-recording')
    } catch (captureError) {
      capture.abort()
      captureRef.current = null
      currentModeRef.current = null
      setRecorderState('idle')
      setError(captureError instanceof AudioCaptureError
        ? captureError.message
        : 'The microphone could not be opened.')
    }
  }

  const cancelRecording = () => {
    cancelledBeforeReadyRef.current = true
    resetRecorder()
  }

  const finishVoiceMessage = async () => {
    if (recorderState === 'starting') {
      cancelledBeforeReadyRef.current = true
      return
    }
    if (recorderState !== 'message-recording') return
    setRecorderState('sending')
    try {
      const recording = await recordingResult()
      if (recording) await onSendVoice(recording)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send this voice message.')
    } finally {
      setRecorderState('idle')
    }
  }

  const finishDictation = async () => {
    if (recorderState !== 'dictation-recording') return
    setRecorderState('processing')
    try {
      const recording = await recordingResult()
      if (!recording) return
      const text = await onTranscribeVoice(recording)
      const nextDraft = [draft.trim(), text].filter(Boolean).join(draft.trim() ? ' ' : '')
      onDraftChange(nextDraft)
      setVoiceMetadata({ originalText: text, detectedLanguage: 'Unknown', audioAvailable: true })
    } catch (transcriptionError) {
      setError(transcriptionError instanceof Error ? transcriptionError.message : 'Could not convert this recording to text.')
    } finally {
      setRecorderState('idle')
    }
  }

  const submit = () => {
    if (recorderState !== 'idle') return
    const trimmed = draft.trim()
    if (!trimmed) return
    onSend(trimmed, voiceMetadata?.originalText
      ? {
          ...voiceMetadata,
          correctedText: trimmed !== voiceMetadata.originalText ? trimmed : undefined,
        }
      : undefined)
    onDraftChange('')
    setVoiceMetadata(undefined)
  }

  const handleTextChange = (value: string) => {
    onDraftChange(value)
    if (voiceMetadata) {
      setVoiceMetadata(previous => previous
        ? {
            ...previous,
            correctedText: value.trim() && value.trim() !== previous.originalText
              ? value.trim()
              : undefined,
          }
        : previous)
    }
  }

  const beginVoiceMessage = (event: PointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    void startRecording('message')
  }

  const releaseVoiceMessage = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    void finishVoiceMessage()
  }

  const dictating = recorderState === 'starting' && currentModeRef.current === 'dictation'
    || recorderState === 'dictation-recording'
    || recorderState === 'processing'

  if (voiceMessageMode) {
    const holding = recorderState === 'message-recording' || recorderState === 'starting'
    return (
      <div className="input-box voice-message-input-box">
        <div className="input-compose-row voice-message-compose-row">
          <button
            type="button"
            className="composer-mode-button"
            onClick={() => {
              if (recorderState !== 'idle') return
              setVoiceMessageMode(false)
            }}
            disabled={recorderState !== 'idle'}
            aria-label="Switch to text input"
            title="Switch to text input"
          >
            <KeyboardIcon />
          </button>
          <button
            type="button"
            className={`hold-to-talk${holding ? ' recording' : ''}`}
            onPointerDown={beginVoiceMessage}
            onPointerUp={releaseVoiceMessage}
            onPointerCancel={cancelRecording}
            onContextMenu={event => event.preventDefault()}
            disabled={recorderState === 'sending' || recorderState === 'processing'}
            aria-label={holding ? 'Release to send voice message' : 'Hold to talk'}
          >
            {holding ? <RecordingWaveform level={level} active /> : 'Hold to Talk'}
          </button>
        </div>
        {error && <div className="voice-status voice-status-error" role="alert">{error}</div>}
      </div>
    )
  }

  return (
    <div className="input-box">
      {dictating ? (
        <div className="input-compose-row dictation-compose-row">
          <button type="button" className="composer-mode-button" disabled aria-label="Voice message mode is unavailable while transcribing">
            <WeChatVoiceWave color="currentColor" size={22} />
          </button>
          <div className="cloud-dictation-bar" aria-label={recorderState === 'processing' ? 'Converting speech to text' : 'Recording for cloud transcription'}>
            <RecordingWaveform level={level} active={recorderState === 'dictation-recording'} />
          </div>
          <button type="button" className="dictation-command" onClick={cancelRecording} aria-label="Cancel voice transcription" title="Cancel">
            <CloseIcon />
          </button>
          <button
            type="button"
            className="dictation-command dictation-confirm"
            onClick={() => void finishDictation()}
            disabled={recorderState !== 'dictation-recording'}
            aria-label="Convert recording to text"
            title="Convert to text"
          >
            <CheckIcon />
          </button>
        </div>
      ) : (
        <div className="input-compose-row">
          <button
            type="button"
            className="composer-mode-button"
            onClick={() => setVoiceMessageMode(true)}
            aria-label="Switch to voice message"
            title="Switch to voice message"
          >
            <WeChatVoiceWave color="currentColor" size={22} />
          </button>
          <textarea
            value={draft}
            onChange={event => handleTextChange(event.target.value)}
            onCompositionStart={() => { isComposing.current = true }}
            onCompositionEnd={() => { isComposing.current = false }}
            onKeyDown={event => {
              if (event.key !== 'Enter' || event.shiftKey || isComposing.current || event.nativeEvent.isComposing) return
              event.preventDefault()
              submit()
            }}
            aria-label="Message"
            placeholder="Type your message..."
          />
          <div className="input-actions">
            <button
              type="button"
              className="voice-button"
              onClick={() => void startRecording('dictation')}
              aria-label="Start cloud voice transcription"
              title="Voice to text"
            >
              <MicrophoneIcon />
            </button>
            <button type="button" className="send" onClick={submit} disabled={!draft.trim()}>Send</button>
          </div>
        </div>
      )}
      {error && <div className="voice-status voice-status-error" role="alert">{error}</div>}
    </div>
  )
}
