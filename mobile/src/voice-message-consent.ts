import AsyncStorage from '@react-native-async-storage/async-storage'
import { Alert } from 'react-native'

const CONSENT_KEY = '@chatterra/voice-message-consent:v2'

export const requestVoiceMessageConsent = async () => {
  try {
    if (await AsyncStorage.getItem(CONSENT_KEY) === 'accepted') return true
  } catch {
    // The confirmation remains available even if local persistence is unavailable.
  }

  return new Promise<boolean>(resolve => {
    Alert.alert(
      'Voice messages',
      'Voice messages are uploaded to Chatterra so they can appear in this conversation. They are transcribed by Groq so your contact can reply; Convert to Text displays that same transcript.',
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
