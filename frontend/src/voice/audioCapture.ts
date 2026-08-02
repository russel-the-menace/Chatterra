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
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private levelAnimationFrame: number | null = null

  constructor(private readonly onLevel?: (level: number) => void) {}

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

    this.startLevelMeter()

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
      this.stopLevelMeter()
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
    this.stopLevelMeter()
    this.stream = null
    this.recorder = null
    this.chunks = []
  }

  private startLevelMeter() {
    if (!this.stream || !this.onLevel || typeof AudioContext === 'undefined') return
    try {
      this.audioContext = new AudioContext()
      const source = this.audioContext.createMediaStreamSource(this.stream)
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256
      source.connect(this.analyser)
      const samples = new Uint8Array(this.analyser.fftSize)
      const update = () => {
        if (!this.analyser || !this.onLevel) return
        this.analyser.getByteTimeDomainData(samples)
        const meanSquare = samples.reduce((sum, sample) => {
          const normalized = (sample - 128) / 128
          return sum + normalized * normalized
        }, 0) / samples.length
        this.onLevel(Math.min(1, Math.sqrt(meanSquare) * 5.5))
        this.levelAnimationFrame = window.requestAnimationFrame(update)
      }
      update()
    } catch {
      this.stopLevelMeter()
    }
  }

  private stopLevelMeter() {
    if (this.levelAnimationFrame !== null) {
      window.cancelAnimationFrame(this.levelAnimationFrame)
      this.levelAnimationFrame = null
    }
    this.analyser = null
    const context = this.audioContext
    this.audioContext = null
    if (context && context.state !== 'closed') void context.close()
    this.onLevel?.(0)
  }
}
