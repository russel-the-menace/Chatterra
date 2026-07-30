import AsyncStorage from '@react-native-async-storage/async-storage'
import { Alert } from 'react-native'

const CONSENT_KEY = '@chatterra/groq-transcription-consent:v1'

export const requestGroqTranscriptionConsent = async () => {
  try {
    if (await AsyncStorage.getItem(CONSENT_KEY) === 'accepted') return true
  } catch {
    // The confirmation remains available even if local persistence is unavailable.
  }

  return new Promise<boolean>(resolve => {
    Alert.alert(
      'Voice transcription',
      'Your recording will be sent to Chatterra and Groq to create editable text. It is not saved as an audio message.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        {
          text: 'Continue',
          onPress: () => {
            void AsyncStorage.setItem(CONSENT_KEY, 'accepted').catch(() => undefined)
            resolve(true)
          },
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    )
  })
}
