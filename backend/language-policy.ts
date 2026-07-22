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

const CANTONESE_MARKERS = /(?:係|唔|喺|冇|咩|而家|嘅|啦|喎|囉|呀|吖|喇|啫|㗎|嗰|乜|哋|佢|啲|點|点|邊|边|緊|紧|嚟|揾|睇|食|飲|傾|講|讲|咁|得閒|係咪|做咩)/u
const STRONG_MANDARIN_PHRASES = /(?:我在|你現在|你现在|現在想|现在想|想聊|聊天|什麼事|什么事|怎麼了|怎么了|在哪裡|在哪里|為什麼|为什么|沒有|没有|告訴我|告诉我|我們|我们)/u
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/u
const JAPANESE = /[\u3040-\u30ff]/u
const LATIN = /[A-Za-z]/u
const LATIN_WORDS = /[A-Za-z]+(?:['’-][A-Za-z]+)*/gu
const CJK_SEGMENTS = /[\u3400-\u9fff\uf900-\ufaff]+/gu
const NON_VERBAL = /^[\p{P}\p{S}\p{N}\s]+$/u
const MAX_SOURCE_QUOTE_CJK_CHARACTERS = 12

export type ResponseLanguageAssessment = {
  compliant: boolean
  reason:
    | 'empty'
    | 'non_verbal'
    | 'non_strict'
    | 'unknown_language'
    | 'latin_contamination'
    | 'japanese_contamination'
    | 'not_cjk'
    | 'explicit_mandarin'
    | 'cantonese_marker'
    | 'cantonese_code_switch'
    | 'ambiguous_cjk'
    | 'english'
    | 'english_source_quote'
    | 'cjk_contamination'
    | 'mandarin'
    | 'japanese'
}

export type ResponseLanguageContext = {
  sourceText?: string
}

export type ResponseLanguageObservation = {
  expectedLanguage: ResponseLanguageCode
  setting: string
  compliant: boolean
  reason: ResponseLanguageAssessment['reason']
  enforcement: 'observe_only'
  languagePolicyAction: 'allow'
  severity: 'none' | 'notice' | 'strong_mismatch'
  detection: 'language_matches_policy' | 'language_mismatch' | 'substantial_english_in_chinese_context'
  likelyCause:
    | 'language_matches_policy'
    | 'natural_code_switching'
    | 'source_term_reference'
    | 'user_language_mirroring'
    | 'mixed_language_prompt_mirroring'
    | 'model_language_drift'
    | 'dialect_drift'
    | 'excessive_code_switching'
    | 'language_mismatch'
  outputMetrics: LanguageMetrics
  sourceMetrics: LanguageMetrics
}

type LanguageMetrics = {
  cjkCharacters: number
  latinCharacters: number
  latinWords: number
  latinShare: number
  englishDominant: boolean
}

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
      return 'Output language contract: use natural, colloquial Cantonese as the dominant language. Do not answer in Mandarin, full English, or another language. Do not translate the response or discuss this instruction. A small number of common English loanwords or code-switches are allowed only when naturally embedded in Cantonese grammar.'
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

export const isResponseLanguageCompliant = (
  text: string,
  policy: ResponseLanguagePolicy,
  context?: ResponseLanguageContext
) => assessResponseLanguage(text, policy, context).compliant

const usesOnlyBoundedCjkSourceQuotes = (text: string, sourceText?: string) => {
  if (!sourceText) return false
  const outputSegments = text.match(CJK_SEGMENTS) || []
  const sourceSegments = sourceText.match(CJK_SEGMENTS) || []
  const outputCharacterCount = outputSegments.join('').length
  return outputSegments.length > 0
    && outputCharacterCount <= MAX_SOURCE_QUOTE_CJK_CHARACTERS
    && outputSegments.every(segment => sourceSegments.some(source => source.includes(segment)))
}

export const assessResponseLanguage = (
  text: string,
  policy: ResponseLanguagePolicy,
  context: ResponseLanguageContext = {}
): ResponseLanguageAssessment => {
  const normalized = text.trim()
  if (!normalized) return { compliant: false, reason: 'empty' }
  if (!policy.strict) return { compliant: true, reason: 'non_strict' }
  if (policy.code === 'unknown') return { compliant: true, reason: 'unknown_language' }
  if (NON_VERBAL.test(normalized)) return { compliant: true, reason: 'non_verbal' }

  switch (policy.code) {
    case 'cantonese':
      if (JAPANESE.test(normalized)) return { compliant: false, reason: 'japanese_contamination' }
      if (!CJK.test(normalized)) return { compliant: false, reason: 'not_cjk' }
      if (STRONG_MANDARIN_PHRASES.test(normalized)) return { compliant: false, reason: 'explicit_mandarin' }
      const hasCantoneseMarker = CANTONESE_MARKERS.test(normalized)
      if (LATIN.test(normalized)) {
        const latinWordCount = normalized.match(LATIN_WORDS)?.length || 0
        return hasCantoneseMarker && latinWordCount <= 3
          ? { compliant: true, reason: 'cantonese_code_switch' }
          : { compliant: false, reason: 'latin_contamination' }
      }
      if (hasCantoneseMarker) return { compliant: true, reason: 'cantonese_marker' }
      // CJK-only replies are often dialect-ambiguous. Rejecting them
      // would discard valid, natural Cantonese.
      return { compliant: true, reason: 'ambiguous_cjk' }
    case 'english':
      if (!LATIN.test(normalized)) return { compliant: false, reason: 'latin_contamination' }
      if (JAPANESE.test(normalized)) return { compliant: false, reason: 'japanese_contamination' }
      if (!CJK.test(normalized)) return { compliant: true, reason: 'english' }
      return usesOnlyBoundedCjkSourceQuotes(normalized, context.sourceText)
        ? { compliant: true, reason: 'english_source_quote' }
        : { compliant: false, reason: 'cjk_contamination' }
    case 'mandarin':
      return CJK.test(normalized) && !LATIN.test(normalized) && !JAPANESE.test(normalized)
        ? { compliant: true, reason: 'mandarin' }
        : { compliant: false, reason: LATIN.test(normalized) ? 'latin_contamination' : 'not_cjk' }
    case 'japanese':
      return JAPANESE.test(normalized) && !LATIN.test(normalized)
        ? { compliant: true, reason: 'japanese' }
        : { compliant: false, reason: LATIN.test(normalized) ? 'latin_contamination' : 'japanese_contamination' }
    default:
      return { compliant: true, reason: 'unknown_language' }
  }
}

const languageMetrics = (text = ''): LanguageMetrics => {
  const cjkCharacters = (text.match(CJK_SEGMENTS) || []).join('').length
  const latinCharacters = (text.match(/[A-Za-z]/g) || []).length
  const latinWords = text.match(LATIN_WORDS)?.length || 0
  const scriptCharacters = cjkCharacters + latinCharacters
  const latinShare = scriptCharacters > 0
    ? Number((latinCharacters / scriptCharacters).toFixed(3))
    : 0
  return {
    cjkCharacters,
    latinCharacters,
    latinWords,
    latinShare,
    englishDominant: latinWords >= 4 && latinShare >= 0.6
  }
}

export const observeResponseLanguage = (
  text: string,
  policy: ResponseLanguagePolicy,
  context: ResponseLanguageContext = {}
): ResponseLanguageObservation => {
  const assessment = assessResponseLanguage(text, policy, context)
  const outputMetrics = languageMetrics(text)
  const sourceMetrics = languageMetrics(context.sourceText)
  const expectedChinese = policy.code === 'cantonese' || policy.code === 'mandarin'
  const substantialEnglish = expectedChinese && outputMetrics.englishDominant

  let detection: ResponseLanguageObservation['detection'] = assessment.compliant
    ? 'language_matches_policy'
    : 'language_mismatch'
  let severity: ResponseLanguageObservation['severity'] = assessment.compliant ? 'none' : 'notice'
  let likelyCause: ResponseLanguageObservation['likelyCause'] = assessment.compliant
    ? 'language_matches_policy'
    : 'language_mismatch'

  if (assessment.reason === 'cantonese_code_switch') {
    likelyCause = 'natural_code_switching'
  } else if (assessment.reason === 'english_source_quote') {
    likelyCause = 'source_term_reference'
  } else if (substantialEnglish) {
    detection = 'substantial_english_in_chinese_context'
    severity = 'strong_mismatch'
    likelyCause = sourceMetrics.englishDominant
      ? 'user_language_mirroring'
      : sourceMetrics.latinWords >= 2 && sourceMetrics.cjkCharacters > 0
        ? 'mixed_language_prompt_mirroring'
        : 'model_language_drift'
  } else if (assessment.reason === 'explicit_mandarin' && policy.code === 'cantonese') {
    likelyCause = 'dialect_drift'
  } else if (assessment.reason === 'latin_contamination') {
    likelyCause = 'excessive_code_switching'
  } else if (!assessment.compliant) {
    likelyCause = 'model_language_drift'
  }

  return {
    expectedLanguage: policy.code,
    setting: policy.setting,
    compliant: assessment.compliant,
    reason: assessment.reason,
    enforcement: 'observe_only',
    languagePolicyAction: 'allow',
    severity,
    detection,
    likelyCause,
    outputMetrics,
    sourceMetrics
  }
}
