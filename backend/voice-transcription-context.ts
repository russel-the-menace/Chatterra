import { Character } from './types'

export type VoiceTranscriptionContext = {
  id: string
  prompt: string
}

const SOFIA_TRANSCRIPTION_CONTEXT: VoiceTranscriptionContext = {
  id: 'sofia-english-argentine-spanish',
  prompt: 'This is a bilingual English and Argentine Spanish chat. Preserve code-switching. Spanish terms may include hola, gracias, por favor, adios, como estas, que tal, and vos. Prefer the standard spelling "gracias" when that is what is spoken; do not replace it with "Galaxias".',
}

export const voiceTranscriptionContextForCharacter = (
  character?: Character
): VoiceTranscriptionContext | undefined => {
  if (character?.id === 'seed-sofia-argentina-spanish') return SOFIA_TRANSCRIPTION_CONTEXT
  return undefined
}
