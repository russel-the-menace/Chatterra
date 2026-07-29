import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

import { DetectedLanguage, VoiceTranscriptMetadata } from './types'

export type VoiceInputStatus = 'idle' | 'recording' | 'processing' | 'error'

type VoiceInputOptions = {
  language?: string
  onTranscriptChange?: (text: string, metadata: VoiceTranscriptMetadata) => void
}

type VoiceSnapshot = {
  status: VoiceInputStatus
  error?: string
}

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

const recognitionLanguageHint = (preferredLanguage?: string) => {
  const preferred = (preferredLanguage || '').toLowerCase()
  if (/cantonese|粤语|粵語|廣東話|广东话/u.test(preferred)) return 'zh-HK'
  if (/mandarin|普通话|普通話|国语|國語/u.test(preferred)) return 'zh-CN'
  if (/japanese|日本語|日语|日語/u.test(preferred)) return 'ja-JP'
  if (/korean|한국|韩语|韓語/u.test(preferred)) return 'ko-KR'
  if (/arabic|阿拉伯/u.test(preferred)) return 'ar-SA'
  if (/russian|俄语|俄語/u.test(preferred)) return 'ru-RU'
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

const voiceErrorMessage = (event: ExpoSpeechRecognitionErrorEvent) => {
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

export const useVoiceInput = ({ language, onTranscriptChange }: VoiceInputOptions = {}) => {
  const [snapshot, setSnapshot] = useState<VoiceSnapshot>(initialSnapshot)
  const mountedRef = useRef(true)
  const statusRef = useRef<VoiceInputStatus>('idle')
  const sessionRef = useRef(0)
  const abortingRef = useRef(false)
  const prefixRef = useRef('')
  const spokenRef = useRef('')
  const onTranscriptChangeRef = useRef(onTranscriptChange)

  useEffect(() => {
    onTranscriptChangeRef.current = onTranscriptChange
  }, [onTranscriptChange])

  const updateSnapshot = useCallback((next: VoiceSnapshot) => {
    statusRef.current = next.status
    if (mountedRef.current) setSnapshot(next)
  }, [])

  const emitTranscript = useCallback((result: ExpoSpeechRecognitionResultEvent['results'][number]) => {
    const spoken = result.transcript.trim()
    if (!spoken) return
    spokenRef.current = spoken
    const text = combineDraft(prefixRef.current, spoken)
    const metadata: VoiceTranscriptMetadata = {
      originalText: spoken,
      detectedLanguage: detectTranscriptLanguage(spoken || text),
      confidence: result.confidence > 0 ? Number(result.confidence.toFixed(3)) : undefined,
      audioAvailable: false,
    }
    onTranscriptChangeRef.current?.(text, metadata)
  }, [])

  const handleResult = useCallback((event: ExpoSpeechRecognitionResultEvent) => {
    const result = event.results[0]
    if (result) emitTranscript(result)
  }, [emitTranscript])

  useSpeechRecognitionEvent('result', handleResult)
  useSpeechRecognitionEvent('start', () => {
    updateSnapshot({ status: 'recording' })
  })
  useSpeechRecognitionEvent('end', () => {
    if (abortingRef.current || statusRef.current === 'error') return
    updateSnapshot({ status: 'idle' })
  })
  useSpeechRecognitionEvent('nomatch', () => {
    if (spokenRef.current || abortingRef.current) return
    updateSnapshot({ status: 'error', error: 'No speech was detected.' })
  })
  useSpeechRecognitionEvent('error', event => {
    if (event.error === 'aborted' && abortingRef.current) return
    updateSnapshot({ status: 'error', error: voiceErrorMessage(event) })
  })

  const start = useCallback(async (initialText = '') => {
    if (statusRef.current === 'recording' || statusRef.current === 'processing') return

    const session = sessionRef.current + 1
    sessionRef.current = session
    abortingRef.current = false
    prefixRef.current = initialText.trim()
    spokenRef.current = ''
    updateSnapshot({ status: 'processing' })

    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
        updateSnapshot({ status: 'error', error: 'Speech recognition is unavailable on this device.' })
        return
      }
      const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync()
      if (sessionRef.current !== session || !mountedRef.current) return
      if (!permission.granted) {
        updateSnapshot({ status: 'error', error: 'Microphone or speech recognition permission was denied.' })
        return
      }
      ExpoSpeechRecognitionModule.start({
        lang: recognitionLanguageHint(language),
        interimResults: true,
        continuous: Platform.OS === 'ios',
        maxAlternatives: 1,
        addsPunctuation: true,
        iosTaskHint: 'dictation',
      })
    } catch {
      updateSnapshot({ status: 'error', error: 'Voice input could not be started.' })
    }
  }, [language, updateSnapshot])

  const stop = useCallback(() => {
    if (statusRef.current !== 'recording') return
    updateSnapshot({ status: 'processing' })
    try {
      ExpoSpeechRecognitionModule.stop()
    } catch {
      updateSnapshot({ status: 'error', error: 'Voice input could not be stopped.' })
    }
  }, [updateSnapshot])

  const reset = useCallback(() => {
    sessionRef.current += 1
    abortingRef.current = true
    try {
      ExpoSpeechRecognitionModule.abort()
    } catch {
      // The native recognition session may already be closed.
    }
    prefixRef.current = ''
    spokenRef.current = ''
    updateSnapshot(initialSnapshot)
  }, [updateSnapshot])

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
      abortingRef.current = true
      try {
        ExpoSpeechRecognitionModule.abort()
      } catch {
        // The native recognition session may already be closed.
      }
    }
  }, [])

  return {
    ...snapshot,
    start,
    stop,
    toggle,
    reset,
  }
}
