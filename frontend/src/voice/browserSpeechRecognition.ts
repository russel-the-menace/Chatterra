import {
  SpeechRecognitionConstructor,
  SpeechRecognitionErrorEventLike,
  SpeechRecognitionEventLike,
  SpeechRecognitionLike
} from './types'

type BrowserSpeechRecognitionCallbacks = {
  onStart: () => void
  onResult: (event: SpeechRecognitionEventLike) => void
  onError: (event: SpeechRecognitionErrorEventLike) => void
  onEnd: () => void
}

const recognitionConstructor = (): SpeechRecognitionConstructor | undefined => {
  if (typeof window === 'undefined') return undefined
  const browserWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return browserWindow.SpeechRecognition || browserWindow.webkitSpeechRecognition
}

export const browserSpeechRecognitionSupported = () => Boolean(recognitionConstructor())

export class BrowserSpeechRecognitionService {
  private recognition: SpeechRecognitionLike

  constructor(languageHint: string, callbacks: BrowserSpeechRecognitionCallbacks) {
    const Constructor = recognitionConstructor()
    if (!Constructor) throw new Error('Speech recognition is not supported in this browser.')

    this.recognition = new Constructor()
    this.recognition.continuous = true
    this.recognition.interimResults = true
    this.recognition.maxAlternatives = 1
    this.recognition.lang = languageHint
    this.recognition.onstart = callbacks.onStart
    this.recognition.onresult = callbacks.onResult
    this.recognition.onerror = callbacks.onError
    this.recognition.onend = callbacks.onEnd
  }

  start() {
    this.recognition.start()
  }

  stop() {
    this.recognition.stop()
  }

  abort() {
    this.recognition.abort()
  }
}
