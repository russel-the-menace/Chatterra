import { useCallback, useEffect, useRef, useState } from 'react'
import { AudioCapture, AudioCaptureError } from './audioCapture'
import {
  BrowserSpeechRecognitionService,
  browserSpeechRecognitionSupported
} from './browserSpeechRecognition'
import { detectTranscriptLanguage, recognitionLanguageHint } from './language'
import {
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionEventLike,
  VoiceErrorCode,
  VoiceInputSnapshot,
  VoiceInputStatus,
  VoiceTranscriptMetadata
} from './types'

type VoiceInputOptions = {
  language?: string
  onTranscriptChange?: (text: string, metadata: VoiceTranscriptMetadata) => void
}

const initialSnapshot: VoiceInputSnapshot = {
  status: 'idle',
  transcript: ''
}

const combineDraft = (prefix: string, spoken: string) => {
  if (!prefix) return spoken.trim()
  if (!spoken.trim()) return prefix.trim()
  return `${prefix.trim()} ${spoken.trim()}`
}

const recognitionError = (event: SpeechRecognitionErrorEventLike): {
  code: VoiceErrorCode
  message: string
} => {
  if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
    return { code: 'permission-denied', message: 'Microphone permission was denied.' }
  }
  if (event.error === 'audio-capture') {
    return { code: 'microphone-unavailable', message: 'No working microphone is available.' }
  }
  if (event.error === 'network') {
    return { code: 'recognition-unavailable', message: 'Speech recognition is temporarily unavailable.' }
  }
  if (event.error === 'language-not-supported') {
    return { code: 'recognition-unavailable', message: 'This browser does not support the selected speech language.' }
  }
  if (event.error === 'no-speech') {
    return { code: 'no-speech', message: 'No speech was detected.' }
  }
  return { code: 'recognition-failed', message: 'Speech recognition stopped unexpectedly.' }
}

