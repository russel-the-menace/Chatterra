import { File } from 'expo-file-system'

export type PreparedVoiceUpload = {
  audio: Blob
  byteLength: number
}

export const createVoiceRequestId = (kind: 'dictation' | 'voice-message') => (
  `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

export const prepareVoiceUpload = async (
  file: File,
  mimeType: string
): Promise<PreparedVoiceUpload> => {
  const bytes = await file.bytes()
  if (bytes.byteLength === 0) {
    throw new Error('The recording was empty. Please try again.')
  }

  // RN's fetch bridge can serialize expo-file-system File instances as an empty body.
  // Materializing the native file into a standard Blob keeps the byte count explicit.
  return {
    audio: new Blob([bytes], { type: mimeType }),
    byteLength: bytes.byteLength,
  }
}

export const logVoiceDiagnostic = (
  event: string,
  details: Record<string, string | number | boolean | undefined>
) => {
  console.info('[voice]', event, details)
}
