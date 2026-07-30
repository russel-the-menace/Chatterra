import { File } from 'expo-file-system'
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

import { api, ApiError } from './api'
import { DetectedLanguage, ServerMessage, VoiceTranscriptMetadata } from './types'
import { createVoiceRequestId, logVoiceDiagnostic, prepareVoiceUpload } from './voice-upload'
import { requestGroqTranscriptionConsent } from './voice-transcription-consent'
import { requestVoiceMessageConsent } from './voice-message-consent'

export type VoiceMessageAction = 'cancel' | 'convert' | 'send'
export type VoiceMessageRecorderStatus = 'idle' | 'recording' | 'processing' | 'error'

type VoiceMessageRecorderOptions = {
  characterId?: string
  conversationId?: string | null
  onConvertedToText?: (text: string, metadata: VoiceTranscriptMetadata) => void
  onSent?: (result: { conversationId: string; message: ServerMessage; starterMessage?: ServerMessage }) => void
  userId?: string
}

type Snapshot = {
  status: VoiceMessageRecorderStatus
  action: VoiceMessageAction
  error?: string
}

const MAX_RECORDING_DURATION_MS = 60_000
const MIN_RECORDING_DURATION_MS = 250
const ACTION_DRAG_DISTANCE = 72
const initialSnapshot: Snapshot = { status: 'idle', action: 'send' }

const recordingMimeType = () => {
  if (Platform.OS === 'web') return 'audio/webm'
  if (Platform.OS === 'android') return 'audio/3gpp'
  return 'audio/mp4'
}

const detectTranscriptLanguage = (text: string): DetectedLanguage => {
  const latin = (text.match(/[A-Za-z]/g) || []).length
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length
  const han = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  if (kana > 0) return latin > 1 ? 'Mixed' : 'Japanese'
  if (hangul > 1) return latin > 1 ? 'Mixed' : 'Korean'
  if (han > 1) return latin > 1 ? 'Mixed' : 'Chinese'
  return latin > 1 ? 'English' : 'Unknown'
}

const messageForError = (error: unknown) => {
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : 'Voice message could not be completed.'
}