export const useVoiceInput = ({ language, onTranscriptChange }: VoiceInputOptions = {}) => {
  const [snapshot, setSnapshot] = useState<VoiceInputSnapshot>(initialSnapshot)
  const mountedRef = useRef(true)
  const statusRef = useRef<VoiceInputStatus>('idle')
  const sessionRef = useRef(0)
  const serviceRef = useRef<BrowserSpeechRecognitionService | null>(null)
  const audioRef = useRef<AudioCapture | null>(null)
  const prefixRef = useRef('')
  const spokenRef = useRef('')
  const confidenceRef = useRef<number[]>([])
  const shouldRestartRef = useRef(false)
  const stoppingRef = useRef(false)
  const failedRef = useRef(false)
  const recognitionEndResolverRef = useRef<(() => void) | null>(null)
  const onTranscriptChangeRef = useRef(onTranscriptChange)

  useEffect(() => {
    onTranscriptChangeRef.current = onTranscriptChange
  }, [onTranscriptChange])

  const updateStatus = useCallback((status: VoiceInputStatus) => {
    statusRef.current = status
    if (mountedRef.current) setSnapshot(previous => ({ ...previous, status }))
  }, [])

  const emitTranscript = useCallback((audioAvailable = false, notify = true) => {
    const spoken = spokenRef.current.trim()
    const text = combineDraft(prefixRef.current, spoken)
    const confidenceValues = confidenceRef.current
    const confidence = confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : undefined
    const metadata: VoiceTranscriptMetadata = {
      originalText: spoken,
      detectedLanguage: detectTranscriptLanguage(spoken || text),
      confidence: confidence == null ? undefined : Number(confidence.toFixed(3)),
      audioAvailable
    }
    if (mountedRef.current) {
      setSnapshot(previous => ({ ...previous, transcript: text, metadata }))
    }
    if (notify) onTranscriptChangeRef.current?.(text, metadata)
    return { text, metadata }
  }, [])

  const handleResult = useCallback((event: SpeechRecognitionEventLike) => {
    const finalParts: string[] = []
    const interimParts: string[] = []
    const confidence: number[] = []

    for (let index = 0; index < event.results.length; index += 1) {
      const result = event.results[index]
      const alternative = result?.[0]
      if (!alternative?.transcript) continue
      if (result.isFinal) {
        finalParts.push(alternative.transcript)
        if (typeof alternative.confidence === 'number' && alternative.confidence > 0) {
          confidence.push(alternative.confidence)
        }
      } else {
        interimParts.push(alternative.transcript)
      }
    }

    spokenRef.current = [...finalParts, ...interimParts].join(' ').replace(/\s+/g, ' ').trim()
    confidenceRef.current = confidence
    emitTranscript(Boolean(audioRef.current?.isAvailable))
  }, [emitTranscript])

  const setError = useCallback((code: VoiceErrorCode, message: string) => {
    statusRef.current = 'error'
    if (mountedRef.current) {
      setSnapshot(previous => ({ ...previous, status: 'error', errorCode: code, error: message }))
    }
  }, [])

  const stop = useCallback(async () => {
    if (statusRef.current !== 'recording') return
    shouldRestartRef.current = false
    stoppingRef.current = true
    updateStatus('processing')

    const recognitionEnded = new Promise<void>(resolve => {
      recognitionEndResolverRef.current = resolve
    })
    try {
      serviceRef.current?.stop()
    } catch {
      recognitionEndResolverRef.current?.()
    }

    const audioBlobPromise = audioRef.current?.stop() || Promise.resolve(undefined)
    const recognitionTimeout = new Promise<void>(resolve => window.setTimeout(resolve, 1200))
    const [, audioBlob] = await Promise.all([
      Promise.race([recognitionEnded, recognitionTimeout]),
      audioBlobPromise
    ])

    if (!mountedRef.current || failedRef.current) return
    const { text, metadata } = emitTranscript(Boolean(audioBlob), false)
    const finalMetadata: VoiceTranscriptMetadata = {
      ...metadata,
      audioAvailable: Boolean(audioBlob),
      audioBlob
    }
    onTranscriptChangeRef.current?.(text, finalMetadata)
    statusRef.current = 'idle'
    setSnapshot(previous => ({
      ...previous,
      status: 'idle',
      metadata: finalMetadata,
      audioBlob,
      error: undefined,
      errorCode: undefined
    }))
    serviceRef.current = null
    audioRef.current = null
    stoppingRef.current = false
    recognitionEndResolverRef.current = null
  }, [emitTranscript, updateStatus])

  const start = useCallback(async (initialText = '') => {
    if (statusRef.current === 'recording' || statusRef.current === 'processing') return
    if (!browserSpeechRecognitionSupported()) {
      setError('unsupported', 'Voice input is not supported in this browser.')
      return
    }

    const sessionId = sessionRef.current + 1
    sessionRef.current = sessionId
    prefixRef.current = initialText.trim()
    spokenRef.current = ''
    confidenceRef.current = []
    shouldRestartRef.current = true
    stoppingRef.current = false
    failedRef.current = false
    updateStatus('processing')
    setSnapshot(previous => ({
      ...previous,
      transcript: initialText,
      metadata: undefined,
      audioBlob: undefined,
      error: undefined,
      errorCode: undefined
    }))

    const audio = new AudioCapture()
    audioRef.current = audio

    const handleError = (event: SpeechRecognitionErrorEventLike) => {
      if (event.error === 'aborted' && stoppingRef.current) return
      failedRef.current = true
      shouldRestartRef.current = false
      stoppingRef.current = true
      const failure = recognitionError(event)
      void audioRef.current?.stop()
      recognitionEndResolverRef.current?.()
      setError(failure.code, failure.message)
    }

    let service: BrowserSpeechRecognitionService
    try {
      service = new BrowserSpeechRecognitionService(recognitionLanguageHint(language), {
        onStart: () => updateStatus('recording'),
        onResult: handleResult,
        onError: handleError,
        onEnd: () => {
          recognitionEndResolverRef.current?.()
          if (!shouldRestartRef.current || stoppingRef.current || failedRef.current) return
          window.setTimeout(() => {
            if (!shouldRestartRef.current || sessionRef.current !== sessionId) return
            try {
              service.start()
            } catch {
              failedRef.current = true
              setError('recognition-failed', 'Speech recognition could not be restarted.')
              void audioRef.current?.stop()
            }
          }, 80)
        }
      })
    } catch {
      shouldRestartRef.current = false
      stoppingRef.current = true
      setError('recognition-unavailable', 'Speech recognition is unavailable right now.')
      return
    }
    serviceRef.current = service

    try {
      const audioStart = audio.start()
      // Start recognition in the original click task; some browsers do not preserve
      // user activation across an awaited permission prompt.
      service.start()
      await audioStart
      if (sessionRef.current !== sessionId) {
        audio.abort()
        return
      }
    } catch (error) {
      shouldRestartRef.current = false
      stoppingRef.current = true
      audio.abort()
      serviceRef.current = null
      if (error instanceof AudioCaptureError) {
        setError(error.code, error.message)
      } else {
        setError('recognition-failed', 'Voice input could not be started.')
      }
    }
  }, [handleResult, language, setError, updateStatus])

  const reset = useCallback(() => {
    sessionRef.current += 1
    shouldRestartRef.current = false
    stoppingRef.current = true
    failedRef.current = false
    try {
      serviceRef.current?.abort()
    } catch {
      // The recognition session may already be closed.
    }
    audioRef.current?.abort()
    serviceRef.current = null
    audioRef.current = null
    prefixRef.current = ''
    spokenRef.current = ''
    confidenceRef.current = []
    statusRef.current = 'idle'
    if (mountedRef.current) setSnapshot(initialSnapshot)
  }, [])

  const toggle = useCallback((initialText = '') => {
    if (statusRef.current === 'recording') {
      void stop()
      return
    }
    void start(initialText)
  }, [start, stop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      shouldRestartRef.current = false
      try {
        serviceRef.current?.abort()
      } catch {
        // The recognition session may already be closed.
      }
      audioRef.current?.abort()
    }
  }, [])

  return {
    ...snapshot,
    supported: browserSpeechRecognitionSupported(),
    start,
    stop,
    toggle,
    reset
  }
}
