export type ResponseLanguageCode =
  | 'cantonese'
  | 'english'
  | 'mandarin'
  | 'japanese'
  | 'unknown'

export type ResponseLanguagePolicy = {
  setting: string
  code: ResponseLanguageCode
  label: string
  locale: string
  strict: boolean
  instruction: string
}

const CANTONESE_MARKERS = /(?:係|唔|喺|冇|咩|而家|嘅|啦|喎|囉|呀|吖|喇|啫|㗎|嗰|乜|哋|佢|啲|點|邊|緊|嚟|揾|睇|食|飲|傾|講|咁|得閒|係咪|做咩)/u
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u
const JAPANESE = /[\u3040-\u30ff]/u
const LATIN = /[A-Za-z]/u
const NON_VERBAL = /^[\p{P}\p{S}\p{N}\s]+$/u

const isStrictSetting = (setting: string) => {
  if (/\b(?:only|exclusively|solely)\b|只|仅|只能|只讲|只用/iu.test(setting)) return true
  return !/(?:\band\b|\bor\b|和|或|、|,|，|\/|\+)/iu.test(setting)
}

const instructionFor = (code: ResponseLanguageCode, setting: string, strict: boolean) => {
  if (!strict) {
    return `Language preference: ${setting}. Follow this preference naturally and do not switch languages without a conversational reason.`
  }

  switch (code) {
    case 'cantonese':
      return 'Output language contract: respond exclusively in natural, colloquial Cantonese. Do not answer in English, Mandarin, or another language. Do not translate the response or discuss this instruction. English words are not allowed except when reproducing an unavoidable proper name or exact user quote.'
    case 'english':
      return 'Output language contract: respond exclusively in natural English. Do not answer in another language and do not translate the response.'
    case 'mandarin':
      return 'Output language contract: respond exclusively in natural Mandarin Chinese. Do not answer in Cantonese, English, or another language. Do not translate the response.'
    case 'japanese':
      return 'Output language contract: respond exclusively in natural Japanese. Do not answer in another language and do not translate the response.'
    default:
      return `Output language contract: respond exclusively in ${setting}. Do not answer in another language and do not translate the response.`
  }
}

export const resolveResponseLanguagePolicy = (language?: string): ResponseLanguagePolicy => {
  const setting = language?.trim() || 'English only'
  const normalized = setting.toLowerCase()
  const code: ResponseLanguageCode =
    /cantonese|粤语|粵語|廣東話|广东话/u.test(normalized)
      ? 'cantonese'
      : /mandarin|普通话|普通話|国语|國語/u.test(normalized)
        ? 'mandarin'
        : /japanese|日本語|日语|日語/u.test(normalized)
          ? 'japanese'
          : /english|英语|英語/u.test(normalized)
            ? 'english'
            : 'unknown'
  const strict = isStrictSetting(setting)
  const label = code === 'unknown'
    ? setting
    : code[0].toUpperCase() + code.slice(1)
  const locale = code === 'cantonese'
    ? 'yue'
    : code === 'mandarin'
      ? 'zh-CN'
      : code === 'japanese'
        ? 'ja-JP'
        : code === 'english'
          ? 'en-US'
          : 'und'

  return {
    setting,
    code,
    label,
    locale,
    strict,
    instruction: instructionFor(code, setting, strict)
  }
}

export const starterMessageForPolicy = (
  characterName: string,
  policy: ResponseLanguagePolicy
) => {
  switch (policy.code) {
    case 'cantonese':
      return `你好，我係${characterName}。你而家想傾咩？`
    case 'mandarin':
      return `你好，我是${characterName}。你现在想聊什么？`
    case 'japanese':
      return `こんにちは、${characterName}です。今日は何を話したい？`
    case 'english':
      return `Hello, I'm ${characterName}. What would you like to talk about?`
    default:
      return '👋'
  }
}

export const fallbackMessageForPolicy = (
  policy: ResponseLanguagePolicy,
  priority: 'conversation' | 'emotional_support' | 'language_help' = 'conversation',
  context: {
    incoming?: string
    recentAssistantReplies?: string[]
  } = {}
) => {
  const recent = new Set((context.recentAssistantReplies || []).map(reply => reply.trim()))

  if (priority === 'emotional_support') {
    switch (policy.code) {
      case 'cantonese':
        return [
          '唔好意思，我頭先冇好好聽你講。你想唔想同我講多啲？',
          '我喺度聽你講，你慢慢嚟，唔使急。'
        ].find(reply => !recent.has(reply)) || '唔好意思，我頭先冇好好聽你講。你想唔想同我講多啲？'
      case 'mandarin':
        return '对不起，我刚才没有好好听你说。你愿意再跟我说一点吗？'
      case 'japanese':
        return 'ごめん、ちゃんと話を聞けていなかった。もう少し話してくれる？'
      case 'english':
        return "I'm listening. Would you like to tell me more?"
      default:
        return '…'
    }
  }

  switch (policy.code) {
    case 'cantonese':
      if (priority === 'language_help') {
        return ['我可以幫你，你想講邊一部分？', '得呀，我哋逐句睇下。'].find(reply => !recent.has(reply)) || '我可以幫你，你想講邊一部分？'
      }
      const incoming = context.incoming || ''
      const contextual = /travel|旅行|旅遊/iu.test(incoming)
        ? '去旅行呀？去咗邊度玩？'
        : /挂住|掛住|想你|miss/iu.test(incoming)
          ? '我都掛住你啦，最近過成點？'
          : undefined
      const candidates = [
        contextual,
        '我喺度呀，你想講咩？',
        '我聽住㗎，你慢慢講。',
        '得閒呀，你繼續講。'
      ].filter((reply): reply is string => Boolean(reply))
      return candidates.find(reply => !recent.has(reply)) || candidates[0]
    case 'mandarin':
      return priority === 'language_help'
        ? '我可以帮你，你想先说哪一部分？'
        : '我在这里，你想聊什么？'
    case 'japanese':
      return priority === 'language_help'
        ? '手伝えるよ。どの部分から話したい？'
        : 'ここにいるよ。何を話したい？'
    case 'english':
      return priority === 'language_help'
        ? 'I can help. Which part would you like to talk about?'
        : 'I am here. What would you like to talk about?'
    default:
      return '…'
  }
}

export const isResponseLanguageCompliant = (
  text: string,
  policy: ResponseLanguagePolicy
) => {
  const normalized = text.trim()
  if (!normalized) return false
  if (!policy.strict || policy.code === 'unknown') return true
  if (NON_VERBAL.test(normalized)) return true

  switch (policy.code) {
    case 'cantonese':
      return CJK.test(normalized) && !LATIN.test(normalized) && CANTONESE_MARKERS.test(normalized)
    case 'english':
      return LATIN.test(normalized) && !CJK.test(normalized) && !JAPANESE.test(normalized)
    case 'mandarin':
      return CJK.test(normalized) && !LATIN.test(normalized) && !JAPANESE.test(normalized)
    case 'japanese':
      return JAPANESE.test(normalized) && !LATIN.test(normalized)
    default:
      return true
  }
}
