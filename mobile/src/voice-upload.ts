import { File } from 'expo-file-system'

export type PreparedVoiceUpload = {
  fileUri: string
  byteLength: number
}

export const createVoiceRequestId = (kind: 'dictation' | 'voice-message') => (
  `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

export const prepareVoiceUpload = async (
  file: File
): Promise<PreparedVoiceUpload> => {
  const byteLength = file.size
  if (byteLength === 0) {
    throw new Error('The recording was empty. Please try again.')
  }

  // iOS 16's RN Blob bridge does not support ArrayBuffer construction. The native
  // file uploader accepts the URI directly and sends the file as a raw request body.
  return {
    fileUri: file.uri,
    byteLength,
  }
}

export const logVoiceDiagnostic = (
  event: string,
  details: Record<string, string | number | boolean | undefined>
) => {
  console.info('[voice]', event, details)
}
