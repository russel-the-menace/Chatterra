import { DetectedLanguage } from './types'

const countMatches = (text: string, pattern: RegExp) => (text.match(pattern) || []).length
const CANTONESE_MARKERS = /(?:係|唔|喺|冇|咩|而家|嘅|啦|喎|囉|呀|吖|喇|啫|㗎|嗰|乜|哋|佢|啲|點|邊|緊|嚟|揾|睇|食|飲|傾|講|咁|得閒|係咪|做咩)/gu

export const detectTranscriptLanguage = (text: string): DetectedLanguage => {
  const normalized = text.trim()
  if (!normalized) return 'Unknown'

  const latin = countMatches(normalized, /[A-Za-z]/g)
  const han = countMatches(normalized, /[\u3400-\u9fff\uf900-\ufaff]/g)
  const kana = countMatches(normalized, /[\u3040-\u30ff]/g)
  const hangul = countMatches(normalized, /[\uac00-\ud7af]/g)
  const arabic = countMatches(normalized, /[\u0600-\u06ff]/g)
  const cyrillic = countMatches(normalized, /[\u0400-\u04ff]/g)
  const cantonese = countMatches(normalized, CANTONESE_MARKERS)

  if (kana > 0) return latin > 1 ? 'Mixed' : 'Japanese'
  if (hangul > 1) return latin > 1 ? 'Mixed' : 'Korean'
  if (arabic > 1) return latin > 1 ? 'Mixed' : 'Arabic'
  if (cyrillic > 1) return latin > 1 ? 'Mixed' : 'Russian'
  if (han > 1 && cantonese > 0) return latin > 1 ? 'Mixed' : 'Cantonese'
  if (han > 1) return latin > 1 ? 'Mixed' : 'Chinese'
  if (latin > 1) return 'English'
  return 'Unknown'
}

export const recognitionLanguageHint = (preferredLanguage?: string) => {
  const preferred = (preferredLanguage || '').toLowerCase()
  if (/cantonese|粤语|粵語|廣東話|广东话/u.test(preferred)) return 'zh-HK'
  if (/mandarin|普通话|普通話|国语|國語/u.test(preferred)) return 'zh-CN'
  if (/japanese|日本語|日语|日語/u.test(preferred)) return 'ja-JP'
  if (/korean|한국|韩语|韓語/u.test(preferred)) return 'ko-KR'
  if (/arabic|阿拉伯/u.test(preferred)) return 'ar-SA'
  if (/russian|俄语|俄語/u.test(preferred)) return 'ru-RU'
  if (/english|英语|英語/u.test(preferred)) return 'en-US'

  if (typeof navigator === 'undefined') return 'en-US'
  const language = navigator.language || 'en-US'
  if (/^zh/i.test(language)) return language.includes('-') ? language : 'zh-CN'
  if (/^ja/i.test(language)) return language.includes('-') ? language : 'ja-JP'
  if (/^ko/i.test(language)) return language.includes('-') ? language : 'ko-KR'
  if (/^ar/i.test(language)) return language.includes('-') ? language : 'ar-SA'
  if (/^ru/i.test(language)) return language.includes('-') ? language : 'ru-RU'
  return language
}