export const useVoiceMessageRecorder = ({
  characterId,
  conversationId,
  onConvertedToText,
  onSent,
  userId,
}: VoiceMessageRecorderOptions = {}) => {
  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot)
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY)
  const mountedRef = useRef(true)
  const snapshotRef = useRef<Snapshot>(initialSnapshot)
  const sessionRef = useRef(0)
  const pressOriginXRef = useRef<number | undefined>(undefined)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const onConvertedToTextRef = useRef(onConvertedToText)
  const onSentRef = useRef(onSent)

  useEffect(() => {
    onConvertedToTextRef.current = onConvertedToText
  }, [onConvertedToText])

  useEffect(() => {
    onSentRef.current = onSent
  }, [onSent])

  const updateSnapshot = useCallback((next: Snapshot) => {
    snapshotRef.current = next
    if (mountedRef.current) setSnapshot(next)
  }, [])

  const clearTimer = useCallback(() => {
    if (!timerRef.current) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  const resetAudioMode = useCallback(() => {
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined)
  }, [])

  const finish = useCallback(async (requestedAction?: VoiceMessageAction) => {
    const current = snapshotRef.current
    if (current.status === 'processing') {
      sessionRef.current += 1
      updateSnapshot(initialSnapshot)
      return
    }
    if (current.status !== 'recording') return

    const session = sessionRef.current
    const action = requestedAction || current.action
    clearTimer()
    updateSnapshot({ status: 'processing', action })
    const durationMilliseconds = Math.max(
      0,
      Math.round(Math.max(recorder.currentTime * 1_000, Date.now() - startedAtRef.current))
    )
    let recording: File | undefined
    try {
      await recorder.stop()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (action === 'cancel') {
        updateSnapshot(initialSnapshot)
        return
      }
      if (durationMilliseconds < MIN_RECORDING_DURATION_MS) {
        throw new Error('Hold to talk for a little longer.')
      }
      if (!recorder.uri) throw new Error('The recording could not be read.')
      recording = new File(recorder.uri)
      const mimeType = recordingMimeType()
      const requestId = createVoiceRequestId('voice-message')
      const upload = await prepareVoiceUpload(recording, mimeType)
      logVoiceDiagnostic('voice_message_recording_ready', {
        requestId,
        action,
        fileBytes: recording.size,
        uploadBytes: upload.byteLength,
        mimeType,
        durationMilliseconds,
      })

      if (action === 'convert') {
        const hasConsent = await requestGroqTranscriptionConsent()
        if (session !== sessionRef.current || !mountedRef.current) return
        if (!hasConsent) {
          updateSnapshot(initialSnapshot)
          return
        }
        const transcription = await api.transcribeVoice({
          userId: userId || '',
          audio: upload.audio,
          mimeType,
          byteLength: upload.byteLength,
          requestId,
        })
        const text = transcription.text.trim()
        if (!text) throw new Error('No speech was detected.')
        onConvertedToTextRef.current?.(text, {
          originalText: text,
          detectedLanguage: detectTranscriptLanguage(text),
          audioAvailable: false,
        })
      } else {
        if (!userId || !characterId) throw new Error('Voice messages need an active conversation.')
        const result = await api.sendVoiceMessage({
          userId,
          characterId,
          conversationId: conversationId || undefined,
          audio: upload.audio,
          durationMilliseconds,
          mimeType,
          byteLength: upload.byteLength,
          requestId,
        })
        onSentRef.current?.({
          conversationId: result.conversation.id,
          message: result.message,
          starterMessage: result.starterMessage,
        })
      }
      if (session === sessionRef.current && mountedRef.current) updateSnapshot(initialSnapshot)
    } catch (error) {
      if (session === sessionRef.current && mountedRef.current) {
        updateSnapshot({ status: 'error', action: 'send', error: messageForError(error) })
      }
    } finally {
      try {
        recording?.delete()
      } catch {
        // The recorder cache may already have been removed by the operating system.
      }
      resetAudioMode()
    }
  }, [characterId, clearTimer, conversationId, recorder, resetAudioMode, updateSnapshot, userId])

  const start = useCallback(async (pageX?: number) => {
    if (snapshotRef.current.status === 'recording' || snapshotRef.current.status === 'processing') return
    const session = sessionRef.current + 1
    sessionRef.current = session
    pressOriginXRef.current = pageX
    updateSnapshot({ status: 'processing', action: 'send' })

    const hasConsent = await requestVoiceMessageConsent()
    if (session !== sessionRef.current || !mountedRef.current) return
    if (!hasConsent) {
      updateSnapshot(initialSnapshot)
      return
    }
    try {
      const permission = await requestRecordingPermissionsAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (!permission.granted) {
        updateSnapshot({ status: 'error', action: 'send', error: 'Microphone permission was denied.' })
        return
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      recorder.record()
      startedAtRef.current = Date.now()
      updateSnapshot({ status: 'recording', action: 'send' })
      timerRef.current = setTimeout(() => void finish('send'), MAX_RECORDING_DURATION_MS)
    } catch (error) {
      if (session === sessionRef.current && mountedRef.current) {
        updateSnapshot({ status: 'error', action: 'send', error: messageForError(error) })
      }
      resetAudioMode()
    }
  }, [finish, recorder, resetAudioMode, updateSnapshot])

  const updateActionForPosition = useCallback((pageX?: number) => {
    if (snapshotRef.current.status !== 'recording' || pageX === undefined || pressOriginXRef.current === undefined) return
    const delta = pageX - pressOriginXRef.current
    const action: VoiceMessageAction = delta <= -ACTION_DRAG_DISTANCE
      ? 'cancel'
      : delta >= ACTION_DRAG_DISTANCE
        ? 'convert'
        : 'send'
    if (snapshotRef.current.action !== action) {
      updateSnapshot({ status: 'recording', action })
    }
  }, [updateSnapshot])

  const reset = useCallback(() => {
    sessionRef.current += 1
    clearTimer()
    if (snapshotRef.current.status === 'recording') {
      void recorder.stop().catch(() => undefined)
    }
    updateSnapshot(initialSnapshot)
    resetAudioMode()
  }, [clearTimer, recorder, resetAudioMode, updateSnapshot])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionRef.current += 1
      clearTimer()
      if (snapshotRef.current.status === 'recording') {
        void recorder.stop().catch(() => undefined)
      }
      resetAudioMode()
    }
  }, [clearTimer, recorder, resetAudioMode])

  return {
    ...snapshot,
    finish,
    reset,
    start,
    updateActionForPosition,
  }
}
