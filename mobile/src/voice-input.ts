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
import { DetectedLanguage, VoiceTranscriptMetadata } from './types'
import { requestGroqTranscriptionConsent } from './voice-transcription-consent'

export type VoiceInputStatus = 'idle' | 'recording' | 'processing' | 'error'

type VoiceInputOptions = {
  userId?: string
  onTranscriptChange?: (text: string, metadata: VoiceTranscriptMetadata) => void
}

type VoiceSnapshot = {
  status: VoiceInputStatus
  error?: string
}

const MAX_RECORDING_DURATION_MS = 30_000
const initialSnapshot: VoiceSnapshot = { status: 'idle' }

const combineDraft = (prefix: string, spoken: string) => {
  if (!prefix) return spoken.trim()
  if (!spoken.trim()) return prefix.trim()
  return `${prefix.trim()} ${spoken.trim()}`
}

const countMatches = (text: string, pattern: RegExp) => (text.match(pattern) || []).length
const CANTONESE_MARKERS = /(?:係|唔|喺|冇|咩|而家|嘅|啦|喎|囉|呀|吖|喇|啫|㗎|嗰|乜|哋|佢|啲|點|邊|緊|嚟|揾|睇|食|飲|傾|講|咁|得閒|係咪|做咩)/gu

const detectTranscriptLanguage = (text: string): DetectedLanguage => {
  const normalized = text.trim()
  if (!normalized) return 'Unknown'

  const latin = countMatches(normalized, /[A-Za-z]/g)
  const han = countMatches(normalized, /[\u3400-\u9fff\uf900-\ufaff]/g)
  const kana = countMatches(normalized, /[\u3040-\u30ff]/g)
  const hangul = countMatches(normalized, /[\uac00-\ud7af]/g)
  const arabic = countMatches(normalized, /[\u0600-\u06ff]/g)
  const cyrillic = countMatches(normalized, /[\u0400-\u04ff]/g)
  const cantonese = countMatches(normalized, CANTONESE_MARKERS)

  if (kana > 0) return latin > 1 ? 'Mixed' : 'Japanese'
  if (hangul > 1) return latin > 1 ? 'Mixed' : 'Korean'
  if (arabic > 1) return latin > 1 ? 'Mixed' : 'Arabic'
  if (cyrillic > 1) return latin > 1 ? 'Mixed' : 'Russian'
  if (han > 1 && cantonese > 0) return latin > 1 ? 'Mixed' : 'Cantonese'
  if (han > 1) return latin > 1 ? 'Mixed' : 'Chinese'
  if (latin > 1) return 'English'
  return 'Unknown'
}

const recordingMimeType = () => {
  if (Platform.OS === 'web') return 'audio/webm'
  if (Platform.OS === 'android') return 'audio/3gpp'
  return 'audio/mp4'
}

const voiceErrorMessage = (error: unknown) => {
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : 'Voice input could not be completed.'
}

export const useVoiceInput = ({ userId, onTranscriptChange }: VoiceInputOptions = {}) => {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(initialSnapshot)
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY)
  const mountedRef = useRef(true)
  const statusRef = useRef<VoiceInputStatus>('idle')
  const sessionRef = useRef(0)
  const prefixRef = useRef('')
  const onTranscriptChangeRef = useRef(onTranscriptChange)
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    onTranscriptChangeRef.current = onTranscriptChange
  }, [onTranscriptChange])

  const updateSnapshot = useCallback((next: VoiceSnapshot) => {
    statusRef.current = next.status
    if (mountedRef.current) setSnapshot(next)
  }, [])

  const clearRecordingTimer = useCallback(() => {
    if (!recordingTimerRef.current) return
    clearTimeout(recordingTimerRef.current)
    recordingTimerRef.current = undefined
  }, [])

  const resetAudioMode = useCallback(() => {
    void setAudioModeAsync({ allowsRecording: false }).catch(() => undefined)
  }, [])

  const finishRecording = useCallback(async (session: number) => {
    if (session !== sessionRef.current || statusRef.current !== 'recording') return
    clearRecordingTimer()
    updateSnapshot({ status: 'processing' })
    let recording: File | undefined
    try {
      await recorder.stop()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (!recorder.uri) throw new Error('The recording could not be read.')

      recording = new File(recorder.uri)
      const transcription = await api.transcribeVoice({
        userId: userId || '',
        audio: recording,
        mimeType: recordingMimeType(),
      })
      if (session !== sessionRef.current || !mountedRef.current) return
      const spoken = transcription.text.trim()
      if (!spoken) throw new Error('No speech was detected.')
      onTranscriptChangeRef.current?.(combineDraft(prefixRef.current, spoken), {
        originalText: spoken,
        detectedLanguage: detectTranscriptLanguage(spoken),
        audioAvailable: false,
      })
      updateSnapshot(initialSnapshot)
    } catch (error) {
      if (session === sessionRef.current && mountedRef.current) {
        updateSnapshot({ status: 'error', error: voiceErrorMessage(error) })
      }
    } finally {
      try {
        recording?.delete()
      } catch {
        // The recorder cache may already have been removed by the operating system.
      }
      resetAudioMode()
    }
  }, [clearRecordingTimer, recorder, resetAudioMode, updateSnapshot, userId])

  const start = useCallback(async (initialText = '') => {
    if (statusRef.current === 'recording' || statusRef.current === 'processing') return
    if (!userId) {
      updateSnapshot({ status: 'error', error: 'Voice input needs an active user session.' })
      return
    }

    const session = sessionRef.current + 1
    sessionRef.current = session
    prefixRef.current = initialText.trim()
    updateSnapshot({ status: 'processing' })

    const hasConsent = await requestGroqTranscriptionConsent()
    if (session !== sessionRef.current || !mountedRef.current) return
    if (!hasConsent) {
      updateSnapshot(initialSnapshot)
      return
    }

    try {
      const permission = await requestRecordingPermissionsAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (!permission.granted) {
        updateSnapshot({ status: 'error', error: 'Microphone permission was denied.' })
        return
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      recorder.record()
      recordingTimerRef.current = setTimeout(
        () => void finishRecording(session),
        MAX_RECORDING_DURATION_MS
      )
      updateSnapshot({ status: 'recording' })
    } catch (error) {
      if (session === sessionRef.current && mountedRef.current) {
        updateSnapshot({ status: 'error', error: voiceErrorMessage(error) })
      }
      resetAudioMode()
    }
  }, [finishRecording, recorder, resetAudioMode, updateSnapshot, userId])

  const stop = useCallback(() => {
    if (statusRef.current !== 'recording') return
    void finishRecording(sessionRef.current)
  }, [finishRecording])

  const reset = useCallback(() => {
    sessionRef.current += 1
    clearRecordingTimer()
    if (statusRef.current === 'recording') {
      void recorder.stop().catch(() => undefined)
    }
    prefixRef.current = ''
    updateSnapshot(initialSnapshot)
    resetAudioMode()
  }, [clearRecordingTimer, recorder, resetAudioMode, updateSnapshot])

  const toggle = useCallback((initialText = '') => {
    if (statusRef.current === 'recording') {
      stop()
      return
    }
    void start(initialText)
  }, [start, stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionRef.current += 1
      clearRecordingTimer()
      if (statusRef.current === 'recording') {
        void recorder.stop().catch(() => undefined)
      }
      resetAudioMode()
    }
  }, [clearRecordingTimer, recorder, resetAudioMode])

  return {
    ...snapshot,
    start,
    stop,
    toggle,
    reset,
  }
}
