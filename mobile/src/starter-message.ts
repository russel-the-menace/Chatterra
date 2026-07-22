import { Character } from './types'

const isCantonese = (language?: string) => (
  /cantonese|粤语|粵語|廣東話|广东话/iu.test(language || '')
)

export const starterMessageForCharacter = (character: Character) => {
  if (character.id === 'c3') {
    return "Hey, it's Maya. I just finished sorting out my notes for the day. Come keep me company for a minute?"
  }
  if (isCantonese(character.language)) {
    return `你好，我係${character.name || '我'}。你而家想傾咩？`
  }
  if (character.id === 'c2') {
    return 'Hi. I will help you practice English and point out useful mistakes when it helps, while keeping the conversation natural. Tell me about your current project.'
  }
  if (/mandarin|普通话|普通話|国语|國語/iu.test(character.language || '')) {
    return `你好，我是${character.name || '我'}。你现在想聊什么？`
  }
  if (/japanese|日本語|日语|日語/iu.test(character.language || '')) {
    return `こんにちは、${character.name || '私'}です。今日は何を話したい？`
  }
  return `Hello, I'm ${character.name || 'Interviewer'}. What would you like to talk about?`
}
