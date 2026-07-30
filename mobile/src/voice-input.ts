import { File } from 'expo-file-system'
import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio'
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

import { api, ApiError } from './api'
import { DetectedLanguage, VoiceTranscriptMetadata } from './types'
import { createVoiceRequestId, logVoiceDiagnostic, prepareVoiceUpload } from './voice-upload'
import { requestGroqTranscriptionConsent } from './voice-transcription-consent'

export type VoiceInputStatus = 'idle' | 'recording' | 'processing' | 'error'
export type VoiceInputMode = 'cloud' | 'local'

type VoiceInputOptions = {
  characterId?: string
  language?: string
  mode?: VoiceInputMode
  onCloudUnavailable?: () => void
  onTranscriptChange?: (text: string, metadata: VoiceTranscriptMetadata) => void
  userId?: string
}

type VoiceSnapshot = {
  status: VoiceInputStatus
  error?: string
}

const MAX_RECORDING_DURATION_MS = 30_000
const initialSnapshot: VoiceSnapshot = { status: 'idle' }
const cloudRecordingOptions = {
  ...RecordingPresets.LOW_QUALITY,
  isMeteringEnabled: true,
}

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

const recognitionLanguageHint = (preferredLanguage?: string) => {
  const preferred = (preferredLanguage || '').toLowerCase()
  if (/cantonese|粤语|粵語|廣東話|广东话/u.test(preferred)) return 'zh-HK'
  if (/mandarin|普通话|普通話|国语|國語/u.test(preferred)) return 'zh-CN'
  if (/japanese|日本語|日语|日語/u.test(preferred)) return 'ja-JP'
  if (/korean|한국|韩语|韓語/u.test(preferred)) return 'ko-KR'
  if (/arabic|阿拉伯/u.test(preferred)) return 'ar-SA'
  if (/russian|俄语|俄語/u.test(preferred)) return 'ru-RU'
  if (/spanish|español|espanol|西班牙语|西班牙語/u.test(preferred)) return 'es-AR'
  if (/english|英语|英語/u.test(preferred)) return 'en-US'

  const locale = typeof Intl === 'undefined'
    ? 'en-US'
    : Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
  if (/^zh/i.test(locale)) return locale.includes('-') ? locale : 'zh-CN'
  if (/^ja/i.test(locale)) return locale.includes('-') ? locale : 'ja-JP'
  if (/^ko/i.test(locale)) return locale.includes('-') ? locale : 'ko-KR'
  if (/^ar/i.test(locale)) return locale.includes('-') ? locale : 'ar-SA'
  if (/^ru/i.test(locale)) return locale.includes('-') ? locale : 'ru-RU'
  return locale
}

const recognitionLanguageCandidates = (preferredLanguage?: string) => {
  const primary = recognitionLanguageHint(preferredLanguage)
  if (primary === 'es-AR') return ['es-AR', 'es-ES', 'es-MX', 'es-US']
  return [primary]
}

const supportedRecognitionLanguage = async (preferredLanguage?: string) => {
  const candidates = recognitionLanguageCandidates(preferredLanguage)
  try {
    const supported = await ExpoSpeechRecognitionModule.getSupportedLocales({})
    const supportedByNormalizedLocale = new Map(
      supported.locales.map(locale => [locale.toLowerCase(), locale])
    )
    const exact = candidates.find(locale => supportedByNormalizedLocale.has(locale.toLowerCase()))
    if (exact) return supportedByNormalizedLocale.get(exact.toLowerCase()) || exact

    const language = candidates[0]?.split('-')[0]?.toLowerCase()
    const regionalFallback = supported.locales.find(locale => (
      locale.toLowerCase().startsWith(`${language}-`)
    ))
    if (regionalFallback) return regionalFallback
  } catch {
    // The platform may not expose its installed speech locales.
  }
  return candidates[0] || 'en-US'
}

const supportsContinuousRecognition = () => {
  if (Platform.OS !== 'ios') return false
  const version = Number.parseFloat(String(Platform.Version))
  return Number.isFinite(version) && version >= 17
}

const localVoiceErrorMessage = (event: ExpoSpeechRecognitionErrorEvent) => {
  switch (event.error) {
    case 'not-allowed':
      return 'Microphone or speech recognition permission was denied.'
    case 'audio-capture':
      return 'No working microphone is available.'
    case 'network':
    case 'service-not-allowed':
      return 'Speech recognition is unavailable right now.'
    case 'language-not-supported':
      return 'Speech recognition is unavailable for this language.'
    case 'no-speech':
    case 'speech-timeout':
      return 'No speech was detected.'
    case 'interrupted':
      return 'Speech recognition was interrupted.'
    default:
      return event.message || 'Voice input stopped unexpectedly.'
  }
}

