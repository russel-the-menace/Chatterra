export class AudioCaptureError extends Error {
  code: 'permission-denied' | 'microphone-unavailable'

  constructor(code: 'permission-denied' | 'microphone-unavailable', message: string) {
    super(message)
    this.name = 'AudioCaptureError'
    this.code = code
  }
}

export class AudioCapture {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []

  get isAvailable() {
    return typeof navigator !== 'undefined'
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof MediaRecorder !== 'undefined'
  }

  async start() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new AudioCaptureError('microphone-unavailable', 'Microphone capture is unavailable in this browser.')
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error: any) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError'
      throw new AudioCaptureError(
        denied ? 'permission-denied' : 'microphone-unavailable',
        denied
          ? 'Microphone permission was denied.'
          : 'The microphone could not be opened.'
      )
    }

    if (typeof MediaRecorder === 'undefined') return

    const mimeType = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4'
    ].find(type => MediaRecorder.isTypeSupported(type))

    try {
      this.chunks = []
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
      this.recorder.ondataavailable = event => {
        if (event.data.size > 0) this.chunks.push(event.data)
      }
      this.recorder.start()
    } catch {
      this.recorder = null
    }
  }

  stop(): Promise<Blob | undefined> {
    const recorder = this.recorder
    const stream = this.stream

    const finish = () => {
      stream?.getTracks().forEach(track => track.stop())
      this.stream = null
      this.recorder = null
      if (this.chunks.length === 0) return undefined
      const type = recorder?.mimeType || 'audio/webm'
      const blob = new Blob(this.chunks, { type })
      this.chunks = []
      return blob
    }

    if (!recorder || recorder.state === 'inactive') {
      return Promise.resolve(finish())
    }

    return new Promise(resolve => {
      recorder.addEventListener('stop', () => resolve(finish()), { once: true })
      recorder.stop()
    })
  }

  abort() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.recorder = null
    this.chunks = []
  }
}
