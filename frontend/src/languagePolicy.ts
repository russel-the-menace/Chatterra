type CharacterLanguageInput = {
  id: string
  name: string
  language?: string
}

const isCantonese = (language?: string) => {
  const normalized = (language || '').toLowerCase()
  return /cantonese|粤语|粵語|廣東話|广东话/u.test(normalized)
}

export const starterMessageForCharacter = (character: CharacterLanguageInput) => {
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