const cloudVoiceErrorMessage = (error: unknown) => {
  if (error instanceof ApiError) return error.message
  return error instanceof Error ? error.message : 'Voice input could not be completed.'
}

export const useVoiceInput = ({
  characterId,
  language,
  mode = 'local',
  onCloudUnavailable,
  onTranscriptChange,
  userId,
}: VoiceInputOptions = {}) => {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(initialSnapshot)
  const recorder = useAudioRecorder(cloudRecordingOptions)
  const recorderState = useAudioRecorderState(recorder, 80)
  const mountedRef = useRef(true)
  const statusRef = useRef<VoiceInputStatus>('idle')
  const sessionRef = useRef(0)
  const activeModeRef = useRef<VoiceInputMode | null>(null)
  const abortingLocalRef = useRef(false)
  const prefixRef = useRef('')
  const spokenRef = useRef('')
  const onCloudUnavailableRef = useRef(onCloudUnavailable)
  const onTranscriptChangeRef = useRef(onTranscriptChange)
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    onTranscriptChangeRef.current = onTranscriptChange
  }, [onTranscriptChange])

  useEffect(() => {
    onCloudUnavailableRef.current = onCloudUnavailable
  }, [onCloudUnavailable])

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

  const emitLocalTranscript = useCallback((result: ExpoSpeechRecognitionResultEvent['results'][number]) => {
    const spoken = result.transcript.trim()
    if (!spoken) return
    spokenRef.current = spoken
    onTranscriptChangeRef.current?.(combineDraft(prefixRef.current, spoken), {
      originalText: spoken,
      detectedLanguage: detectTranscriptLanguage(spoken),
      confidence: result.confidence > 0 ? Number(result.confidence.toFixed(3)) : undefined,
      audioAvailable: false,
    })
  }, [])

  useSpeechRecognitionEvent('result', event => {
    if (activeModeRef.current !== 'local') return
    const result = event.results[0]
    if (result) emitLocalTranscript(result)
  })
  useSpeechRecognitionEvent('start', () => {
    if (activeModeRef.current === 'local') updateSnapshot({ status: 'recording' })
  })
  useSpeechRecognitionEvent('end', () => {
    if (activeModeRef.current !== 'local' || abortingLocalRef.current || statusRef.current === 'error') return
    activeModeRef.current = null
    updateSnapshot({ status: 'idle' })
  })
  useSpeechRecognitionEvent('nomatch', () => {
    if (activeModeRef.current !== 'local' || spokenRef.current || abortingLocalRef.current) return
    activeModeRef.current = null
    updateSnapshot({ status: 'error', error: 'No speech was detected.' })
  })
  useSpeechRecognitionEvent('error', event => {
    if (activeModeRef.current !== 'local') return
    if (event.error === 'aborted' && abortingLocalRef.current) return
    activeModeRef.current = null
    updateSnapshot({ status: 'error', error: localVoiceErrorMessage(event) })
  })

  const finishCloudRecording = useCallback(async (session: number) => {
    if (
      session !== sessionRef.current
      || statusRef.current !== 'recording'
      || activeModeRef.current !== 'cloud'
    ) return
    clearRecordingTimer()
    updateSnapshot({ status: 'processing' })
    let recording: File | undefined
    try {
      await recorder.stop()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (!recorder.uri) throw new Error('The recording could not be read.')

      recording = new File(recorder.uri)
      const requestId = createVoiceRequestId('dictation')
      const upload = await prepareVoiceUpload(recording)
      logVoiceDiagnostic('dictation_recording_ready', {
        requestId,
        fileBytes: recording.size,
        uploadBytes: upload.byteLength,
        mimeType: recordingMimeType(),
      })
      const transcription = await api.transcribeVoice({
        userId: userId || '',
        characterId,
        fileUri: upload.fileUri,
        mimeType: recordingMimeType(),
        byteLength: upload.byteLength,
        requestId,
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
      if (error instanceof ApiError) onCloudUnavailableRef.current?.()
      if (session === sessionRef.current && mountedRef.current) {
        updateSnapshot({ status: 'error', error: cloudVoiceErrorMessage(error) })
      }
    } finally {
      try {
        recording?.delete()
      } catch {
        // The recorder cache may already have been removed by the operating system.
      }
      if (session === sessionRef.current) activeModeRef.current = null
      resetAudioMode()
    }
  }, [characterId, clearRecordingTimer, recorder, resetAudioMode, updateSnapshot, userId])

  const startCloud = useCallback(async (initialText: string) => {
    if (!userId) {
      updateSnapshot({ status: 'error', error: 'Voice input needs an active user session.' })
      return
    }
    const session = sessionRef.current + 1
    sessionRef.current = session
    activeModeRef.current = 'cloud'
    prefixRef.current = initialText.trim()
    updateSnapshot({ status: 'processing' })

    const hasConsent = await requestGroqTranscriptionConsent()
    if (session !== sessionRef.current || !mountedRef.current) return
    if (!hasConsent) {
      activeModeRef.current = null
      updateSnapshot(initialSnapshot)
      return
    }

    try {
      const permission = await requestRecordingPermissionsAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (!permission.granted) {
        activeModeRef.current = null
        updateSnapshot({ status: 'error', error: 'Microphone permission was denied.' })
        return
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true })
      await recorder.prepareToRecordAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      recorder.record()
      recordingTimerRef.current = setTimeout(
        () => void finishCloudRecording(session),
        MAX_RECORDING_DURATION_MS
      )
      updateSnapshot({ status: 'recording' })
    } catch (error) {
      activeModeRef.current = null
      if (session === sessionRef.current && mountedRef.current) {
        updateSnapshot({ status: 'error', error: cloudVoiceErrorMessage(error) })
      }
      resetAudioMode()
    }
  }, [finishCloudRecording, recorder, resetAudioMode, updateSnapshot, userId])

  const startLocal = useCallback(async (initialText: string) => {
    const session = sessionRef.current + 1
    sessionRef.current = session
    activeModeRef.current = 'local'
    abortingLocalRef.current = false
    prefixRef.current = initialText.trim()
    spokenRef.current = ''
    updateSnapshot({ status: 'processing' })

    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        activeModeRef.current = null
        updateSnapshot({ status: 'error', error: 'Speech recognition is unavailable on this device.' })
        return
      }
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (session !== sessionRef.current || !mountedRef.current) return
      if (!permission.granted) {
        activeModeRef.current = null
        updateSnapshot({ status: 'error', error: 'Microphone or speech recognition permission was denied.' })
        return
      }
      const recognitionLanguage = await supportedRecognitionLanguage(language)
      if (session !== sessionRef.current || !mountedRef.current) return
      ExpoSpeechRecognitionModule.start({
        lang: recognitionLanguage,
        interimResults: true,
        continuous: supportsContinuousRecognition(),
        maxAlternatives: 1,
        addsPunctuation: true,
        iosTaskHint: 'dictation',
        iosCategory: Platform.OS === 'ios'
          ? { category: 'record', categoryOptions: [], mode: 'measurement' }
          : undefined,
      })
    } catch {
      activeModeRef.current = null
      updateSnapshot({ status: 'error', error: 'Voice input could not be started.' })
    }
  }, [language, updateSnapshot])

  const start = useCallback((initialText = '') => {
    if (statusRef.current === 'recording' || statusRef.current === 'processing') return
    if (mode === 'cloud') {
      void startCloud(initialText)
      return
    }
    void startLocal(initialText)
  }, [mode, startCloud, startLocal])

  const stop = useCallback(() => {
    if (statusRef.current !== 'recording') return
    if (activeModeRef.current === 'cloud') {
      void finishCloudRecording(sessionRef.current)
      return
    }
    if (activeModeRef.current === 'local') {
      updateSnapshot({ status: 'processing' })
      try {
        ExpoSpeechRecognitionModule.stop()
      } catch {
        activeModeRef.current = null
        updateSnapshot({ status: 'error', error: 'Voice input could not be stopped.' })
      }
    }
  }, [finishCloudRecording, updateSnapshot])

  const reset = useCallback(() => {
    sessionRef.current += 1
    clearRecordingTimer()
    if (activeModeRef.current === 'cloud' && statusRef.current === 'recording') {
      void recorder.stop().catch(() => undefined)
    }
    if (activeModeRef.current === 'local') {
      abortingLocalRef.current = true
      try {
        ExpoSpeechRecognitionModule.abort()
      } catch {
        // The native recognition session may already be closed.
      }
    }
    activeModeRef.current = null
    prefixRef.current = ''
    spokenRef.current = ''
    updateSnapshot(initialSnapshot)
    resetAudioMode()
  }, [clearRecordingTimer, recorder, resetAudioMode, updateSnapshot])

  const toggle = useCallback((initialText = '') => {
    if (statusRef.current === 'recording') {
      stop()
      return
    }
    start(initialText)
  }, [start, stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      sessionRef.current += 1
      clearRecordingTimer()
      if (activeModeRef.current === 'cloud' && statusRef.current === 'recording') {
        void recorder.stop().catch(() => undefined)
      }
      if (activeModeRef.current === 'local') {
        abortingLocalRef.current = true
        try {
          ExpoSpeechRecognitionModule.abort()
        } catch {
          // The native recognition session may already be closed.
        }
      }
      activeModeRef.current = null
      resetAudioMode()
    }
  }, [clearRecordingTimer, recorder, resetAudioMode])

  return {
    ...snapshot,
    metering: recorderState.metering,
    recordingDurationMilliseconds: recorderState.durationMillis,
    start,
    stop,
    toggle,
    reset,
  }
}
