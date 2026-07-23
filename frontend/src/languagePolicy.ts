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
  if (character.id === 'seed-arjun-client') {
    return "Let us get straight to it. Which DJI model are you offering, what lawful route gets the complete units into India, and what is your landed unit price at the proposed volume? I will not accept 'we handle customs' as an answer."
  }
  if (character.id === 'seed-minjun-friend') {
    return '안녕, 민준이야. 오늘 수업 어땠어? 난 선형대수 과제에 아직도 붙잡혀 있어.'
  }
  if (character.id === 'seed-ren-friend') {
    return 'やあ、蓮だよ。今日の授業どうだった？こっちは解析の課題にずっと捕まってた。'
  }
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

  if (/korean|한국어|韩语|韓語/iu.test(character.language || '')) {
    return `안녕하세요, ${character.name || '저'}입니다. 오늘은 무슨 이야기를 할까요?`
  }

  return `Hello, I'm ${character.name || 'Interviewer'}. What would you like to talk about?`
}
