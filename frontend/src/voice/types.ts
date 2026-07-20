export type VoiceInputStatus = 'idle' | 'recording' | 'processing' | 'error'

export type VoiceErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'microphone-unavailable'
  | 'recognition-unavailable'
  | 'recognition-failed'
  | 'no-speech'

export type DetectedLanguage =
  | 'English'
  | 'Cantonese'
  | 'Chinese'
  | 'Japanese'
  | 'Korean'
  | 'Arabic'
  | 'Russian'
  | 'Mixed'
  | 'Unknown'

export interface VoiceTranscriptMetadata {
  originalText: string
  correctedText?: string
  detectedLanguage: DetectedLanguage
  confidence?: number
  audioAvailable?: boolean
  audioBlob?: Blob
}

export interface SpeechRecognitionAlternativeLike {
  transcript: string
  confidence?: number
}

export interface SpeechRecognitionResultLike {
  isFinal: boolean
  length: number
  [index: number]: SpeechRecognitionAlternativeLike
}

export interface SpeechRecognitionEventLike extends Event {
  resultIndex: number
  results: {
    length: number
    [index: number]: SpeechRecognitionResultLike
  }
}

export interface SpeechRecognitionErrorEventLike extends Event {
  error: string
  message?: string
}

export interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  lang: string
  onstart: (() => void) | null
  onend: (() => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export interface VoiceInputSnapshot {
  status: VoiceInputStatus
  transcript: string
  metadata?: VoiceTranscriptMetadata
  error?: string
  errorCode?: VoiceErrorCode
  audioBlob?: Blob
}
